import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import type { EventBus, PDFLinkService, PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs';
import { browser } from 'wxt/browser';
import { parseRemotePdfSource, pdfErrorMessage } from './source';

export interface ReaderState {
  filename: string;
  loading: boolean;
  progress: number | null;
  page: number;
  pages: number;
  scale: string;
  error: string;
  needsPermission: boolean;
  noText: boolean;
  password: 'required' | 'incorrect' | null;
  searchState: 'idle' | 'searching' | 'found' | 'not-found';
  matches: { current: number; total: number };
}

export const INITIAL_READER_STATE: ReaderState = {
  filename: '', loading: false, progress: null, page: 1, pages: 0, scale: 'page-width',
  error: '', needsPermission: false, noText: false, password: null,
  searchState: 'idle', matches: { current: 0, total: 0 },
};

const assetUrl = (path: string) => new URL(`/pdfjs/${path}`, window.location.href).href;
pdfjs.GlobalWorkerOptions.workerSrc = assetUrl('pdf.worker.mjs');

/** Owns each PDF loading session and PDF.js DOM; React only supplies controls. */
export class PdfReaderController {
  private state: ReaderState = { ...INITIAL_READER_STATE };
  private session = 0;
  private disposed = false;
  private loadingTask: PDFDocumentLoadingTask | null = null;
  private pdfDocument: PDFDocumentProxy | null = null;
  private fetchAbort: AbortController | null = null;
  private passwordCallback: ((password: string) => void) | null = null;
  private readonly viewerAbort: AbortController;
  private readonly listeners: Array<[string, (event: unknown) => void]> = [];
  private textCheck = 0;

  private constructor(
    private readonly viewer: PDFViewer,
    private readonly linkService: PDFLinkService,
    private readonly eventBus: EventBus,
    private readonly onState: (state: ReaderState) => void,
    viewerAbort: AbortController,
    private readonly onSessionStart: () => void,
  ) {
    this.viewerAbort = viewerAbort;
    this.listen('pagesinit', () => {
      if (this.disposed || !this.pdfDocument || this.viewer.pdfDocument !== this.pdfDocument) return;
      this.viewer.currentScaleValue = 'page-width';
      this.publish({ scale: 'page-width' });
      void this.checkPageText();
    });
    this.listen('pagechanging', (event) => {
      const page = (event as { pageNumber: number }).pageNumber;
      this.publish({ page });
      void this.checkPageText();
    });
    this.listen('scalechanging', (event) => {
      const scale = (event as { scale: number; presetValue?: string }).presetValue
        || String((event as { scale: number }).scale);
      this.publish({ scale });
    });
    this.listen('updatefindmatchescount', (event) => {
      this.publish({ matches: (event as { matchesCount: ReaderState['matches'] }).matchesCount });
    });
    this.listen('updatefindcontrolstate', (event) => {
      const state = (event as { state: number }).state;
      this.publish({ searchState: state === 3 ? 'searching' : state === 1 ? 'not-found' : 'found' });
    });
    this.listen('pagerendered', (event) => {
      const error = (event as { error?: unknown }).error;
      if (error) this.publish({ error: pdfErrorMessage(error, false) });
    });
    this.onState(this.state);
  }

  static async create(container: HTMLDivElement, viewerElement: HTMLDivElement, onState: (state: ReaderState) => void, onSessionStart = () => {}) {
    // The component distribution reads globalThis.pdfjsLib supplied by the core.
    const { EventBus, PDFLinkService, PDFFindController, PDFViewer, LinkTarget } =
      await import('pdfjs-dist/web/pdf_viewer.mjs');
    const eventBus = new EventBus();
    const linkService = new PDFLinkService({
      eventBus, externalLinkTarget: LinkTarget.BLANK, externalLinkRel: 'noopener noreferrer nofollow',
    });
    const findController = new PDFFindController({ eventBus, linkService });
    const viewerAbort = new AbortController();
    const options: ConstructorParameters<typeof PDFViewer>[0] & { abortSignal: AbortSignal } = {
      container, viewer: viewerElement, eventBus, linkService, findController,
      annotationMode: pdfjs.AnnotationMode.ENABLE,
      annotationEditorMode: pdfjs.AnnotationEditorType.DISABLE,
      imageResourcesPath: assetUrl('images/'),
      enableAutoLinking: false,
      abortSignal: viewerAbort.signal,
    };
    const viewer = new PDFViewer(options);
    linkService.setViewer(viewer);
    return new PdfReaderController(viewer, linkService, eventBus, onState, viewerAbort, onSessionStart);
  }

  private listen(name: string, callback: (event: unknown) => void) {
    this.eventBus.on(name, callback);
    this.listeners.push([name, callback]);
  }

  private publish(patch: Partial<ReaderState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    this.onState(this.state);
  }

  /** Invalidate before destroying, so delayed file/password callbacks are harmless. */
  private async newSession(filename: string) {
    const session = ++this.session;
    this.onSessionStart();
    this.fetchAbort?.abort();
    this.fetchAbort = null;
    this.passwordCallback = null;
    const previous = this.loadingTask;
    this.loadingTask = null;
    this.pdfDocument = null;
    this.viewer.setDocument(null);
    this.linkService.setDocument(null);
    this.publish({ ...INITIAL_READER_STATE, filename, loading: true });
    if (previous) {
      try { await previous.destroy(); } catch { /* Replacement must remain available after failed loading. */ }
    }
    return session;
  }

  async openLocal(file: File) {
    const session = await this.newSession(file.name);
    try {
      const data = new Uint8Array(await file.arrayBuffer());
      if (session !== this.session || this.disposed) return;
      await this.loadBytes(data, session);
    } catch (error) {
      this.failed(error, session, false);
    }
  }

  async openRemote(value: string, requestPermission: boolean) {
    let source;
    try { source = parseRemotePdfSource(value); } catch (error) {
      this.publish({ error: error instanceof Error ? error.message : 'PDF 地址无效。' });
      return;
    }
    const permission = { origins: [source.originPattern] };
    // Request within the click's user gesture, before destroying a previous PDF.
    // A granted origin resolves silently; initialization only checks permission.
    const permissionResult = (requestPermission
      ? browser.permissions.request(permission)
      : browser.permissions.contains(permission)
    ).then((granted) => ({ granted, error: null }), (error: unknown) => ({ granted: false, error }));
    const session = await this.newSession(source.filename);
    try {
      const { granted, error } = await permissionResult;
      if (session !== this.session || this.disposed) return;
      if (error) throw error;
      if (!granted) {
        this.publish({ loading: false, needsPermission: true,
          error: '打开在线 PDF 需要该网站的访问权限。点击“打开在线 PDF”授权，或下载后打开本地文件。' });
        return;
      }
      const abort = new AbortController();
      this.fetchAbort = abort;
      const timeout = window.setTimeout(() => abort.abort(new Error('下载超时')), 60_000);
      let data: Uint8Array;
      try {
        const response = await fetch(source.url, { signal: abort.signal, credentials: 'include' });
        if (!response.ok) throw new Error(`服务器返回 HTTP ${response.status}`);
        data = new Uint8Array(await response.arrayBuffer());
      } finally {
        window.clearTimeout(timeout);
        if (this.fetchAbort === abort) this.fetchAbort = null;
      }
      if (session !== this.session || this.disposed) return;
      await this.loadBytes(data, session, source.url);
    } catch (error) {
      this.failed(error, session, true);
    }
  }

  private async loadBytes(data: Uint8Array, session: number, sourceUrl?: string) {
    const task = pdfjs.getDocument({
      data, docBaseUrl: sourceUrl,
      cMapUrl: assetUrl('cmaps/'), cMapPacked: true,
      standardFontDataUrl: assetUrl('standard_fonts/'),
      wasmUrl: assetUrl('wasm/'), iccUrl: assetUrl('iccs/'),
      enableXfa: false,
    });
    this.loadingTask = task;
    task.onProgress = ({ loaded, total }: { loaded: number; total: number }) => {
      if (session === this.session) this.publish({ progress: total > 0 ? Math.min(100, Math.round(loaded / total * 100)) : null });
    };
    task.onPassword = (updatePassword: (password: string) => void, reason: number) => {
      if (session !== this.session || this.disposed) return;
      this.passwordCallback = updatePassword;
      this.publish({ password: reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD ? 'incorrect' : 'required' });
    };
    const document = await task.promise;
    if (session !== this.session || this.disposed) {
      await task.destroy();
      return;
    }
    this.pdfDocument = document;
    this.passwordCallback = null;
    this.linkService.setDocument(document);
    this.viewer.setDocument(document);
    this.publish({ loading: false, pages: document.numPages, page: 1, password: null, error: '' });
  }

  private failed(error: unknown, session: number, remote: boolean) {
    if (session !== this.session || this.disposed) return;
    this.passwordCallback = null;
    this.publish({ loading: false, password: null, error: pdfErrorMessage(error, remote) });
    const failedTask = this.loadingTask;
    this.loadingTask = null;
    void failedTask?.destroy().catch(() => {});
  }

  submitPassword(password: string) {
    const callback = this.passwordCallback;
    if (!callback) return;
    this.passwordCallback = null;
    this.publish({ password: null });
    callback(password);
  }

  async cancel() {
    await this.newSession('');
    this.publish({ loading: false });
  }

  goToPage(page: number) {
    if (!this.pdfDocument || !Number.isFinite(page)) return;
    this.viewer.currentPageNumber = Math.max(1, Math.min(this.pdfDocument.numPages, Math.trunc(page)));
  }

  setScale(scale: string) {
    if (!this.pdfDocument) return;
    this.viewer.currentScaleValue = scale;
  }

  find(query: string, previous = false, again = false) {
    if (!this.pdfDocument) return;
    this.eventBus.dispatch('find', {
      source: this, type: again ? 'again' : '', query, phraseSearch: true,
      caseSensitive: false, entireWord: false, highlightAll: true, findPrevious: previous,
      matchDiacritics: false,
    });
    if (!query) this.publish({ searchState: 'idle', matches: { current: 0, total: 0 } });
  }

  private async checkPageText() {
    const document = this.pdfDocument;
    if (!document) return;
    const session = this.session;
    const pageNumber = this.viewer.currentPageNumber;
    const check = ++this.textCheck;
    try {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const noText = !content.items.some((item) => 'str' in item && item.str.trim().length > 0);
      if (session === this.session && check === this.textCheck) this.publish({ noText });
    } catch { /* The viewer reports parsing and rendering failures separately. */ }
  }

  async destroy() {
    if (this.disposed) return;
    this.disposed = true;
    ++this.session;
    this.fetchAbort?.abort();
    this.passwordCallback = null;
    for (const [name, callback] of this.listeners) this.eventBus.off(name, callback);
    this.viewer.setDocument(null);
    this.linkService.setDocument(null);
    this.viewerAbort.abort();
    try { await this.loadingTask?.destroy(); } catch { /* Best-effort final resource teardown. */ }
    this.loadingTask = null;
    this.pdfDocument = null;
  }
}
