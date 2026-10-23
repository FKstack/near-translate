import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReadingViewProps } from '../../src/reading/ReadingView';
import type { ReadingArticle } from '../../src/reading/types';
import { DEFAULT_READING_PREFERENCES, normalizeReadingPreferences, readingStyle, type ReadingPreferences } from '../../src/shared/reading';

const fixtures = vi.hoisted(() => ({
  render: vi.fn(), unmount: vi.fn(), sendMessage: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(),
  extract: vi.fn(), start: vi.fn(), stop: vi.fn(), disposeTranslation: vi.fn(),
}));
vi.mock('react-dom/client', () => ({ createRoot: () => ({ render: fixtures.render, unmount: fixtures.unmount }) }));
vi.mock('wxt/browser', () => ({ browser: { runtime: { sendMessage: fixtures.sendMessage,
  onMessage: { addListener: fixtures.addListener, removeListener: fixtures.removeListener } } } }));
vi.mock('../../src/reading/extract', () => ({ extractReadingArticle: fixtures.extract }));
vi.mock('../../src/reading/translation', () => ({ ReadingTranslation: class {
  state = { status: 'idle', total: 2, completed: 0, failed: 0, pending: 2 };
  snapshot = new Map(); start = fixtures.start; stop = fixtures.stop;
  dispose = fixtures.disposeTranslation; retry() {} refreshViewport() {}
} }));
import { createReadingMode, type ReadingModeController } from '../../src/reading/mount';

let dom: JSDOM;
let controller: ReadingModeController | undefined;
let article: ReadingArticle;
let scroll: HTMLDivElement;
let block: HTMLElement;
let blockHeight: number;
let blockStart: number;
let viewportTop: number;
const flush = async () => { for (let index = 0; index < 6; index++) await Promise.resolve(); };
const view = () => fixtures.render.mock.calls.at(-1)![0].props as ReadingViewProps;
const saves = () => fixtures.sendMessage.mock.calls.map(([message]) => message as { type: string; preferences?: ReadingPreferences })
  .filter(message => message.type === 'save-reading-preferences');
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, failed) => { resolve = done; reject = failed; });
  return { promise, resolve, reject };
}
const rect = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 600, width: 600, x: 0, y: top,
  toJSON() { return {}; } }) as DOMRect;

async function open(preferences: Partial<ReadingPreferences> = {}) {
  const initial = normalizeReadingPreferences({ ...DEFAULT_READING_PREFERENCES, ...preferences });
  fixtures.sendMessage.mockImplementation(async (message: { type: string }) => {
    if (message.type === 'get-reading-preferences') return { ok: true, preferences: initial };
    if (message.type === 'get-settings') return { enabled: true, webAccess: true, translationEngine: 'model', requiresApiKey: true,
      hasApiKey: true, apiAccess: true, model: '', includeContext: true, sentenceAnalysisEnabled: false, connectionRevision: 1 };
    return { ok: true };
  });
  controller = createReadingMode(); await flush(); controller.open();
  const dialog = dom.window.document.querySelector('near-reading-mode')!.shadowRoot!.querySelector('dialog')!;
  scroll = dom.window.document.createElement('div');
  const mount = dom.window.document.createElement('div'); scroll.append(mount); dialog.append(scroll);
  Object.defineProperties(scroll, { clientHeight: { configurable: true, value: 600 }, scrollHeight: { configurable: true, get: () => 3000 + blockHeight } });
  scroll.getBoundingClientRect = () => rect(viewportTop, 600);
  scroll.scrollTo = vi.fn((options: ScrollToOptions | number = {}, y?: number) => {
    scroll.scrollTop = typeof options === 'number' ? y ?? scroll.scrollTop : options.top ?? scroll.scrollTop;
  });
  view().scrollRef!(scroll); view().articleRef(mount);
  block.getBoundingClientRect = () => rect(viewportTop + blockStart - scroll.scrollTop, blockHeight);
  view().onLayoutCommit?.(); await vi.advanceTimersByTimeAsync(16);
}

function change(patch: Partial<ReadingPreferences>) {
  view().onPreferences({ ...view().preferences, ...patch });
}

beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers();
  dom = new JSDOM('<!doctype html><html><head></head><body><article><p id="source">A paragraph owned by the original page.</p></article></body></html>',
    { url: 'https://example.test/article' });
  const win = dom.window;
  vi.stubGlobal('window', win); vi.stubGlobal('document', win.document); vi.stubGlobal('location', win.location);
  vi.stubGlobal('HTMLElement', win.HTMLElement); vi.stubGlobal('Element', win.Element);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 16));
  vi.stubGlobal('cancelAnimationFrame', (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle));
  win.matchMedia = vi.fn().mockReturnValue({ matches: true }); win.scrollTo = vi.fn();
  win.HTMLElement.prototype.scrollIntoView = vi.fn();
  win.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  win.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const content = win.document.createElement('article');
  block = win.document.createElement('p'); block.dataset.nearReaderSource = 'source-1';
  block.textContent = 'The paragraph being read can contain many lines and should remain in view.';
  content.append(block); blockHeight = 300; blockStart = 400; viewportTop = 0;
  article = { title: 'Reader controller', byline: '', siteName: '', sourceUrl: win.location.href, lang: 'en', excerpt: '',
    wordCount: 200, readingMinutes: 1, content, outline: [], strategy: 'readability', truncated: false,
    sourceMap: new Map([['source-1', win.document.getElementById('source')!]]) };
  fixtures.extract.mockReturnValue(article);
});

