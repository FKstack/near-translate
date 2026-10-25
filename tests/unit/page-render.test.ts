import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { PageTranslationRenderer } from '../../src/page/render';
import { collectPageSegments, segmentIsCurrent } from '../../src/page/segments';
import { PageTranslationSession } from '../../src/page/session';
import type { TranslationInput, TranslationServerMessage } from '../../src/shared/contracts';

vi.mock('../../src/platform/translation-client', () => ({ TranslationClient: class {} }));

const documents: JSDOM[] = [];
let frames: Map<number, FrameRequestCallback>;
let callbacks: Map<number, FrameRequestCallback>;
let nextFrame: number;

beforeEach(() => {
  frames = new Map(); callbacks = new Map(); nextFrame = 0;
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
    const id = ++nextFrame; frames.set(id, callback); callbacks.set(id, callback); return id;
  }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => { frames.delete(id); }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const dom of documents.splice(0)) dom.window.close(); });

function fixture(body = '<article><p>The first complete English paragraph.</p><p>The second complete English paragraph.</p></article>') {
  const dom = new JSDOM(`<!doctype html><html lang="en"><body>${body}</body></html>`, { url: 'https://example.test/article' });
  documents.push(dom);
  const doc = dom.window.document;
  const segments = collectPageSegments(doc.querySelector('article')!);
  const renderer = new PageTranslationRenderer();
  return { dom, doc, segments, renderer, hosts: () => [...doc.querySelectorAll<HTMLElement>('near-page-translation')] };
}

function frame() {
  const ready = [...frames]; frames.clear();
  for (const [, callback] of ready) callback(16);
}

