import { webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageSegment } from '../../src/page/segments';
import type { PageViewportPriority } from '../../src/page/viewport';

const deps = vi.hoisted(() => ({ collect: vi.fn(), root: vi.fn(), viewport: vi.fn() }));
vi.mock('../../src/page/segments', async importOriginal => ({ ...await importOriginal<object>(),
  collectPageSegments: deps.collect, selectPageTranslationRoot: deps.root }));
vi.mock('../../src/page/viewport', () => ({ snapshotViewportPriorities: deps.viewport }));
import { PageBenchmarkProbe, PUBLIC_GO_URL, summarizeSources, translationHostForSegment } from '../../scripts/benchmarks/page-probe';

function fixture() {
  let now = 0; let foreground = true; let frameId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const listeners = new Map<string, EventListener>();
  const hosts: HTMLElement[] = [];
  const selection = { toString: () => 'existing selection', removeAllRanges: vi.fn() };
  const aside = { dataset: { status: 'idle', total: '0', completed: '0', failed: '0', pending: '0' } };
  const button = { click: vi.fn(() => Object.assign(aside.dataset, { status: 'running', total: '2', pending: '2' })) };
  const bar = { querySelector: (selector: string) => selector === '[data-status]' ? aside
    : selector === '[role="status"]' ? { textContent: 'numeric test state' } : button };
  const view = { location: { href: PUBLIC_GO_URL }, performance: { timeOrigin: 1000, now: () => now },
    crypto: webcrypto, getSelection: () => selection,
    requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; }),
    cancelAnimationFrame: vi.fn((id: number) => frames.delete(id)),
    addEventListener: (name: string, handler: EventListener) => listeners.set(name, handler),
    removeEventListener: (name: string) => listeners.delete(name),
  };
  const doc = { defaultView: view, body: {}, visibilityState: 'visible', hasFocus: () => foreground,
    querySelector: () => ({ shadowRoot: bar }), querySelectorAll: () => hosts.filter(h => h.dataset.state === 'done'),
    addEventListener: (name: string, handler: EventListener) => listeners.set(name, handler),
    removeEventListener: (name: string) => listeners.delete(name),
  } as unknown as Document;
  const makeSegment = (text: string) => ({ text, nodes: [{ data: text, isConnected: true }],
    container: { isConnected: true, nextSibling: null }, anchor: { nextSibling: null } } as unknown as PageSegment);
  const title = makeSegment('A misleading long heading that is still not production-qualified viewport prose.'.repeat(2));
  const prose = makeSegment('This paragraph is the original visible body selected by the production viewport definition for this benchmark.');
  const segments = [title, prose];
  const priorities = new Map<PageSegment, PageViewportPriority>([
    [title, { tier: 1, distance: 0, visibleProse: false }], [prose, { tier: 0, distance: 0, visibleProse: true }],
  ]);
  deps.collect.mockReturnValue(segments); deps.root.mockReturnValue({ tagName: 'ARTICLE' }); deps.viewport.mockReturnValue(priorities);
  vi.stubGlobal('MutationObserver', class { observe = vi.fn(); disconnect = vi.fn(); });
  const complete = (segment: PageSegment, text: string) => {
    const host = { nodeType: 1, tagName: 'NEAR-PAGE-TRANSLATION', hasAttribute: () => true, isConnected: true,
      dataset: { state: 'done' }, shadowRoot: { querySelector: () => ({ textContent: text }) } } as unknown as HTMLElement;
    Object.assign(segment.anchor, { nextSibling: host }); hosts.push(host);
    return host;
  };
  const probe = new PageBenchmarkProbe(doc);
  return { probe, doc, view, aside, title, prose, segments, priorities, frames, listeners, selection, complete,
    setNow: (value: number) => { now = value; }, setFocused: (value: boolean) => { foreground = value; } };
}