afterEach(() => {
  controller?.dispose(); controller = undefined;
  dom.window.close(); vi.useRealTimers(); vi.unstubAllGlobals();
});

describe('document-owned reading customization', () => {
  it('previews immediately and coalesces a continuous adjustment into one final save and undo', async () => {
    await open();
    const commit = view().onLayoutCommit;
    change({ fontSize: 21 }); await vi.advanceTimersByTimeAsync(100);
    change({ fontSize: 22 }); await vi.advanceTimersByTimeAsync(100);
    change({ fontSize: 24 });
    expect(view().preferences.fontSize).toBe(24); expect(view().preferencesStatus).toBe('saving');
    expect(view().onLayoutCommit).toBe(commit); expect(saves()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(179); expect(saves()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(saves()).toHaveLength(1); expect(saves()[0]!.preferences!.fontSize).toBe(24);
    expect(view().preferencesStatus).toBe('saved');
    view().onUndoPreferences!(); expect(view().preferences.fontSize).toBe(20);
    expect(fixtures.start).not.toHaveBeenCalled();
  });

  it('reports a rejected save result accurately and retries the current style', async () => {
    await open();
    fixtures.sendMessage.mockResolvedValueOnce({ ok: false });
    change({ theme: 'dark' }); await vi.advanceTimersByTimeAsync(180);
    expect(view().preferencesStatus).toBe('error'); expect(view().preferences.theme).toBe('dark');
    const retry = deferred<{ ok: boolean }>(); fixtures.sendMessage.mockReturnValueOnce(retry.promise);
    view().onRetryPreferences!(); expect(view().preferencesStatus).toBe('saving');
    expect(saves()).toHaveLength(2); expect(saves()[1]!.preferences!.theme).toBe('dark');
    retry.resolve({ ok: true }); await flush(); expect(view().preferencesStatus).toBe('saved');
  });

  it('starts a new undo step when the reader adjusts again immediately after undo', async () => {
    await open();
    change({ fontSize: 24 }); view().onUndoPreferences!();
    change({ fontSize: 22 }); view().onUndoPreferences!();
    expect(view().preferences.fontSize).toBe(20);
    expect(fixtures.start).not.toHaveBeenCalled();
  });

  it.each(['false result', 'transport failure'] as const)('ignores an older %s after a newer successful adjustment', async failure => {
    await open();
    const first = deferred<{ ok: boolean }>(); fixtures.sendMessage.mockReturnValueOnce(first.promise);
    change({ theme: 'dark' }); await vi.advanceTimersByTimeAsync(180);
    change({ fontSize: 26 }); await vi.advanceTimersByTimeAsync(180);
    expect(view().preferencesStatus).toBe('saved');
    if (failure === 'false result') first.resolve({ ok: false }); else first.reject(new Error('connection closed'));
    await flush(); expect(view().preferencesStatus).toBe('saved'); expect(view().preferences.fontSize).toBe(26);
  });

  it('does not let an older successful save hide a pending newer adjustment', async () => {
    await open();
    const first = deferred<{ ok: boolean }>(); fixtures.sendMessage.mockReturnValueOnce(first.promise);
    change({ theme: 'dark' }); await vi.advanceTimersByTimeAsync(180);
    change({ fontSize: 26 }); first.resolve({ ok: true }); await flush();
    expect(view().preferencesStatus).toBe('saving');
    await vi.advanceTimersByTimeAsync(180); expect(view().preferencesStatus).toBe('saved');
  });

  it.each(['close', 'pagehide', 'dispose'] as const)('flushes the final pending snapshot on %s without waiting or duplicating it', async exit => {
    await open();
    const saving = deferred<{ ok: boolean }>(); fixtures.sendMessage.mockReturnValueOnce(saving.promise);
    change({ fontSize: 25 });
    if (exit === 'close') controller!.close();
    else if (exit === 'pagehide') dom.window.dispatchEvent(new dom.window.Event('pagehide'));
    else { controller!.dispose(); controller = undefined; }
    expect(saves()).toHaveLength(1); expect(saves()[0]!.preferences!.fontSize).toBe(25);
    expect(dom.window.document.querySelector('near-reading-mode')).toBeNull();
    const renders = fixtures.render.mock.calls.length;
    saving.resolve({ ok: true }); await flush(); await vi.advanceTimersByTimeAsync(200);
    expect(saves()).toHaveLength(1); expect(fixtures.render).toHaveBeenCalledTimes(renders);
  });

  it('keeps a reading point inside a long paragraph after a style commit, undo and resize', async () => {
    await open(); scroll.scrollTop = 400;
    scroll.dispatchEvent(new dom.window.Event('scroll')); await vi.advanceTimersByTimeAsync(16);
    // At 150px the reader is halfway through this 300px paragraph.
    change({ fontSize: 30 }); blockHeight = 600; blockStart = 700;
    expect(scroll.scrollTop).toBe(400);
    view().onLayoutCommit!(); expect(scroll.scrollTop).toBe(850);
    expect(scroll.scrollTo).toHaveBeenLastCalledWith({ top: 850, behavior: 'instant' });
    view().onUndoPreferences!(); blockHeight = 300; blockStart = 400;
    view().onLayoutCommit!(); expect(scroll.scrollTop).toBe(400);
    blockHeight = 500; blockStart = 600;
    dom.window.dispatchEvent(new dom.window.Event('resize'));
    expect(scroll.scrollTop).toBe(700);
    expect(fixtures.start).not.toHaveBeenCalled();
  });

  it('keeps the reading point at the same screen position when the header grows', async () => {
    await open(); scroll.scrollTop = 400;
    scroll.dispatchEvent(new dom.window.Event('scroll')); await vi.advanceTimersByTimeAsync(16);
    const readingPoint = block.getBoundingClientRect().top + blockHeight / 2;
    viewportTop = 64;
    view().onLayoutCommit!();
    expect(block.getBoundingClientRect().top + blockHeight / 2).toBe(readingPoint);
    expect(scroll.scrollTop).toBe(464);
  });

  it('keeps the current source block top when language changes clear translations and grow the header', async () => {
    await open(); viewportTop = 65; blockHeight = 600; scroll.scrollTop = 400;
    scroll.dispatchEvent(new dom.window.Event('scroll')); await vi.advanceTimersByTimeAsync(16);
    const sourceTop = block.getBoundingClientRect().top;
    fixtures.disposeTranslation.mockImplementationOnce(() => { blockHeight = 300; blockStart = 250; viewportTop = 128; });
    const settingsChanged = fixtures.addListener.mock.calls[0]![0] as (message: unknown) => void;
    settingsChanged({ type: 'settings-changed', settings: { enabled: true, webAccess: true, translationEngine: 'model',
      requiresApiKey: true, hasApiKey: true, apiAccess: true, model: '', includeContext: true, sentenceAnalysisEnabled: false,
      connectionRevision: 2, sourceLanguage: 'auto', targetLanguage: 'ja' } });
    expect(fixtures.disposeTranslation).toHaveBeenCalledOnce();
    view().onLayoutCommit!();
    expect(block.getBoundingClientRect().top).toBe(sourceTop);
    expect(scroll.scrollTop).toBe(313);
    expect(view().notice).toContain('阅读位置已保留');
    expect(fixtures.start).not.toHaveBeenCalled();
  });

  it('restores and toggles personal-style changes while keeping the current translation mode', async () => {
    const personal = readingStyle(normalizeReadingPreferences({ theme: 'dark', fontSize: 24 }));
    await open({ mode: 'bilingual', savedStyle: personal, theme: 'paper' });
    change({ savedStyle: readingStyle(view().preferences) });
    change({ mode: 'translation' });
    view().onUndoPreferences!();
    expect(view().preferences.savedStyle).toEqual(personal); expect(view().preferences.mode).toBe('translation');
    view().onUndoPreferences!(); expect(view().preferences.savedStyle!.theme).toBe('paper');
    change({ fontSize: 28, theme: 'dark' }); view().onResetPreferences!();
    expect(readingStyle(view().preferences)).toEqual(readingStyle(DEFAULT_READING_PREFERENCES));
    expect(view().preferences.mode).toBe('translation'); expect(view().preferences.savedStyle!.theme).toBe('paper');
    view().onUndoPreferences!(); expect(view().preferences.fontSize).toBe(28); expect(view().preferences.theme).toBe('dark');
    expect(fixtures.start).not.toHaveBeenCalled();
  });

  it('invalidates a queued layout commit when its surface is closed', async () => {
    await open(); scroll.scrollTop = 400;
    change({ fontSize: 30 }); const commit = view().onLayoutCommit!;
    controller!.close(); blockHeight = 900; blockStart = 1000;
    commit(); expect(scroll.scrollTop).toBe(400);
  });

  it('keeps an intentional chapter jump when closing its drawer commits layout', async () => {
    await open(); scroll.scrollTop = 400;
    scroll.dispatchEvent(new dom.window.Event('scroll')); await vi.advanceTimersByTimeAsync(16);
    const heading = dom.window.document.createElement('h2'); heading.id = 'chapter-later';
    heading.textContent = 'A later chapter'; article.content.append(heading);
    article.outline.push({ id: heading.id, text: heading.textContent, level: 2 });
    heading.scrollIntoView = vi.fn(() => { scroll.scrollTop = 1500; });
    view().onHeading(heading.id);
    expect(heading.scrollIntoView).toHaveBeenCalled();
    view().onLayoutCommit!();
    expect(scroll.scrollTop).toBe(1500);
  });
});
