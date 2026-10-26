import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageBarProps } from '../../src/page/Bar';
import type { PageSegment } from '../../src/page/segments';
import type { PublicSettings, TranslationInput, TranslationServerMessage } from '../../src/shared/contracts';
import type { PageViewportPriority } from '../../src/page/viewport';
import { pageExecutionPolicy, userscriptPageExecutionPolicy } from '../../src/shared/translation-policy';

const fixtures = vi.hoisted(() => ({
  render: vi.fn(), unmount: vi.fn(), update: vi.fn(), clear: vi.fn(), prune: vi.fn(),
  sendMessage: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), collect: vi.fn(), selectRoot: vi.fn(),
  clients: [] as Array<{ receive: (event: TranslationServerMessage) => void; input?: TranslationInput; id?: string }>,
  requests: [] as TranslationInput[],
  snapshot: vi.fn(), priorities: new Map<PageSegment, PageViewportPriority>(),
}));
vi.mock('react-dom/client', () => ({ createRoot: () => ({ render: fixtures.render, unmount: fixtures.unmount }) }));
vi.mock('wxt/browser', () => ({ browser: { runtime: { sendMessage: fixtures.sendMessage,
  onMessage: { addListener: fixtures.addListener, removeListener: fixtures.removeListener } } } }));
vi.mock('../../src/page/render', () => ({ PageTranslationRenderer: class {
  update = fixtures.update; clear = fixtures.clear; prune = fixtures.prune;
} }));
vi.mock('../../src/page/segments', () => ({ MAX_PAGE_SEGMENTS: 1_500, collectPageSegments: fixtures.collect,
  selectPageTranslationRoot: fixtures.selectRoot, segmentIsCurrent: () => true }));
vi.mock('../../src/page/viewport', () => ({ snapshotViewportPriorities: fixtures.snapshot }));
vi.mock('../../src/platform/translation-client', () => ({ TranslationClient: class {
  private readonly entry;
  constructor(receive: (event: TranslationServerMessage) => void) {
    this.entry = { receive } as typeof fixtures.clients[number]; fixtures.clients.push(this.entry);
  }
  start(input: TranslationInput) {
    this.entry.input = input; this.entry.id = `request-${fixtures.requests.push(input)}`; return this.entry.id;
  }
  cancel() { /* The page generation rejects late callbacks independently of the transport. */ }
  dispose() { /* No external resource is opened by this fixture. */ }
} }));
import { mountPageTranslator } from '../../src/page/mount';

class ElementFixture {
  style = { cssText: '' };
  parentElement: ElementFixture | null = null;
  children: ElementFixture[] = [];
  constructor(readonly tagName = 'div') {}
  textContent = '';
  setAttribute() { /* Host attributes are unrelated to these lifecycle assertions. */ }
  hasAttribute() { return false; }
  append(...nodes: ElementFixture[]) { for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node); } }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this); this.parentElement = null; }
  closest() { return null; }
  contains(node: unknown): boolean { return node === this || this.children.some(child => child.contains(node)); }
  matches(selector: string) { return selector.split(',').includes(this.tagName); }
  querySelector(selector: string): ElementFixture | null {
    for (const child of this.children) { if (child.matches(selector)) return child; const found = child.querySelector(selector); if (found) return found; }
    return null;
  }
  attachShadow() { return { append() {} }; }
}
let dispose: (() => void) | undefined;
let mutation: (records: unknown[]) => void;
let pageWindow: EventTarget;
let pageDocument: EventTarget;
let pageBody: ElementFixture;
let locationValue: { href: string };
let selectedRoot: ElementFixture;
let passages: PageSegment[];
let settings: PublicSettings;
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
const bar = () => fixtures.render.mock.calls.at(-1)![0].props as PageBarProps;
const notifySettings = (value: PublicSettings) => fixtures.addListener.mock.calls[0]![0]({ type: 'settings-changed', settings: value });
function complete(requestNumber = fixtures.requests.length) {
  const client = fixtures.clients.find(entry => entry.id === `request-${requestNumber}`)!;
  client.receive({ type: 'result', requestId: client.id!, result: { kind: 'text', translation: '译文',
    segments: client.input!.pageSegments!.map(() => '译文') } });
}
function segment(text: string, root: ElementFixture): PageSegment {
  return { text, nodes: [{} as Text], anchor: {} as Node, container: root as unknown as HTMLElement };
}

