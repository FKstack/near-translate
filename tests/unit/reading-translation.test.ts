import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranslationInput, TranslationServerMessage } from '../../src/shared/contracts';
import { MAX_TEXT_LENGTH } from '../../src/shared/contracts';
import { MODEL_PAGE_POLICY } from '../../src/shared/translation-policy';
import { readingStyles } from '../../src/reading/styles';

interface ClientFixture {
  receive: (event: TranslationServerMessage) => void;
  cancel: ReturnType<typeof vi.fn<() => void>>;
  dispose: ReturnType<typeof vi.fn<() => void>>;
}
interface RequestFixture { input: TranslationInput; id: string; client: ClientFixture }
const fixtures = vi.hoisted(() => ({ clients: [] as ClientFixture[], requests: [] as RequestFixture[], serial: 0 }));
vi.mock('../../src/platform/translation-client', () => ({ TranslationClient: class {
  private readonly client: ClientFixture;
  constructor(receive: (event: TranslationServerMessage) => void) {
    this.client = { receive, cancel: vi.fn<() => void>(), dispose: vi.fn<() => void>() };
    fixtures.clients.push(this.client);
  }
  start(input: TranslationInput) {
    const id = `reader-${++fixtures.serial}`;
    fixtures.requests.push({ input, id, client: this.client });
    return id;
  }
  cancel() { this.client.cancel(); }
  dispose() { this.client.dispose(); }
} }));
import { ReadingTranslation } from '../../src/reading/translation';

const first = 'The first paragraph explains safe local article extraction and careful ownership of the original website nodes.';
const second = 'The second paragraph describes a translation session that preserves completed results while allowing cancellation.';
const policy = { ...MODEL_PAGE_POLICY, concurrency: 1, batchMaxItems: 1 };
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
let active: ReadingTranslation | undefined;
let dom: JSDOM | undefined;

function setup(body = `<p>${first}</p><p>${second}</p>`, seed: ReadonlyMap<string, string> = new Map()) {
  dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'https://example.test/article' });
  const page = dom.window.document;
  const style = page.createElement('style');
  style.textContent = readingStyles;
  page.head.append(style);
  const root = page.createElement('article');
  root.className = 'nr-content'; root.dataset.mode = 'bilingual'; root.innerHTML = body;
  page.body.append(root);
  const changed = vi.fn();
  const reader = new ReadingTranslation(root, seed, changed);
  active = reader;
  return { page, root, reader, changed };
}

function complete(request: RequestFixture, translations = request.input.pageSegments!.map(() => '已完成译文')) {
  request.client.receive({ type: 'result', requestId: request.id,
    result: { kind: 'text', translation: translations.join('\n\n'), segments: translations } });
}

beforeEach(() => { fixtures.clients.length = 0; fixtures.requests.length = 0; fixtures.serial = 0; });
afterEach(() => { active?.dispose(); active = undefined; dom?.window.close(); dom = undefined; });