describe('installed page probe source identity and milestones', () => {
  afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

  it('freezes production source/viewport identities before clicking, without a second geometry policy', () => {
    const f = fixture();
    const prepared = f.probe.prepare();
    expect(deps.collect).toHaveBeenCalledExactlyOnceWith({ tagName: 'ARTICLE' });
    expect(deps.viewport).toHaveBeenCalledExactlyOnceWith(f.segments);
    expect(prepared).toMatchObject({ sourceSegments: 2, sourceChars: f.title.text.length + f.prose.text.length,
      viewportTargets: 1, initialViewportSourceIds: [1] });
    f.priorities.set(f.prose, { tier: 3, distance: 999, visibleProse: false });
    f.probe.start();
    expect(deps.viewport).toHaveBeenCalledTimes(1);
    expect(summarizeSources([f.title, f.title])).toMatchObject({ sourceSegments: 2, uniqueSourceTexts: 1 });
    f.probe.cleanup();
  });

  it('separates long-heading completion, frozen visible prose DOM-ready, next RAF, and full completion', async () => {
    const f = fixture(); f.probe.prepare(); f.probe.start();
    f.setNow(5); f.complete(f.title, '很长的标题'.repeat(30));
    expect(await f.probe.snapshot()).toMatchObject({ firstMs: 5, firstVisibleProseDomReadyMs: null, viewportCompleted: 0 });
    f.setNow(12); f.complete(f.prose, '这是正文译文。');
    expect(await f.probe.snapshot()).toMatchObject({ firstVisibleProseDomReadyMs: 12, firstVisibleProseSourceId: 1,
      initialViewportAllDoneMs: 12, firstVisibleProseRafMs: null });
    f.setNow(16); for (const callback of f.frames.values()) callback(16);
    Object.assign(f.aside.dataset, { status: 'done', completed: '2', pending: '0' });
    f.setNow(20);
    const final = await f.probe.snapshot();
    expect(final).toMatchObject({ firstVisibleProseRafMs: 16, fullDoneMs: 20, doneAt: 1020, renderedSegments: 2 });
    expect(final?.outputFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(final)).not.toContain('这是正文');
    f.setNow(1100); expect((await f.probe.snapshot())?.elapsedMs).toBe(20);
    f.probe.cleanup();
  });

  it('does not count one translation host for two original identities', async () => {
    const f = fixture(); f.probe.prepare(); f.probe.start();
    const shared = f.complete(f.title, '一个译文');
    Object.assign(f.prose.anchor, { nextSibling: shared });
    Object.assign(f.aside.dataset, { status: 'done', completed: '2', pending: '0' });
    const snapshot = await f.probe.snapshot();
    expect(snapshot?.mappingConflicts).toBeGreaterThan(0);
    expect(snapshot).toMatchObject({ renderedSegments: 1, fullDoneMs: null });
    expect(translationHostForSegment(f.title)).toBe(shared);
    f.probe.cleanup();
  });

  it('retains only selection length and detects even a temporary focus loss or changed original node', async () => {
    const f = fixture(); f.probe.prepare(); f.probe.start();
    f.setFocused(false); f.listeners.get('blur')?.(new Event('blur')); f.setFocused(true);
    f.prose.nodes[0]!.data = 'website changed its original text';
    expect(await f.probe.snapshot()).toMatchObject({ selectionLength: 'existing selection'.length,
      sourceChanged: true, focused: true, visibilityFailures: 1 });
    expect(f.selection.removeAllRanges).not.toHaveBeenCalled();
    f.probe.cleanup(); expect(f.listeners.size).toBe(0);
  });

  it('refuses a hidden, unfocused or non-public document before translation', () => {
    const f = fixture(); f.setFocused(false);
    expect(() => f.probe.prepare()).toThrow(/visible and focused/);
    f.setFocused(true); f.view.location.href = 'https://private.invalid/';
    expect(() => f.probe.readiness()).toThrow(/exact public Go URL/);
    f.probe.cleanup();
  });
});