beforeEach(() => {
  vi.clearAllMocks(); fixtures.clients.length = 0; fixtures.requests.length = 0;
  fixtures.priorities.clear(); fixtures.snapshot.mockImplementation(() => new Map(fixtures.priorities));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  selectedRoot = new ElementFixture('article'); passages = [segment('Article paragraph', selectedRoot)];
  fixtures.selectRoot.mockImplementation(() => selectedRoot);
  fixtures.collect.mockImplementation(() => passages);
  pageWindow = new EventTarget(); locationValue = { href: 'https://example.test/article' };
  vi.stubGlobal('window', pageWindow); vi.stubGlobal('location', locationValue); vi.stubGlobal('Element', ElementFixture);
  pageBody = new ElementFixture('body'); pageBody.append(selectedRoot);
  pageDocument = Object.assign(new EventTarget(), { body: pageBody, documentElement: new ElementFixture(), createElement: () => new ElementFixture() });
  vi.stubGlobal('document', pageDocument);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 16));
  vi.stubGlobal('cancelAnimationFrame', (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle));
  vi.stubGlobal('MutationObserver', class {
    constructor(callback: typeof mutation) { mutation = callback; }
    observe() {} disconnect() {}
  });
  settings = { enabled: true, webAccess: true, translationEngine: 'deepl-web', requiresApiKey: false,
    hasApiKey: false, apiAccess: true, model: '', includeContext: true, sentenceAnalysisEnabled: false, connectionRevision: 1 };
  fixtures.sendMessage.mockResolvedValue(settings);
});
afterEach(() => { dispose?.(); dispose = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('document-scoped page translation lifecycle', () => {
  it('uses an injected userscript workload policy after before-use and preserves completed work on retry', async () => {
    passages = Array.from({ length: 3 }, (_, index) => segment(index + ': ' + 'article '.repeat(110), selectedRoot));
    const beforeUse = vi.fn().mockResolvedValue(true);
    dispose = mountPageTranslator({ executionPolicy: userscriptPageExecutionPolicy, beforeUse }); await flush();
    bar().onTranslate(); expect(fixtures.requests).toHaveLength(0); await flush();
    expect(fixtures.requests).toHaveLength(1);
    complete(1); await flush(); expect(fixtures.requests).toHaveLength(2);
    bar().onStop(); bar().onRetry(); await flush();
    expect(beforeUse).toHaveBeenCalledTimes(2);
    expect(bar().state.completed).toBe(1);
    expect(fixtures.requests).toHaveLength(3);
    expect(fixtures.requests[2]!.pageSegments).toEqual([passages[1]!.text]);
    expect(fixtures.requests.slice(1).every(input => !input.pageSegments?.includes(passages[0]!.text))).toBe(true);
  });

  it('uses the injected policy for viewport watching and a replacement article', async () => {
    const executionPolicy = vi.fn((engine: Parameters<typeof pageExecutionPolicy>[0]) => ({
      ...userscriptPageExecutionPolicy(engine), viewportPriority: false,
    }));
    passages = Array.from({ length: 3 }, (_, index) => segment(index + ': ' + 'article '.repeat(110), selectedRoot));
    dispose = mountPageTranslator({ executionPolicy }); await flush(); bar().onTranslate(); await flush();
    expect(fixtures.requests).toHaveLength(1); expect(fixtures.snapshot).not.toHaveBeenCalled();
    const previous = selectedRoot; previous.remove();
    selectedRoot = new ElementFixture('article'); pageBody.append(selectedRoot);
    passages = Array.from({ length: 3 }, (_, index) => segment('new ' + index + ': ' + 'article '.repeat(110), selectedRoot));
    mutation([{ type: 'childList', target: pageBody, addedNodes: [selectedRoot], removedNodes: [previous] }]);
    await vi.advanceTimersByTimeAsync(400);
    expect(fixtures.requests).toHaveLength(2);
    expect(fixtures.requests[1]!.pageSegments).toEqual([passages[0]!.text]);
    pageDocument.dispatchEvent(new Event('scroll')); await vi.advanceTimersByTimeAsync(16);
    expect(fixtures.snapshot).not.toHaveBeenCalled();
    expect(executionPolicy.mock.calls.every(([engine]) => engine === 'deepl-web')).toBe(true);
  });

  it('uses the shared DeepL concurrency budget and refills only a completed worker', async () => {
    const policy = pageExecutionPolicy('deepl-web');
    passages = Array.from({ length: policy.concurrency + 2 }, (_, index) => segment(`${index}: ${'article '.repeat(110)}`, selectedRoot));
    dispose = mountPageTranslator(); await flush(); bar().onTranslate(); await flush();
    expect(fixtures.requests).toHaveLength(policy.concurrency);
    complete(2); await flush();
    expect(fixtures.requests).toHaveLength(policy.concurrency + 1);
    complete(1); await flush();
    expect(fixtures.requests).toHaveLength(policy.concurrency + 2);
    expect(fixtures.requests.every(input => input.pageSegments?.length === 1 && input.text.length <= policy.batchTargetChars)).toBe(true);
  });

  it('measures before the first pump and reserves the first small batch for visible prose', async () => {
    passages = Array.from({ length: 6 }, (_, index) => segment(`${index}: ${'article '.repeat(25)}`, selectedRoot));
    for (const passage of passages) fixtures.priorities.set(passage, { tier: 0, distance: 0, visibleProse: true });
    dispose = mountPageTranslator(); await flush(); bar().onTranslate(); await flush();
    expect(fixtures.snapshot).toHaveBeenCalledWith(passages);
    expect(fixtures.requests[0]!.pageSegments).toEqual(passages.slice(0, 2).map(item => item.text));
    expect(fixtures.requests[1]!.pageSegments).toEqual(passages.slice(2).map(item => item.text));
  });

  it('coalesces scroll, resize and visibility snapshots without changing in-flight work', async () => {
    const concurrency = pageExecutionPolicy('deepl-web').concurrency;
    passages = Array.from({ length: 12 }, (_, index) => segment(`${index}: ${'article '.repeat(110)}`, selectedRoot));
    fixtures.priorities.set(passages[9]!, { tier: 0, distance: 0, visibleProse: true });
    dispose = mountPageTranslator(); await flush(); bar().onTranslate(); await flush();
    expect(fixtures.requests[0]!.pageSegments).toEqual([passages[9]!.text]);
    expect(fixtures.snapshot).toHaveBeenCalledTimes(1);
    fixtures.priorities.clear(); fixtures.priorities.set(passages[11]!, { tier: 0, distance: 0, visibleProse: true });
    pageDocument.dispatchEvent(new Event('scroll')); pageDocument.dispatchEvent(new Event('scroll'));
    pageWindow.dispatchEvent(new Event('resize')); pageDocument.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(16);
    expect(fixtures.snapshot).toHaveBeenCalledTimes(2);
    expect(fixtures.requests).toHaveLength(concurrency);
    complete(1); await flush();
    expect(fixtures.requests[concurrency]!.pageSegments).toEqual([passages[11]!.text]);
  });

  it('cancels pending viewport work on stop and disposal and leaves model sessions unmeasured', async () => {
    passages = Array.from({ length: 12 }, (_, index) => segment(`${index}: ${'article '.repeat(110)}`, selectedRoot));
    dispose = mountPageTranslator(); await flush(); bar().onTranslate(); await flush();
    expect(fixtures.snapshot).toHaveBeenCalledTimes(1);
    pageDocument.dispatchEvent(new Event('scroll')); bar().onStop();
    await vi.advanceTimersByTimeAsync(100);
    pageWindow.dispatchEvent(new Event('resize')); await vi.advanceTimersByTimeAsync(100);
    expect(fixtures.snapshot).toHaveBeenCalledTimes(1);
    notifySettings({ ...settings, translationEngine: 'model', hasApiKey: true, requiresApiKey: true });
    bar().onTranslate(); await flush(); pageDocument.dispatchEvent(new Event('scroll'));
    await vi.advanceTimersByTimeAsync(100); expect(fixtures.snapshot).toHaveBeenCalledTimes(1);
    notifySettings(settings); bar().onTranslate(); await flush();
    const before = fixtures.snapshot.mock.calls.length;
    pageDocument.dispatchEvent(new Event('scroll')); dispose(); dispose = undefined;
    await vi.advanceTimersByTimeAsync(100); expect(fixtures.snapshot).toHaveBeenCalledTimes(before);
  });

  it('uses the anonymous DeepL budget and restores the model budget after switching', async () => {
    passages = [segment('a'.repeat(749), selectedRoot), segment('b'.repeat(752), selectedRoot)];
    dispose = mountPageTranslator(); await flush(); bar().onTranslate(); await flush();
    expect(fixtures.requests).toHaveLength(2);
    expect(fixtures.requests[0]!.pageSegments).toEqual([passages[0]!.text]);
    expect(fixtures.requests[1]!.pageSegments).toEqual([passages[1]!.text]);
    complete(2); await flush(); complete(1); await flush();
    passages = [segment('c'.repeat(799), selectedRoot), segment('d'.repeat(800), selectedRoot)];
    notifySettings({ ...settings, translationEngine: 'model', hasApiKey: true, requiresApiKey: true });
    bar().onTranslate(); await flush();
    expect(fixtures.requests).toHaveLength(3);
    expect(fixtures.requests[2]!.pageSegments).toEqual(passages.map(item => item.text));
    expect(fixtures.requests[2]!.text).toHaveLength(1_600);
  });

  it('keeps results when showing originals, then invalidates them on connection and engine changes', async () => {
    dispose = mountPageTranslator(); await flush(); bar().onTranslate(); await flush();
    expect(fixtures.collect).toHaveBeenLastCalledWith(selectedRoot, settings);
    complete(); await flush(); bar().onRestore(); bar().onTranslate(); await flush();
    expect(fixtures.requests).toHaveLength(1);
    expect(bar().state).toMatchObject({ status: 'done', completed: 1 });
    notifySettings({ ...settings, connectionRevision: 2 }); bar().onTranslate(); await flush();
    expect(fixtures.requests).toHaveLength(2); complete(); await flush();
    notifySettings({ ...settings, connectionRevision: 2, translationEngine: 'model', hasApiKey: true, requiresApiKey: true });
    bar().onTranslate(); await flush(); expect(fixtures.requests).toHaveLength(3);
  });

  it('rescans the preferred root and cancels the old scope when the document replaces it', async () => {
    dispose = mountPageTranslator(); await flush(); bar().onTranslate(); await flush(); complete(); await flush();
    mutation([{ type: 'attributes', target: selectedRoot }]); await vi.advanceTimersByTimeAsync(400);
    expect(fixtures.collect).toHaveBeenLastCalledWith(selectedRoot, settings);
    expect(fixtures.requests).toHaveLength(1);
    const previous = selectedRoot; previous.remove();
    selectedRoot = new ElementFixture('article'); pageBody.append(selectedRoot); passages = [segment('Replacement article', selectedRoot)];
    mutation([{ type: 'childList', target: pageBody, addedNodes: [selectedRoot], removedNodes: [previous] }]); await vi.advanceTimersByTimeAsync(400);
    expect(fixtures.collect).toHaveBeenLastCalledWith(selectedRoot, settings);
    expect(fixtures.requests).toHaveLength(2);
    expect(fixtures.requests[1]!.pageSegments).toEqual(['Replacement article']);
  });

  it('ignores unrelated sidebar mutations without rescanning the preferred article', async () => {
    dispose = mountPageTranslator(); await flush(); bar().onTranslate(); await flush(); complete(); await flush();
    const sidebar = new ElementFixture('aside'), clock = new ElementFixture('span'); sidebar.append(clock); pageBody.append(sidebar);
    const scans = fixtures.collect.mock.calls.length, selections = fixtures.selectRoot.mock.calls.length;
    mutation([{ type: 'attributes', target: sidebar }, { type: 'characterData', target: { parentElement: clock } },
      { type: 'childList', target: sidebar, addedNodes: [new ElementFixture('div')], removedNodes: [] }]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fixtures.collect).toHaveBeenCalledTimes(scans); expect(fixtures.selectRoot).toHaveBeenCalledTimes(selections);
    expect(fixtures.prune).not.toHaveBeenCalled();
    const paragraph = new ElementFixture('p'); selectedRoot.append(paragraph); passages = [...passages, segment('New article passage', paragraph)];
    mutation([{ type: 'childList', target: selectedRoot, addedNodes: [paragraph], removedNodes: [] }]);
    await vi.advanceTimersByTimeAsync(400);
    expect(fixtures.collect).toHaveBeenCalledTimes(scans + 1); expect(fixtures.requests).toHaveLength(2);
  });

  it('still rescans when an ancestor changes visibility or the site removes an inserted translation', async () => {
    const main = new ElementFixture('main'); main.append(selectedRoot); pageBody.append(main);
    dispose = mountPageTranslator(); await flush(); bar().onTranslate(); await flush(); complete(); await flush();
    const scans = fixtures.collect.mock.calls.length;
    mutation([{ type: 'attributes', target: main }]); await vi.advanceTimersByTimeAsync(400);
    expect(fixtures.collect).toHaveBeenCalledTimes(scans + 1);
    const removed = new ElementFixture();
    vi.spyOn(removed, 'closest').mockReturnValue(removed as never); vi.spyOn(removed, 'hasAttribute').mockReturnValue(true);
    mutation([{ type: 'childList', target: selectedRoot, addedNodes: [], removedNodes: [removed] }]);
    await vi.advanceTimersByTimeAsync(400); expect(fixtures.collect).toHaveBeenCalledTimes(scans + 2);
  });

  it.each(['addition', 'visibility change'] as const)('preserves preferred-root selection after a competing article %s', async kind => {
    dispose = mountPageTranslator(); await flush(); bar().onTranslate(); await flush(); complete(); await flush();
    const sibling = new ElementFixture('section'), candidate = new ElementFixture('article'); sibling.append(candidate); pageBody.append(sibling);
    selectedRoot = pageBody; passages = [segment('Whole page after a second article becomes available', pageBody)];
    mutation([kind === 'addition'
      ? { type: 'childList', target: pageBody, addedNodes: [sibling], removedNodes: [] }
      : { type: 'attributes', target: sibling }]);
    await vi.advanceTimersByTimeAsync(400);
    expect(fixtures.collect).toHaveBeenLastCalledWith(pageBody, settings);
    expect(fixtures.requests).toHaveLength(2); expect(fixtures.clear).toHaveBeenCalled();
  });

  it('clears cached translations on navigation and prevents late results from warming the new document', async () => {
    dispose = mountPageTranslator(); await flush(); bar().onTranslate(); await flush(); complete(); await flush();
    pageWindow.dispatchEvent(new Event('popstate')); bar().onTranslate(); await flush();
    expect(fixtures.requests).toHaveLength(2);
    fixtures.update.mockClear(); locationValue.href = 'https://example.test/next'; complete(); await flush();
    expect(fixtures.update).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ status: 'done' }));
    bar().onTranslate(); await flush(); expect(fixtures.requests).toHaveLength(3);
  });
});
