import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDocument: vi.fn(), contains: vi.fn(), request: vi.fn(), fetch: vi.fn(),
}));
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {}, AnnotationMode: { ENABLE: 1 }, AnnotationEditorType: { DISABLE: -1 },
  PasswordResponses: { NEED_PASSWORD: 1, INCORRECT_PASSWORD: 2 }, getDocument: mocks.getDocument,
}));
vi.mock('wxt/browser', () => ({ browser: { permissions: { contains: mocks.contains, request: mocks.request } } }));
vi.mock('pdfjs-dist/web/pdf_viewer.mjs', () => {
  class EventBus {
    private listeners = new Map<string, Set<(event: unknown) => void>>();
    on(name: string, callback: (event: unknown) => void) {
      if (!this.listeners.has(name)) this.listeners.set(name, new Set());
      this.listeners.get(name)!.add(callback);
    }
    off(name: string, callback: (event: unknown) => void) { this.listeners.get(name)?.delete(callback); }
    dispatch(name: string, data: unknown) { this.listeners.get(name)?.forEach((callback) => callback(data)); }
  }
  class PDFViewer {
    pdfDocument: unknown = null;
    currentScaleValue = 'page-width';
    currentPageNumber = 1;
    constructor(private options: { eventBus: EventBus }) {}
    setDocument(document: unknown) {
      this.pdfDocument = document;
      if (document) queueMicrotask(() => this.options.eventBus.dispatch('pagesinit', {}));
    }
  }
  class PDFLinkService { setViewer() {} setDocument() {} }
  return { EventBus, PDFViewer, PDFLinkService, PDFFindController: class {}, LinkTarget: { BLANK: 2 } };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const documentFixture = (withText = true) => ({
  numPages: 2,
  getPage: vi.fn().mockResolvedValue({ getTextContent: vi.fn().mockResolvedValue({ items: withText ? [{ str: 'English text' }] : [] }) }),
});
function pendingTask() {
  const pending = deferred<ReturnType<typeof documentFixture>>();
  const task = {
    promise: pending.promise,
    destroy: vi.fn(async () => { pending.reject(new Error('destroyed')); }),
    onPassword: undefined as undefined | ((callback: (password: string) => void, reason: number) => void),
  };
  return { task, ...pending };
}

describe('PDF loading lifecycle', () => {
  let PdfReaderController: typeof import('../../src/pdf/controller')['PdfReaderController'];
  let controller: import('../../src/pdf/controller').PdfReaderController;
  let states: import('../../src/pdf/controller').ReaderState[];
  let sessionStarted = vi.fn<() => void>();

  beforeAll(async () => {
    vi.stubGlobal('window', { location: { href: 'chrome-extension://test/reader.html' }, setTimeout, clearTimeout });
    ({ PdfReaderController } = await import('../../src/pdf/controller'));
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.contains.mockResolvedValue(true);
    mocks.request.mockResolvedValue(true);
    vi.stubGlobal('fetch', mocks.fetch);
    states = [];
    sessionStarted = vi.fn<() => void>();
    controller = await PdfReaderController.create({} as HTMLDivElement, {} as HTMLDivElement, (state) => states.push(state), sessionStarted);
  });
  afterEach(async () => { await controller.destroy(); });

  it('ignores delayed local file reads after another document replaces the session', async () => {
    const firstRead = deferred<ArrayBuffer>();
    const current = pendingTask();
    mocks.getDocument.mockReturnValue(current.task);
    const firstLoad = controller.openLocal({ name: 'first.pdf', arrayBuffer: () => firstRead.promise } as File);
    await Promise.resolve();
    const secondLoad = controller.openLocal({ name: 'second.pdf', arrayBuffer: async () => new Uint8Array([2]).buffer } as File);
    await vi.waitFor(() => expect(mocks.getDocument).toHaveBeenCalledTimes(1));
    current.resolve(documentFixture());
    await secondLoad;
    firstRead.resolve(new Uint8Array([1]).buffer);
    await firstLoad;
    expect(mocks.getDocument).toHaveBeenCalledTimes(1);
    expect(states.at(-1)).toMatchObject({ filename: 'second.pdf', pages: 2, loading: false });
    expect(sessionStarted).toHaveBeenCalledTimes(2);
  });

  it('requests no permissions automatically and offers a user action when access is missing', async () => {
    mocks.contains.mockResolvedValue(false);
    await controller.openRemote('https://papers.example.com/report.pdf', false);
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(states.at(-1)).toMatchObject({ needsPermission: true, loading: false });
  });

  it('fetches bytes only after the user grants the requested origin', async () => {
    mocks.contains.mockResolvedValue(false);
    mocks.fetch.mockResolvedValue({ ok: true, arrayBuffer: async () => new Uint8Array([3]).buffer });
    const load = pendingTask();
    mocks.getDocument.mockReturnValue(load.task);
    const open = controller.openRemote('https://papers.example.com/report.pdf', true);
    await vi.waitFor(() => expect(mocks.getDocument).toHaveBeenCalled());
    load.resolve(documentFixture());
    await open;
    expect(mocks.request).toHaveBeenCalledWith({ origins: ['https://papers.example.com/*'] });
    expect(mocks.fetch.mock.calls[0]?.[0]).toBe('https://papers.example.com/report.pdf');
    expect(mocks.getDocument.mock.calls[0]?.[0]).toMatchObject({ data: new Uint8Array([3]), enableXfa: false });
  });

  it('asks for permission before awaiting the destruction of the previous PDF', async () => {
    const current = pendingTask();
    mocks.getDocument.mockReturnValue(current.task);
    const first = controller.openLocal({ name: 'large.pdf', arrayBuffer: async () => new ArrayBuffer(1) } as File);
    await vi.waitFor(() => expect(mocks.getDocument).toHaveBeenCalled());
    current.resolve(documentFixture());
    await first;
    const destruction = deferred<void>();
    current.task.destroy.mockImplementation(() => destruction.promise);
    mocks.request.mockResolvedValue(false);
    const next = controller.openRemote('https://papers.example.com/report.pdf', true);
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).not.toHaveBeenCalled();
    destruction.resolve();
    await next;
    expect(states.at(-1)?.needsPermission).toBe(true);
  });

  it('cancels a pending password task and ignores its later rejection', async () => {
    const load = pendingTask();
    mocks.getDocument.mockReturnValue(load.task);
    const open = controller.openLocal({ name: 'locked.pdf', arrayBuffer: async () => new ArrayBuffer(1) } as File);
    await vi.waitFor(() => expect(load.task.onPassword).toBeTypeOf('function'));
    const unlock = vi.fn();
    load.task.onPassword!(unlock, 2);
    expect(states.at(-1)?.password).toBe('incorrect');
    await controller.cancel();
    await open;
    controller.submitPassword('stale-password');
    expect(unlock).not.toHaveBeenCalled();
    expect(load.task.destroy).toHaveBeenCalledTimes(1);
    expect(states.at(-1)).toMatchObject({ filename: '', loading: false, error: '', password: null });
  });

  it('reports a no-text current page and releases the document on unmount', async () => {
    const load = pendingTask();
    mocks.getDocument.mockReturnValue(load.task);
    const open = controller.openLocal({ name: 'scan.pdf', arrayBuffer: async () => new ArrayBuffer(1) } as File);
    await vi.waitFor(() => expect(mocks.getDocument).toHaveBeenCalled());
    load.resolve(documentFixture(false));
    await open;
    await vi.waitFor(() => expect(states.at(-1)?.noText).toBe(true));
    await controller.destroy();
    await controller.destroy();
    expect(load.task.destroy).toHaveBeenCalledTimes(1);
  });

  it('provides the local-download recovery path for a remote server failure', async () => {
    mocks.fetch.mockResolvedValue({ ok: false, status: 403 });
    await controller.openRemote('https://papers.example.com/report.pdf', false);
    expect(states.at(-1)).toMatchObject({ loading: false });
    expect(states.at(-1)?.error).toContain('HTTP 403');
    expect(states.at(-1)?.error).toContain('下载 PDF');
  });
});