describe('page translation rendering frames', () => {
  it('lets the real session start and its transport microtask run before new loading DOM is inserted', async () => {
    const f = fixture();
    const events: string[] = [];
    let receive!: (message: TranslationServerMessage) => void;
    let input!: TranslationInput;
    const session = new PageTranslationSession({ onChange() {}, onSegment(segment, view) { f.renderer.update(segment, view); } }, callback => {
      return { start(value) { receive = callback; input = value; events.push('client-start'); queueMicrotask(() => { events.push('transport-microtask'); }); return 'local-request'; },
        cancel() {}, dispose() {} };
    });
    try {
      session.start(f.segments, { concurrency: 1 });
      await Promise.resolve(); await Promise.resolve();
      expect(events).toEqual(['client-start', 'transport-microtask']);
      expect(f.hosts()).toHaveLength(0);
      expect(input.pageSegments).toEqual(f.segments.map(segment => segment.text));
      const loadingFrame = [...callbacks.values()][0]!;
      frame();
      expect(f.hosts().map(host => host.dataset.state)).toEqual(['loading', 'loading']);
      receive({ type: 'result', requestId: 'local-request', result: { kind: 'text', translation: '完整译文', segments: ['第一段译文', '第二段译文'] } });
      expect(f.hosts().map(host => host.dataset.state)).toEqual(['done', 'done']);
      loadingFrame(32);
      expect(f.hosts().map(host => host.dataset.state)).toEqual(['done', 'done']);
    } finally { session.dispose(); f.renderer.clear(); }
  });

  it('defers only new loading hosts, then reads the whole batch before its first insertion', () => {
    const f = fixture();
    const events: string[] = [];
    const read = f.dom.window.getComputedStyle.bind(f.dom.window);
    vi.spyOn(f.dom.window, 'getComputedStyle').mockImplementation(element => { events.push('read'); return read(element); });
    const insert = f.dom.window.Node.prototype.insertBefore;
    vi.spyOn(f.dom.window.Node.prototype, 'insertBefore').mockImplementation(function(this: Node, node, child) {
      if ((node as Element).tagName === 'NEAR-PAGE-TRANSLATION') events.push('write');
      return insert.call(this, node, child);
    });
    f.renderer.update(f.segments[0]!, { status: 'loading' });
    f.renderer.update(f.segments[1]!, { status: 'loading' });
    expect(f.hosts()).toHaveLength(0);
    expect(events).toEqual([]);
    expect(frames.size).toBe(1);
    frame();
    expect(f.hosts()).toHaveLength(2);
    expect(events.filter(event => event === 'write')).toHaveLength(2);
    expect(events.slice(events.indexOf('write'))).toEqual(['write', 'write']);
    expect(f.hosts().map(host => host.shadowRoot!.textContent)).toEqual([expect.stringContaining('翻译中…'), expect.stringContaining('翻译中…')]);
    expect(f.segments.every(segmentIsCurrent)).toBe(true);
  });

  it('copies inherited style strings before writes and keeps block placement outside flex rows', () => {
    const f = fixture('<article><p style="display:flex;color:rgb(12, 34, 56);font:italic 600 18px/28px serif;text-align:right">The first paragraph.</p><p>The second paragraph.</p></article>');
    f.renderer.update(f.segments[0]!, { status: 'loading' }, 'ar');
    frame();
    const host = f.hosts()[0]!;
    expect(host.previousSibling).toBe(f.segments[0]!.container);
    expect(host.style.getPropertyValue('color')).toBe('rgb(12, 34, 56)');
    expect(host.style.getPropertyValue('font-family')).toBe('serif');
    expect(host.style.getPropertyValue('font-size')).toBe('18px');
    expect(host.style.getPropertyValue('font-weight')).toBe('600');
    expect(host.style.getPropertyValue('font-style')).toBe('italic');
    expect(host.style.getPropertyValue('line-height')).toBe('28px');
    expect(host.style.getPropertyValue('text-align')).toBe('start');
    expect(host.style.getPropertyPriority('color')).toBe('important');
    expect(host.style.getPropertyValue('direction')).toBe('rtl');
    expect(host.lang).toBe('ar');
  });

  it.each(['done', 'error'] as const)('renders %s immediately and an old loading frame never replaces it', status => {
    const f = fixture();
    const segment = f.segments[0]!;
    f.renderer.update(segment, { status: 'loading' });
    f.renderer.update(segment, status === 'done' ? { status, text: '<img src=x onerror=alert(1)>' }
      : { status, error: { code: 'NETWORK', message: 'offline', retryable: true } });
    const host = f.hosts()[0]!;
    expect(host.dataset.state).toBe(status);
    expect(host.shadowRoot!.querySelector('img')).toBeNull();
    expect(host.shadowRoot!.querySelector('span')!.textContent).toContain(status === 'done' ? '<img' : 'offline');
    frame();
    expect(f.hosts()).toEqual([host]);
    expect(host.dataset.state).toBe(status);
  });

  it('updates an existing host synchronously without rereading styles', () => {
    const f = fixture();
    const segment = f.segments[0]!;
    f.renderer.update(segment, { status: 'loading' }); frame();
    const host = f.hosts()[0]!;
    const style = vi.spyOn(f.dom.window, 'getComputedStyle');
    f.renderer.update(segment, { status: 'done', text: '完整译文' });
    f.renderer.update(segment, { status: 'loading' });
    expect(f.hosts()).toEqual([host]);
    expect(host.dataset.state).toBe('loading');
    expect(style).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
  });

  it.each(['hidden', 'edited', 'removed', 'moved'] as const)('never inserts delayed loading for a %s source', change => {
    const f = fixture();
    const segment = f.segments[0]!;
    f.renderer.update(segment, { status: 'loading' });
    if (change === 'hidden') segment.container.hidden = true;
    if (change === 'edited') segment.nodes[0]!.data = 'The original source was changed.';
    if (change === 'removed') segment.container.remove();
    if (change === 'moved') f.doc.body.append(segment.nodes[0]!);
    frame();
    expect(f.hosts()).toHaveLength(0);
  });

  it('checks URL and document ownership before delayed insertion', () => {
    const f = fixture();
    f.renderer.update(f.segments[0]!, { status: 'loading' });
    f.dom.window.history.pushState({}, '', '/another-article');
    frame();
    expect(f.hosts()).toHaveLength(0);
    const other = fixture();
    f.renderer.update(f.segments[1]!, { status: 'loading' });
    other.doc.body.append(f.segments[1]!.container);
    frame();
    expect(f.hosts()).toHaveLength(0);
    expect(other.hosts()).toHaveLength(0);
  });

  it('uses each source document for validity and inherited styles', () => {
    const f = fixture();
    const other = fixture('<article><p style="color:rgb(65, 43, 21)">The other document paragraph.</p></article>');
    f.renderer.update(f.segments[0]!, { status: 'loading' });
    f.renderer.update(other.segments[0]!, { status: 'loading' });
    frame();
    expect(f.hosts()).toHaveLength(1);
    expect(other.hosts()).toHaveLength(1);
    expect(other.hosts()[0]!.style.color).toBe('rgb(65, 43, 21)');
  });

  it('prune recreates removed loading hosts in a new frame with fresh styles', () => {
    const f = fixture();
    const segment = f.segments[0]!;
    f.renderer.update(segment, { status: 'loading' }); frame();
    f.hosts()[0]!.remove();
    segment.container.style.color = 'rgb(23, 45, 67)';
    f.renderer.prune(segmentIsCurrent);
    expect(f.hosts()).toHaveLength(0);
    frame();
    expect(f.hosts()[0]!.style.color).toBe('rgb(23, 45, 67)');
    f.hosts()[0]!.remove();
    f.renderer.update(segment, { status: 'done', text: '完整译文' });
    expect(f.hosts()[0]!.dataset.state).toBe('done');
    expect(frames.size).toBe(0);
  });

  it('stopped and prune invalidate pending work without inserting it', () => {
    const f = fixture();
    f.renderer.update(f.segments[0]!, { status: 'loading' });
    f.renderer.update(f.segments[1]!, { status: 'loading' });
    f.renderer.update(f.segments[0]!, { status: 'stopped' });
    f.renderer.prune(segment => segment !== f.segments[1]);
    frame();
    expect(f.hosts()).toHaveLength(0);
    f.renderer.update(f.segments[0]!, { status: 'done', text: '译文' });
    f.renderer.update(f.segments[0]!, { status: 'stopped' });
    expect(f.hosts()).toHaveLength(0);
  });

  it('clear cancels the frame and stale callbacks cannot flush a new generation', () => {
    const f = fixture();
    f.renderer.update(f.segments[0]!, { status: 'loading' });
    const old = callbacks.get(1)!;
    f.renderer.clear();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
    f.renderer.update(f.segments[1]!, { status: 'loading' });
    old(16);
    expect(f.hosts()).toHaveLength(0);
    expect(frames.size).toBe(1);
    frame();
    expect(f.hosts()).toHaveLength(1);
    expect(f.hosts()[0]!.parentElement).toBe(f.segments[1]!.container);
    f.renderer.clear();
    expect(f.hosts()).toHaveLength(0);
  });

  it('keeps its first frame ahead of the viewport frame when pending loading is replaced', () => {
    const f = fixture();
    const seen: number[] = [];
    f.renderer.update(f.segments[0]!, { status: 'loading' });
    requestAnimationFrame(() => { seen.push(f.hosts().filter(host => host.dataset.state === 'loading').length); });
    f.renderer.update(f.segments[0]!, { status: 'done', text: '第一段译文' });
    f.renderer.update(f.segments[1]!, { status: 'loading' });
    expect(cancelAnimationFrame).not.toHaveBeenCalled();
    frame();
    expect(seen).toEqual([1]);
    expect(f.hosts().map(host => host.dataset.state)).toEqual(['done', 'loading']);
  });

  it('rechecks tokens and original text after the read pass without reading styles between writes', () => {
    const f = fixture();
    f.renderer.update(f.segments[0]!, { status: 'loading' });
    f.renderer.update(f.segments[1]!, { status: 'loading' });
    const read = f.dom.window.getComputedStyle.bind(f.dom.window);
    let changed = false;
    vi.spyOn(f.dom.window, 'getComputedStyle').mockImplementation(element => {
      const result = read(element);
      if (!changed && element === f.segments[1]!.container) {
        changed = true; f.segments[0]!.nodes[0]!.data = 'The first source changed during this read pass.';
      }
      return result;
    });
    frame();
    expect(f.hosts()).toHaveLength(1);
    expect(f.hosts()[0]!.parentElement).toBe(f.segments[1]!.container);
  });

  it('keeps a replacement pending token for the next frame instead of applying its obsolete style read', () => {
    const f = fixture();
    const segment = f.segments[0]!;
    f.renderer.update(segment, { status: 'loading' }, 'zh-Hans');
    const read = f.dom.window.getComputedStyle.bind(f.dom.window);
    let replaced = false;
    vi.spyOn(f.dom.window, 'getComputedStyle').mockImplementation(element => {
      const result = read(element);
      if (!replaced) { replaced = true; f.renderer.update(segment, { status: 'loading' }, 'ar'); }
      return result;
    });
    frame();
    expect(f.hosts()).toHaveLength(0);
    expect(frames.size).toBe(1);
    frame();
    expect(f.hosts()[0]!.lang).toBe('ar');
  });

  it.each(['clear', 'done'] as const)('does not revive stale loading when insertion synchronously calls %s', action => {
    const f = fixture();
    const segment = f.segments[0]!;
    f.renderer.update(segment, { status: 'loading' });
    const insert = f.dom.window.Node.prototype.insertBefore;
    let invoked = false;
    vi.spyOn(f.dom.window.Node.prototype, 'insertBefore').mockImplementation(function(this: Node, node, child) {
      const result = insert.call(this, node, child);
      if (!invoked && (node as Element).tagName === 'NEAR-PAGE-TRANSLATION') {
        invoked = true;
        if (action === 'clear') f.renderer.clear();
        else f.renderer.update(segment, { status: 'done', text: '已完成的最新译文' });
      }
      return result;
    });
    frame();
    if (action === 'clear') expect(f.hosts()).toHaveLength(0);
    else {
      expect(f.hosts()).toHaveLength(1);
      expect(f.hosts()[0]!.dataset.state).toBe('done');
      expect(f.hosts()[0]!.shadowRoot!.querySelector('span')!.textContent).toBe('已完成的最新译文');
    }
  });
});