describe('reading snapshot translation ownership', () => {
  it('renders seeded results immediately with no translation requests', async () => {
    const { root, reader } = setup(undefined, new Map([[first, '第一段已有译文'], [second, '第二段已有译文']]));
    await flush();
    expect(fixtures.requests).toHaveLength(0);
    expect([...root.querySelectorAll('[data-near-reader-translation]')].map(node => node.textContent))
      .toEqual(['第一段已有译文', '第二段已有译文']);
    expect(reader.state).toMatchObject({ status: 'idle', total: 2, completed: 2, pending: 0 });
    reader.start(policy); await flush();
    expect(fixtures.requests).toHaveLength(0);
    expect(reader.state).toMatchObject({ status: 'done', total: 2, completed: 2, skipped: 0 });
  });

  it('starts only uncached paragraphs and renders returned text after source nodes are wrapped', async () => {
    const { root, reader } = setup(undefined, new Map([[first, '已有第一段']]));
    const original = root.querySelectorAll('p')[1]!.firstChild;
    reader.start(policy); await flush();
    expect(fixtures.requests).toHaveLength(1);
    expect(fixtures.requests[0]!.input.pageSegments).toEqual([second]);
    expect(original?.parentElement?.hasAttribute('data-near-reader-original')).toBe(true);
    complete(fixtures.requests[0]!, ['第二段新译文']); await flush();
    expect(reader.state).toMatchObject({ status: 'done', total: 2, completed: 2, skipped: 0 });
    expect(root.querySelectorAll('p')[1]!.querySelector('[data-near-reader-translation]')?.textContent).toBe('第二段新译文');
    expect(reader.snapshot.get(second)).toBe('第二段新译文');
  });

  it('keeps hidden originals current in translation mode without pruning seeded or completed text', async () => {
    const { page, root, reader } = setup(undefined, new Map([[first, '已有第一段']]));
    root.dataset.mode = 'translation';
    const seededOriginal = root.querySelector<HTMLElement>('[data-near-reader-original]')!;
    expect(page.defaultView!.getComputedStyle(seededOriginal).display).toBe('none');
    reader.start(policy); await flush(); complete(fixtures.requests[0]!, ['第二段译文']); await flush();
    expect(reader.state).toMatchObject({ status: 'done', total: 2, completed: 2, skipped: 0 });
    expect([...root.querySelectorAll('[data-near-reader-original]')].every(node =>
      page.defaultView!.getComputedStyle(node).display === 'none')).toBe(true);
    root.dataset.mode = 'original';
    expect([...root.querySelectorAll('[data-near-reader-translation]')].every(node =>
      page.defaultView!.getComputedStyle(node).display === 'none')).toBe(true);
    expect(page.defaultView!.getComputedStyle(seededOriginal).display).not.toBe('none');
    root.dataset.mode = 'bilingual';
    expect([...root.querySelectorAll('[data-near-reader-translation]')].every(node =>
      page.defaultView!.getComputedStyle(node).display !== 'none')).toBe(true);
  });

  it('renders both cached and network model HTML as plain text', async () => {
    const cached = '<img src="https://evil.test/pixel" onerror="alert(1)">cached';
    const returned = '<script>window.readerInjected=true</script><strong>unsafe model HTML</strong>';
    const { root, reader } = setup(undefined, new Map([[first, cached]]));
    expect(root.querySelector('img')).toBe(null);
    expect(root.querySelector('[data-near-reader-translation]')?.textContent).toBe(cached);
    reader.start(policy); await flush(); complete(fixtures.requests[0]!, [returned]); await flush();
    expect(root.querySelector('script,strong')).toBe(null);
    expect(root.querySelectorAll('[data-near-reader-translation]')[1]!.textContent).toBe(returned);
  });

  it('retains inline code nodes while placing translated prose outside the code element', async () => {
    const sentence = 'Call the readArticle() function to create a safe article snapshot.';
    const { root, reader } = setup('<p>Call the <code>readArticle()</code> function to create a safe article snapshot.</p>');
    const code = root.querySelector('code')!;
    reader.start(policy); await flush();
    expect(fixtures.requests[0]!.input.pageSegments).toEqual([sentence]);
    complete(fixtures.requests[0]!, ['调用 readArticle() 函数创建安全文章快照。']); await flush();
    expect(root.querySelector('code')).toBe(code);
    expect(code.textContent).toBe('readArticle()');
    expect(code.querySelector('[data-near-reader-translation]')).toBe(null);
    expect(code.dataset.nearReaderTranslated).toBe('true');
    expect(reader.state).toMatchObject({ completed: 1, skipped: 0 });
  });

  it('suppresses late results and callbacks after disposal', async () => {
    const { root, reader, changed } = setup();
    reader.start(policy); await flush();
    const request = fixtures.requests[0]!;
    reader.dispose();
    const markup = root.innerHTML;
    const changes = changed.mock.calls.length;
    complete(request, ['迟到译文']);
    request.client.receive({ type: 'segment', requestId: request.id, index: 0, text: '迟到增量' });
    reader.start(policy); reader.retry(); reader.stop(); await flush();
    expect(root.innerHTML).toBe(markup);
    expect(changed).toHaveBeenCalledTimes(changes);
    expect(fixtures.requests).toHaveLength(1);
    expect(fixtures.clients.every(client => client.dispose.mock.calls.length === 1)).toBe(true);
  });

  it('does not render results into text changed or removed after starting', async () => {
    const { root, reader } = setup(`<p>${first}</p>`);
    reader.start(policy); await flush();
    const original = root.querySelector('[data-near-reader-original]')!.firstChild!;
    original.nodeValue = 'Changed reader text';
    complete(fixtures.requests[0]!, ['不得回填的旧译文']); await flush();
    expect(root.textContent).not.toContain('不得回填的旧译文');
    expect(root.textContent).toContain('Changed reader text');
    expect(reader.state).toMatchObject({ completed: 0, skipped: 1 });
  });

  it('reuses a valid cached long paragraph even when its source exceeds a single request limit', async () => {
    const long = `${first} `.repeat(Math.ceil((MAX_TEXT_LENGTH + 1) / (first.length + 1))).trim();
    expect(long.length).toBeGreaterThan(MAX_TEXT_LENGTH);
    const { root, reader } = setup(`<p>${long}</p>`, new Map([[long, '完整长段缓存译文']]));
    expect(root.querySelector('[data-near-reader-translation]')?.textContent).toBe('完整长段缓存译文');
    reader.start(policy); await flush();
    expect(fixtures.requests).toHaveLength(0);
    expect(reader.state).toMatchObject({ status: 'done', completed: 1 });
  });

  it('clears the loading claim when explicitly stopped and preserves completed cached content', async () => {
    const { root, reader } = setup(undefined, new Map([[first, '保留已有译文']]));
    reader.start(policy); await flush();
    expect(root.textContent).toContain('翻译中…');
    reader.stop(); await flush();
    expect(reader.state.status).toBe('stopped');
    expect(root.textContent).toContain('保留已有译文');
    expect(root.textContent).not.toContain('翻译中…');
    expect(root.querySelector('[data-near-reader-translation][data-state="loading"]')).toBe(null);
  });
});
