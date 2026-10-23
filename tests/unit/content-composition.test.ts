import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  selection: vi.fn(), page: vi.fn(), reading: vi.fn(), open: vi.fn(), disposeReading: vi.fn(),
  disposeSelection: vi.fn(), disposePage: vi.fn(), disposeStatus: vi.fn(),
  addListener: vi.fn(), removeListener: vi.fn(), closeSelection: vi.fn(),
}));
vi.mock('wxt/utils/define-content-script', () => ({ defineContentScript: (value: unknown) => value }));
vi.mock('wxt/browser', () => ({ browser: { runtime: { id: 'extension-test',
  onMessage: { addListener: mocks.addListener, removeListener: mocks.removeListener } } } }));
vi.mock('../../src/selection/mount', () => ({ mountSelectionTranslator: mocks.selection }));
vi.mock('../../src/page/mount', () => ({ mountPageTranslator: mocks.page }));
vi.mock('../../src/reading/mount', () => ({ createReadingMode: mocks.reading }));
vi.mock('../../src/platform/service-status', () => ({ TranslationServiceStatusClient: class { dispose = mocks.disposeStatus; } }));
import definition from '../../src/entrypoints/selection.content';

const entry = definition as unknown as { main(context: { onInvalidated(callback: () => void): void }): void };
let dom: JSDOM;
let invalidated: (() => void) | undefined;
let pageOptions: { onRead(seed: ReadonlyMap<string, string>): void; onReadingAction(action: () => void): void };
let portal: (element?: HTMLElement) => void;
let selectionHost: HTMLElement;
let hostWindow: { top: unknown };

beforeEach(() => {
  vi.clearAllMocks(); invalidated = undefined;
  dom = new JSDOM('<!doctype html><html><body><p>Local article</p></body></html>');
  hostWindow = { top: undefined }; hostWindow.top = hostWindow;
  vi.stubGlobal('window', hostWindow); vi.stubGlobal('document', dom.window.document);
  selectionHost = dom.window.document.createElement('near-translate');
  mocks.selection.mockImplementation(({ onHost }) => { onHost(selectionHost, mocks.closeSelection); return mocks.disposeSelection; });
  mocks.page.mockImplementation(options => { pageOptions = options; return mocks.disposePage; });
  mocks.reading.mockImplementation(options => { portal = options.onSelectionPortal; return { open: mocks.open, dispose: mocks.disposeReading }; });
});
afterEach(() => { invalidated?.(); dom.window.close(); vi.unstubAllGlobals(); });
const mount = () => entry.main({ onInvalidated(callback) { invalidated = callback; } });

describe('document UI composition', () => {
  it('does not initialize a reader on an idle page or when an unused page is disposed', () => {
    mount(); expect(mocks.page).toHaveBeenCalledOnce(); expect(mocks.reading).not.toHaveBeenCalled();
    invalidated!(); invalidated = undefined;
    expect(mocks.disposePage).toHaveBeenCalledOnce(); expect(mocks.disposeSelection).toHaveBeenCalledOnce();
    expect(mocks.disposeStatus).toHaveBeenCalledOnce(); expect(mocks.disposeReading).not.toHaveBeenCalled();
  });

  it('creates one reader on first explicit use and preserves the page translation seed', () => {
    mount(); const seed = new Map([['source', 'translation']]);
    pageOptions.onRead(seed); pageOptions.onRead(seed);
    expect(mocks.reading).toHaveBeenCalledOnce(); expect(mocks.open).toHaveBeenNthCalledWith(1, seed);
    const dialog = dom.window.document.createElement('dialog'); dom.window.document.body.append(dialog);
    portal(dialog); expect(dialog.contains(selectionHost)).toBe(true); expect(mocks.closeSelection).toHaveBeenCalledOnce();
    portal(); expect(selectionHost.parentElement).toBe(dom.window.document.documentElement);
    invalidated!(); invalidated = undefined; expect(mocks.disposeReading).toHaveBeenCalledOnce();
  });

  it('routes a trusted popup request and keyboard shortcut through the shared page action', async () => {
    mount(); const action = vi.fn(() => pageOptions.onRead(new Map())); pageOptions.onReadingAction(action);
    const receive = mocks.addListener.mock.calls[0]![0];
    expect(receive({ type: 'open-reading-mode' }, { id: 'another-extension' })).toBeUndefined();
    expect(mocks.reading).not.toHaveBeenCalled();
    await expect(receive({ type: 'open-reading-mode' }, { id: 'extension-test' })).resolves.toEqual({ ok: true });
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { altKey: true, shiftKey: true, code: 'KeyR', cancelable: true }));
    expect(action).toHaveBeenCalledTimes(2); expect(mocks.reading).toHaveBeenCalledOnce();
  });

  it('keeps iframe selection available without installing page or reading controllers', () => {
    hostWindow.top = {}; mount();
    expect(mocks.selection).toHaveBeenCalledOnce(); expect(mocks.page).not.toHaveBeenCalled();
    const receive = mocks.addListener.mock.calls[0]![0];
    expect(receive({ type: 'open-reading-mode' }, { id: 'extension-test' })).toBeUndefined();
    expect(mocks.reading).not.toHaveBeenCalled();
  });
});
