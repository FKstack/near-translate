import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import type { TranslationError, TranslationInput, TranslationServerMessage } from '../../src/shared/contracts';
import { MAX_TEXT_LENGTH } from '../../src/shared/contracts';
import type { PageSegment } from '../../src/page/segments';
import { PAGE_BATCH_MAX_ITEMS, PAGE_BATCH_TARGET_CHARS, PAGE_CONCURRENCY, splitPageBatchText } from '../../src/page/batches';
import { pageExecutionPolicy, userscriptPageExecutionPolicy } from '../../src/shared/translation-policy';
import type { PageViewportPriority } from '../../src/page/viewport';

const fixtures = vi.hoisted(() => ({ stale: new WeakSet<object>() }));
vi.mock('../../src/platform/translation-client', () => ({ TranslationClient: vi.fn() }));
vi.mock('../../src/page/segments', () => ({ MAX_PAGE_SEGMENTS: 1_500, segmentIsCurrent: (segment: object) => !fixtures.stale.has(segment) }));
import { MAX_PAGE_SEGMENTS, PageTranslationSession } from '../../src/page/session';

function segment(text: string): PageSegment {
  return { text, nodes: [{} as Text], anchor: {} as Node, container: {} as HTMLElement };
}
function setup(isCurrent?: (segment: PageSegment) => boolean) {
  let serial = 0;
  const clients: Array<{
    start: ReturnType<typeof vi.fn<(input: TranslationInput) => string>>;
    cancel: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    receive: (event: TranslationServerMessage) => void;
  }> = [];
  const onChange = vi.fn();
  const onSegment = vi.fn();
  const session = new PageTranslationSession({ onChange, onSegment, ...(isCurrent ? { isCurrent } : {}) }, receive => {
    const client = { start: vi.fn((_input: TranslationInput) => `request-${++serial}`), cancel: vi.fn(), dispose: vi.fn(), receive };
    clients.push(client); return client;
  });
  const input = (worker = 0) => clients[worker]!.start.mock.calls.at(-1)![0];
  const id = (worker = 0) => clients[worker]!.start.mock.results.at(-1)!.value as string;
  const partial = (worker: number, index: number, text: string) => clients[worker]!.receive({ type: 'segment', requestId: id(worker), index, text });
  const done = (worker = 0, translations?: string[]) => {
    const results = translations ?? input(worker).pageSegments!.map(text => `译文：${text}`);
    clients[worker]!.receive({ type: 'result', requestId: id(worker), result: { kind: 'text', translation: results.join('\n\n'), segments: results } });
  };
  const fail = (worker = 0, code: TranslationError['code'] = 'SERVER') => clients[worker]!.receive({
    type: 'error', requestId: id(worker), error: { code, message: code, retryable: code !== 'AUTH' },
  });
  const requests = () => clients.flatMap(client => client.start.mock.calls.map(([request]) => request));
  return { session, clients, input, id, partial, done, fail, requests, onChange, onSegment };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
const wide = (index: number) => segment(`${index}:` + 'a'.repeat(900));
const visible: PageViewportPriority = { tier: 0, distance: 0, visibleProse: true };
const far: PageViewportPriority = { tier: 2, distance: 1_000, visibleProse: false };
function prioritize(session: PageTranslationSession, priorities: ReadonlyMap<PageSegment, PageViewportPriority>) {
  session.updateViewportPriorities(session.viewportSnapshot.generation, priorities);
}

describe('batched page translation session', () => {
  it('avoids repeating new-item and whole-queue validation during cold dispatch', async () => {
    const isCurrent = vi.fn((_source: PageSegment) => true);
    const { session, requests } = setup(isCurrent);
    const passages = Array.from({ length: 251 }, (_, index) => wide(index));
    session.start(passages, { concurrency: 8, batchMaxItems: 1, batchTargetChars: 1_500 });
    expect(isCurrent).toHaveBeenCalledTimes(251);
    await flush();
    expect(requests()).toHaveLength(8);
    expect(isCurrent).toHaveBeenCalledTimes(275);
    expect(isCurrent.mock.calls.filter(([source]) => source === passages[250])).toHaveLength(1);
    session.dispose();
  });

  it('fully validates a waiting group only after its part fits the selected batch', async () => {
    const isCurrent = vi.fn((_source: PageSegment) => true);
    const { session, requests, input, done } = setup(isCurrent);
    const first = segment('a'.repeat(60)), waiting = segment('b'.repeat(80)), filler = segment('c'.repeat(40));
    session.start([first, waiting, filler], { concurrency: 1, batchTargetChars: 100, batchSeparatorChars: 0, packing: 'fill' });
    isCurrent.mockClear();
    await flush();
    expect(input().pageSegments).toEqual([first.text, filler.text]);
    expect(isCurrent.mock.calls.some(([source]) => source === waiting)).toBe(false);
    done(); await flush();
    expect(requests()).toHaveLength(2);
    expect(input().pageSegments).toEqual([waiting.text]);
    expect(isCurrent.mock.calls.some(([source]) => source === waiting)).toBe(true);
    session.dispose();
  });

  it('never sends hidden, changed or removed sources after they wait for dispatch', async () => {
    const actual = await vi.importActual<typeof import('../../src/page/segments')>('../../src/page/segments');
    const dom = new JSDOM('<article><p id="first">First public passage.</p><p id="hidden">Hidden waiting passage.</p>'
      + '<p id="changed">Changed waiting passage.</p><p id="removed">Removed waiting passage.</p><p id="tail">Eligible final passage.</p></article>');
    try {
      const doc = dom.window.document;
      const sources = actual.collectPageSegments(doc.querySelector('article')!);
      const { session, requests, input, done } = setup(actual.segmentIsCurrent);
      session.start(sources, { concurrency: 1, batchMaxItems: 1 }); await flush();
      expect(input().pageSegments).toEqual([sources[0]!.text]);
      doc.getElementById('hidden')!.style.display = 'none';
      doc.getElementById('changed')!.firstChild!.textContent = 'Changed source content after admission.';
      doc.getElementById('removed')!.remove();
      done(); await flush();
      expect(requests()).toHaveLength(2);
      expect(input().pageSegments).toEqual([sources[4]!.text]);
      done(); await flush();
      expect(session.state).toMatchObject({ status: 'done', completed: 2, skipped: 3, pending: 0 });
      session.dispose();
    } finally { dom.window.close(); }
  });

  it('falls back to an ordinary first batch if every visible-prose candidate became stale', async () => {
    const { session, input, done, requests } = setup();
    const staleVisible = segment('Initial visible prose.'), eligible = segment('Eligible remaining passage.');
    session.start([staleVisible, eligible], { concurrency: 1, viewportPriority: true,
      batchTargetChars: 1_500, firstBatchTargetChars: 800, firstBatchMaxItems: 2 });
    prioritize(session, new Map([[staleVisible, visible], [eligible, far]]));
    fixtures.stale.add(staleVisible);
    await flush();
    expect(requests()).toHaveLength(1);
    expect(input().pageSegments).toEqual([eligible.text]);
    done(); await flush();
    expect(session.state).toMatchObject({ status: 'done', completed: 1, skipped: 1, pending: 0 });
    session.dispose();
  });

  it.each([false, true])('dispatches a surviving far duplicate after its visible source became stale (other visible=%s)', async otherVisible => {
    const { session, input, done, requests } = setup();
    const staleVisible = segment('Duplicated visible passage.'), surviving = segment(staleVisible.text);
    const another = segment('Another visible prose passage.');
    session.start([staleVisible, surviving, ...(otherVisible ? [another] : [])], { concurrency: 1,
      viewportPriority: true, batchTargetChars: 1_500, firstBatchTargetChars: 800, firstBatchMaxItems: 2 });
    prioritize(session, new Map([[staleVisible, visible], [surviving, far], [another, { ...visible, distance: 10 }]]));
    fixtures.stale.add(staleVisible);
    await flush();
    expect(requests()).toHaveLength(1);
    expect(input().pageSegments).toEqual([otherVisible ? another.text : surviving.text]);
    done(); await flush();
    if (otherVisible) {
      expect(requests()).toHaveLength(2);
      expect(input().pageSegments).toEqual([surviving.text]);
      done(); await flush();
    }
    expect(session.state).toMatchObject({ status: 'done', completed: otherVisible ? 2 : 1, skipped: 1, pending: 0 });
    session.dispose();
  });

  it('filters a selected source invalidated by an earlier loading callback and can later translate its replacement', async () => {
    const { session, onSegment, input, done, requests } = setup();
    const first = segment('First selected passage.'), stale = segment('Later selected passage.');
    onSegment.mockImplementation((source, view) => {
      if (source === first && view.status === 'loading') fixtures.stale.add(stale);
    });
    session.start([first, stale], { concurrency: 1 }); await flush();
    expect(input().pageSegments).toEqual([first.text]);
    done(); await flush();
    expect(session.state).toMatchObject({ status: 'done', completed: 1, skipped: 1, pending: 0 });
    const replacement = { ...stale };
    session.append([replacement]); await flush();
    expect(requests()).toHaveLength(2);
    expect(input().pageSegments).toEqual([replacement.text]);
    done(); await flush();
    expect(session.state).toMatchObject({ status: 'done', completed: 2, skipped: 1, pending: 0 });
    session.dispose();
  });

  it('rechecks earlier selected sources after stale-cleanup callbacks without rescanning the waiting queue', async () => {
    const { session, onSegment, input, done } = setup();
    const first = segment('First selected passage.'), second = segment('Second selected passage.'), final = segment('Final eligible passage.');
    onSegment.mockImplementation((source, view) => {
      if (source === final && view.status === 'loading') fixtures.stale.add(first);
      if (source === first && view.status === 'stopped') fixtures.stale.add(second);
    });
    session.start([first, second, final], { concurrency: 1 }); await flush();
    expect(input().pageSegments).toEqual([final.text]);
    done(); await flush();
    expect(session.state).toMatchObject({ status: 'done', completed: 1, skipped: 2, pending: 0 });
    session.dispose();
  });

  it('does not leave selected parts loading when cleanup invalidates every selected source', async () => {
    const { session, onSegment, requests } = setup();
    const first = segment('First selected passage.'), second = segment('Second selected passage.');
    onSegment.mockImplementation((source, view) => {
      if (source === first && view.status === 'loading') fixtures.stale.add(second);
      if (source === second && view.status === 'stopped') fixtures.stale.add(first);
    });
    session.start([first, second], { concurrency: 1 }); await flush();
    expect(requests()).toHaveLength(0);
    expect(session.state).toMatchObject({ status: 'done', completed: 0, skipped: 2, pending: 0 });
    session.dispose();
  });

  it.each(['cancel', 'reset', 'dispose'] as const)('does not dispatch an old batch after a loading callback calls %s', async action => {
    const { session, onSegment, requests, input } = setup();
    const original = segment('Original selected passage.'), replacement = segment('New generation passage.');
    let changed = false;
    onSegment.mockImplementation((_source, view) => {
      if (view.status !== 'loading' || changed) return;
      changed = true;
      if (action === 'cancel') session.cancel();
      else if (action === 'dispose') session.dispose();
      else { session.reset(); session.start([replacement], { concurrency: 1 }); }
    });
    session.start([original], { concurrency: 1 }); await flush(); await flush();
    if (action === 'reset') {
      expect(requests()).toHaveLength(1);
      expect(input().pageSegments).toEqual([replacement.text]);
    } else expect(requests()).toHaveLength(0);
    session.dispose();
  });

  it('keeps a surviving duplicate retryable if stale cleanup cancels during batch selection', async () => {
    const { session, onSegment, requests, input, done } = setup();
    const stale = segment('Duplicated waiting passage.'), surviving = segment(stale.text);
    let cancelled = false;
    onSegment.mockImplementation((source, view) => {
      if (source === stale && view.status === 'stopped' && !cancelled) { cancelled = true; session.cancel(); }
    });
    session.start([stale, surviving], { concurrency: 1 });
    fixtures.stale.add(stale);
    await flush();
    expect(requests()).toHaveLength(0);
    expect(session.state).toMatchObject({ status: 'stopped', pending: 1, skipped: 1 });
    session.retryFailed(); await flush();
    expect(requests()).toHaveLength(1);
    expect(input().pageSegments).toEqual([surviving.text]);
    done(); await flush();
    expect(session.state).toMatchObject({ status: 'done', completed: 1, pending: 0, skipped: 1 });
    session.dispose();
  });

  it('does not start a paragraph rejected by the view-owned current validator', async () => {
    const isCurrent = vi.fn(() => false); const { session, requests, onSegment } = setup(isCurrent);
    const paragraph = segment('Rejected by the reading view');
    session.start([paragraph]); await flush();
    expect(isCurrent).toHaveBeenCalledWith(paragraph); expect(requests()).toHaveLength(0);
    expect(onSegment).not.toHaveBeenCalled();
    expect(session.state).toMatchObject({ status: 'done', total: 0, completed: 0 }); session.dispose();
  });

  it('uses the view-owned validator during append, stale pruning and result rendering', async () => {
    const { session, requests, done, input, onSegment } = setup(() => true);
    const first = segment('Reader original hidden while translating'); const second = segment('Another hidden reader original');
    fixtures.stale.add(first); fixtures.stale.add(second);
    session.start([first], { concurrency: 1, batchMaxItems: 1 }); await flush();
    expect(requests()).toHaveLength(1); expect(input().pageSegments).toEqual([first.text]);
    session.append([second]); done(0, ['第一段']); await flush();
    expect(requests()).toHaveLength(2); expect(input().pageSegments).toEqual([second.text]);
    done(0, ['第二段']); await flush();
    expect(session.state).toMatchObject({ status: 'done', total: 2, completed: 2, skipped: 0 });
    expect(onSegment).toHaveBeenCalledWith(first, { status: 'done', text: '第一段' });
    expect(onSegment).toHaveBeenCalledWith(second, { status: 'done', text: '第二段' }); session.dispose();
  });

  it('sends visible prose before a preceding table of contents, preserving a whole paragraph above the soft limit', async () => {
    const { session, input, done, onSegment } = setup();
    const heading = segment('Table of contents'); const paragraph = segment('a'.repeat(1_100)); const tail = segment('tail');
    session.start([heading, paragraph, tail], { concurrency: 1, viewportPriority: true,
      batchTargetChars: 1_500, firstBatchTargetChars: 800, firstBatchMaxItems: 2 });
    prioritize(session, new Map([[paragraph, visible], [heading, { tier: 1, distance: 0, visibleProse: false }], [tail, far]]));
    await flush(); expect(input().pageSegments).toEqual([paragraph.text]);
    done(0, ['正文译文']); await flush(); expect(input().pageSegments).toEqual([heading.text, tail.text]);
    done(); await flush();
    expect(onSegment).toHaveBeenCalledWith(paragraph, { status: 'done', text: '正文译文' });
    expect(session.state).toMatchObject({ total: 3, completed: 3, pending: 0 });
  });

  it('uses the small first batch only when visible prose exists and keeps later batches at the hard budget', async () => {
    const { session, input, done, requests } = setup();
    const passages = Array.from({ length: 6 }, (_, index) => segment(`${index}:` + 'a'.repeat(200)));
    const policy = { concurrency: 1, viewportPriority: true, batchTargetChars: 1_500, firstBatchTargetChars: 800, firstBatchMaxItems: 2 };
    session.start(passages, policy); prioritize(session, new Map(passages.map(item => [item, visible])));
    await flush(); expect(input().pageSegments).toEqual(passages.slice(0, 2).map(item => item.text));
    done(); await flush(); expect(input().pageSegments).toEqual(passages.slice(2).map(item => item.text));
    session.start(passages.map(item => segment('new ' + item.text)), policy); await flush();
    expect(requests()).toHaveLength(3); expect(input().pageSegments).toHaveLength(6);
    session.dispose();
  });

  it('reprioritizes only queued sources and rejects snapshots from an older generation', async () => {
    const { session, input, done, requests } = setup();
    const passages = [segment('first'), segment('oldest waiting'), segment('newly visible')];
    const policy = { concurrency: 1, batchMaxItems: 1, viewportPriority: true };
    session.start(passages, policy); prioritize(session, new Map([[passages[0]!, visible]]));
    const oldGeneration = session.viewportSnapshot.generation;
    await flush(); expect(input().pageSegments).toEqual(['first']);
    prioritize(session, new Map([[passages[2]!, visible]])); await flush();
    expect(requests()).toHaveLength(1);
    done(); await flush(); expect(input().pageSegments).toEqual(['newly visible']);
    const replacement = [segment('replacement oldest'), segment('replacement later')];
    session.start(replacement, policy);
    session.updateViewportPriorities(oldGeneration, new Map([[replacement[1]!, visible]]));
    await flush(); expect(input().pageSegments).toEqual(['replacement oldest']);
    session.cancel(); prioritize(session, new Map([[replacement[1]!, visible]])); await flush();
    expect(requests()).toHaveLength(3);
  });

  it('gives every fourth batch to the oldest waiting source despite continuing viewport priority', async () => {
    const { session, input, done, requests } = setup();
    const passages = Array.from({ length: 7 }, (_, index) => segment(`paragraph ${index}`));
    session.start(passages, { concurrency: 1, batchMaxItems: 1, viewportPriority: true });
    prioritize(session, new Map(passages.map((item, index) => [item, index === 0 ? far : visible])));
    await flush();
    for (let count = 0; count < 3; count++) { expect(input().pageSegments).toEqual([passages[count + 1]!.text]); done(); await flush(); }
    expect(input().pageSegments).toEqual([passages[0]!.text]);
    for (let count = 3; count < 7; count++) { done(); await flush(); }
    expect(requests().flatMap(request => request.pageSegments)).toHaveLength(7);
    expect(session.state).toMatchObject({ completed: 7, pending: 0 });
  });

  it('prioritizes dynamically appended prose using retained source identities and still drains older content', async () => {
    const { session, input, done } = setup();
    const original = [segment('already in flight'), segment('older waiting')];
    session.start(original, { concurrency: 1, batchMaxItems: 1, viewportPriority: true }); await flush();
    const duplicateScan = { ...original[1]! }; const added = segment('new visible article paragraph');
    session.append([duplicateScan, added]);
    expect(session.viewportSnapshot.segments).toEqual([original[1], added]);
    prioritize(session, new Map([[added, visible]]));
    done(); await flush(); expect(input().pageSegments).toEqual([added.text]);
    done(); await flush(); expect(input().pageSegments).toEqual([original[1]!.text]);
    done(); await flush(); expect(session.state).toMatchObject({ total: 3, completed: 3, pending: 0 });
  });

  it('fills unused service budget with later small sources while keeping model packing ordered', async () => {
    const { session, input, done } = setup();
    const passages = [segment('a'.repeat(900)), segment('b'.repeat(900)), segment('c'.repeat(600))];
    session.start(passages, { concurrency: 1, batchTargetChars: 1_500, batchSeparatorChars: 0, packing: 'fill' });
    await flush(); expect(input().pageSegments).toEqual([passages[0]!.text, passages[2]!.text]);
    expect(input().pageSegments!.reduce((size, text) => size + text.length, 0)).toBe(1_500);
    done(); await flush(); expect(input().pageSegments).toEqual([passages[1]!.text]);
    session.reset();
    session.start(passages, { concurrency: 1, batchTargetChars: 1_500 }); await flush();
    expect(input().pageSegments).toEqual([passages[0]!.text]); session.dispose();
  });

  it('compacts the whole-paragraph tail without dropping a source or changing response-index mapping', async () => {
    const { session, input, done, partial, requests, onSegment } = setup();
    const ids = [217, 218, 219, 220, 221, 222, 223, 224, 225, 228, 235, 236, 237, 239, 241];
    const lengths = [539, 436, 342, 169, 190, 495, 656, 368, 276, 276, 292, 371, 306, 386, 483];
    const passages = ids.map((id, index) => segment(`${id}:`.padEnd(lengths[index]!, 'x')));
    const sourceId = new Map(passages.map((item, index) => [item.text, ids[index]!]));
    session.start(passages, { concurrency: 1, batchMaxItems: 32, batchTargetChars: 1_500,
      batchSeparatorChars: 0, packing: 'fill' }); await flush();
    expect(input().pageSegments!.map(text => sourceId.get(text))).toEqual([217, 223, 235]);
    partial(0, 2, '译文 235');
    expect(onSegment).toHaveBeenCalledWith(passages[10], { status: 'done', text: '译文 235' });
    for (let batch = 0; batch < 4; batch++) {
      done(0, input().pageSegments!.map(text => `译文 ${sourceId.get(text)}`)); await flush();
    }
    expect(requests().map(request => request.pageSegments!.map(text => sourceId.get(text))))
      .toEqual([[217, 223, 235], [218, 222, 241], [219, 239, 236, 224], [220, 221, 225, 228, 237]]);
    const sent = requests().flatMap(request => request.pageSegments!);
    expect(sent).toHaveLength(15); expect(new Set(sent).size).toBe(15);
    expect(sent.reduce((total, text) => total + text.length, 0)).toBe(5_585);
    expect(requests().every(request => request.pageSegments!.length <= 32
      && request.pageSegments!.reduce((total, text) => total + text.length, 0) <= 1_500)).toBe(true);
    for (const [index, passage] of passages.entries()) {
      expect(onSegment.mock.calls.filter(([item, update]) => item === passage && update.status === 'done'))
        .toEqual([[passage, { status: 'done', text: `译文 ${ids[index]}` }]]);
    }
    expect(session.state).toMatchObject({ status: 'done', completed: 15, failed: 0, pending: 0 });
    session.dispose();
  });

  it('keeps source order when the whole tail fits one batch, including separators at the exact budget', async () => {
    const { session, input } = setup();
    const passages = [200, 100, 300].map((length, index) => segment(`${index}:`.padEnd(length, 'x')));
    session.start(passages, { concurrency: 1, batchMaxItems: 3, batchTargetChars: 604,
      batchSeparatorChars: 2, packing: 'fill' }); await flush();
    expect(input().pageSegments).toEqual(passages.map(item => item.text));
    expect(input().pageSegments!.join('\n\n')).toHaveLength(604);
    session.reset();
    session.start(passages, { concurrency: 1, batchMaxItems: 2, batchTargetChars: 1_000,
      batchSeparatorChars: 2, packing: 'fill' }); await flush();
    // A hard item limit still requires multiple batches even when the characters fit.
    expect(input().pageSegments).toEqual([passages[0]!.text, passages[2]!.text]);
    session.dispose();
  });

  it('retains the original priority and every-fourth FIFO anchor while tail filling is enabled', async () => {
    const { session, input, done, requests } = setup();
    const passages = Array.from({ length: 7 }, (_, index) => segment(`${index}:`.padEnd(900 + index, 'x')));
    session.start(passages, { concurrency: 1, batchTargetChars: 1_500, batchSeparatorChars: 0,
      batchMaxItems: 32, packing: 'fill', viewportPriority: true });
    prioritize(session, new Map(passages.map((item, index) => [item,
      { tier: 2, distance: index === 0 ? 10_000 : index, visibleProse: false }])));
    await flush();
    for (let batch = 0; batch < 3; batch++) {
      expect(input().pageSegments).toEqual([passages[batch + 1]!.text]); done(); await flush();
    }
    expect(input().pageSegments).toEqual([passages[0]!.text]);
    for (let batch = 3; batch < 7; batch++) { done(); await flush(); }
    expect(new Set(requests().flatMap(request => request.pageSegments!)).size).toBe(7);
    expect(session.state.completed).toBe(7); session.dispose();
  });

  it('preserves the small first batch and leaves filler order unchanged while visible prose is queued', async () => {
    const { session, input, done } = setup();
    const passages = [137, 600, 200, 800].map((length, index) => segment(`${index}:`.padEnd(length, 'x')));
    session.start(passages, { concurrency: 1, batchMaxItems: 32, batchTargetChars: 1_500,
      batchSeparatorChars: 0, packing: 'fill', viewportPriority: true,
      firstBatchMaxItems: 1, firstBatchTargetChars: 800 });
    prioritize(session, new Map(passages.map((item, index) => [item, index < 2 ? visible : far])));
    await flush(); expect(input().pageSegments).toEqual([passages[0]!.text]);
    done(); await flush();
    expect(input().pageSegments).toEqual([passages[1]!.text, passages[2]!.text]);
    done(); await flush(); expect(input().pageSegments).toEqual([passages[3]!.text]);
    session.dispose();
  });

  it('keeps the existing fill order above the bounded tail size and for ordered model packing', async () => {
    const { session, input } = setup();
    const passages = [600, 200, 800, ...Array(14).fill(20)]
      .map((length: number, index) => segment(`${index}:`.padEnd(length, 'x')));
    const policy = { concurrency: 1, batchMaxItems: 2, batchTargetChars: 1_500, batchSeparatorChars: 0 as const };
    session.start(passages, { ...policy, packing: 'fill' }); await flush();
    expect(input().pageSegments).toEqual([passages[0]!.text, passages[1]!.text]);
    session.reset(); session.start(passages.slice(0, 3), { ...policy, packing: 'ordered' }); await flush();
    expect(input().pageSegments).toEqual([passages[0]!.text, passages[1]!.text]);
    session.dispose();
  });

  it('falls back for split paragraphs, including when an earlier part is already loading', async () => {
    const { session, input, done, requests, onSegment } = setup();
    const long = segment('L:' + '😀'.repeat(1_499));
    const anchor = segment('a'.repeat(600)), small = segment('s'.repeat(200)), large = segment('b'.repeat(800));
    session.start([anchor, small, long, large], { concurrency: 2, batchMaxItems: 32,
      batchTargetChars: 1_500, batchSeparatorChars: 0, packing: 'fill' }); await flush();
    expect(input(0).pageSegments).toEqual([anchor.text, small.text]);
    const firstPart = input(1).pageSegments![0]!;
    expect(firstPart).toHaveLength(1_500);
    done(0); await flush();
    const lastPart = input(0).pageSegments![0]!;
    expect(firstPart + lastPart).toBe(long.text);
    expect(input(0).pageSegments).toHaveLength(1);
    done(0, ['后半段']); await flush();
    expect(input(0).pageSegments).toEqual([large.text]);
    done(1, ['前半段']); done(0); await flush();
    expect(onSegment).toHaveBeenCalledWith(long, { status: 'done', text: '前半段\n\n后半段' });
    expect(requests()).toHaveLength(4);
    expect(session.state).toMatchObject({ completed: 4, pending: 0 }); session.dispose();
  });

  it('counts separators while filling the tail and never mutates an in-flight batch on append or cancel', async () => {
    const { session, input, requests, done } = setup();
    const passages = [500, 499, 500].map((length, index) => segment(`${index}:`.padEnd(length, 'x')));
    session.start(passages, { concurrency: 1, batchTargetChars: 1_000, batchSeparatorChars: 1, packing: 'fill' });
    await flush();
    expect(input().pageSegments).toEqual(passages.slice(0, 2).map(item => item.text));
    expect(input().text).toHaveLength(1_000);
    const active = input(); session.append([segment('new paragraph')]); await flush();
    expect(input()).toBe(active); expect(requests()).toHaveLength(1);
    session.cancel(); done(); await flush();
    expect(requests()).toHaveLength(1); expect(session.state.completed).toBe(0); session.dispose();
  });

  it('packs the saved Go length and frozen-priority fixture in 37 batches with full source coverage', async () => {
    const { session, input, done, requests, onSegment } = setup();
    // Public Go extraction: 251 lengths / 53,505 UTF-16 units. Priorities are the
    // offline frozen proxy, not a claim to reconstruct historical browser geometry.
    const lengths = [68,8,12,17,11,15,15,14,28,11,21,11,18,10,10,13,15,22,31,10,9,14,11,12,137,802,351,235,
      16,196,429,16,109,455,143,94,280,316,105,15,351,11,25,56,76,21,15,12,37,21,186,822,29,176,356,238,280,
      25,432,350,853,212,1115,491,498,389,440,12,374,184,126,286,270,100,22,293,257,485,188,28,28,35,524,
      197,181,285,804,223,199,536,593,108,718,340,752,12,129,100,89,277,117,142,203,556,230,70,19,222,216,
      354,11,343,608,199,18,480,135,176,279,99,140,35,725,125,11,434,64,63,118,629,97,69,57,66,70,20,17,
      396,217,539,181,215,240,417,14,469,106,30,41,31,86,40,31,69,13,141,11,18,15,10,13,266,16,313,540,
      111,403,130,175,667,249,23,289,427,289,65,277,376,212,417,354,278,916,103,414,32,419,157,130,239,
      184,177,493,762,649,190,179,518,241,463,316,293,157,11,479,157,522,160,188,214,387,389,10,174,187,
      153,458,539,436,342,169,190,495,656,368,276,15,34,276,94,13,9,6,5,10,292,371,306,92,386,12,483,40,
      18,12,15,28,78,47,51,6];
    const nonProse = new Set([28,31,39,41,42,43,44,45,46,47,48,49,52,57,67,74,79,80,81,95,105,106,110,114,
      121,124,126,127,131,132,133,134,135,136,144,147,148,149,151,152,153,154,156,157,158,159,160,162,171,
      175,185,203,212,226,227,230,231,232,233,234,240,242,243,244,245,246,247,248,249,250]);
    const viewport = new Set([24, 25, 26, 27]);
    const passages = lengths.map((length, index) => segment(`${index}:`.padEnd(length, 'x')));
    const indices = new Map(passages.map((item, index) => [item.text, index]));
    session.start(passages, { concurrency: 1, batchMaxItems: 32, batchTargetChars: 1_500,
      batchSeparatorChars: 0, packing: 'fill', viewportPriority: true,
      firstBatchMaxItems: 2, firstBatchTargetChars: 800 });
    prioritize(session, new Map(passages.map((item, index) => [item, {
      tier: viewport.has(index) ? 0 : index < 24 ? 1 : nonProse.has(index) ? 3 : 2,
      distance: index, visibleProse: viewport.has(index),
    }]))); await flush();
    expect(input().pageSegments).toEqual([passages[24]!.text]);
    for (let batch = 0; batch < 40 && session.state.status === 'running'; batch++) {
      done(0, input().pageSegments!.map(text => `译文 ${indices.get(text)}`)); await flush();
    }
    const sent = requests().flatMap(request => request.pageSegments!);
    expect(requests()).toHaveLength(37);
    // Frozen from the pre-optimization Session with this exact proxy fixture.
    expect(requests().map(request => request.pageSegments!.map(text => indices.get(text)))).toEqual([
      [24],
      [25, 26, 27, 0, 1, 2, 3, 232],
      [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 29, 30, 32, 33, 159],
      [28, 31, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 45, 46, 47, 49],
      [50, 51, 53, 55, 44],
      [54, 56, 58, 59, 48, 52, 67],
      [60, 61, 65, 57, 95, 231],
      [62, 68, 110],
      [63, 64, 66, 74, 79, 106],
      [69, 70, 71, 72, 73, 75, 78, 80, 114, 233],
      [76, 77, 82, 83, 81],
      [84, 85, 86, 87, 250],
      [88, 89, 90, 91, 121, 124, 136],
      [92, 93, 96, 97, 98, 100],
      [94, 99, 101, 102, 119, 135],
      [103, 104, 105, 107, 108, 113],
      [109, 111, 112, 116, 132],
      [115, 117, 118, 120, 123, 128, 130, 126, 144],
      [122, 125, 138, 146, 154],
      [127, 129, 131, 133, 134, 137, 140, 156, 158],
      [139, 141, 142, 143, 150],
      [145, 155, 161, 163, 165, 167, 147, 149],
      [164, 166, 168, 170, 183, 157, 203],
      [148, 151, 152, 153, 160, 162, 169, 171, 172, 174, 212, 234],
      [173, 176, 177, 178, 187, 185, 226],
      [179, 180, 181, 184, 227],
      [182, 186, 188, 230, 240],
      [175, 189, 190, 191, 192, 195, 229, 242, 243],
      [193, 194, 244, 245, 246],
      [196, 197, 198, 199, 238],
      [200, 201, 202, 204, 205, 247],
      [206, 207, 208, 209, 210],
      [211, 213, 214, 215, 216, 248, 249],
      [217, 223, 235],
      [218, 222, 241],
      [219, 239, 236, 224],
      [220, 221, 225, 228, 237],
    ]);
    expect(sent).toHaveLength(251); expect(new Set(sent).size).toBe(251);
    expect(sent.reduce((total, text) => total + text.length, 0)).toBe(53_505);
    expect(requests().every(request => request.pageSegments!.length <= 32
      && request.pageSegments!.reduce((total, text) => total + text.length, 0) <= 1_500)).toBe(true);
    for (const [index, passage] of passages.entries()) {
      expect(onSegment.mock.calls.filter(([item, update]) => item === passage && update.status === 'done'))
        .toEqual([[passage, { status: 'done', text: `译文 ${index}` }]]);
    }
    expect(session.state).toMatchObject({ status: 'done', completed: 251, failed: 0, pending: 0 }); session.dispose();
  });

  it('packs up to 32 short service passages while preserving each index and serial dispatch', async () => {
    const { session, requests, input, done, onSegment } = setup();
    const passages = Array.from({ length: 35 }, (_, index) => segment(`heading ${index}`));
    session.start(passages, { concurrency: 1, batchMaxItems: 32, batchTargetChars: 4_800, batchSeparatorChars: 2 }); await flush();
    expect(requests()).toHaveLength(1);
    expect(input().pageSegments).toEqual(passages.slice(0, 32).map(item => item.text));
    done(0, passages.slice(0, 32).map((_, index) => `译文 ${index}`)); await flush();
    expect(requests()).toHaveLength(2);
    expect(input().pageSegments).toEqual(passages.slice(32).map(item => item.text));
    expect(onSegment).toHaveBeenCalledWith(passages[31], { status: 'done', text: '译文 31' });
    done(); await flush(); expect(session.state).toMatchObject({ completed: 35, pending: 0 });
  });

  it('uses the larger character budget for packing and splitting, then restores model defaults', async () => {
    const { session, requests, input, done } = setup();
    const long = segment('x'.repeat(3_000));
    session.start([long, ...Array.from({ length: 6 }, (_, index) => wide(index))],
      { concurrency: 1, batchMaxItems: 32, batchTargetChars: 4_800, batchSeparatorChars: 2 }); await flush();
    expect(input().pageSegments).toEqual([long.text, wide(0).text]);
    expect(input().text.length).toBeLessThanOrEqual(4_800);
    done(); await flush(); expect(input().pageSegments).toHaveLength(5);
    session.start(Array.from({ length: 33 }, (_, index) => wide(index + 100))); await flush();
    const modelRequests = requests().slice(2);
    expect(modelRequests).toHaveLength(PAGE_CONCURRENCY);
    expect(modelRequests.every(request => request.text.length <= PAGE_BATCH_TARGET_CHARS)).toBe(true);
    session.dispose();
  });

  it('includes every double-newline separator in the service budget without changing the public input shape', async () => {
    const { session, input, requests, done } = setup();
    const passages = ['a'.repeat(1_600), 'b'.repeat(1_598), 'c'.repeat(1_598), 'tail'].map(segment);
    session.start(passages, { concurrency: 1, batchMaxItems: 32, batchTargetChars: 4_800, batchSeparatorChars: 2 });
    await flush();
    expect(input().pageSegments).toEqual(passages.slice(0, 3).map(item => item.text));
    expect(input().pageSegments!.join('\n\n')).toHaveLength(4_800);
    expect(input().text).toBe(input().pageSegments!.join('\n'));
    done(); await flush(); expect(input().pageSegments).toEqual(['tail']);
    expect(requests()).toHaveLength(2); session.dispose();
  });

  it('splits a one-character double-newline overflow and resets to single separators on the next start', async () => {
    const { session, input, requests, done } = setup();
    const passages = [segment('a'.repeat(2_399)), segment('b'.repeat(2_400))];
    session.start(passages, { concurrency: 1, batchMaxItems: 32, batchTargetChars: 4_800, batchSeparatorChars: 2 });
    await flush(); expect(input().pageSegments).toEqual([passages[0]!.text]);
    done(); await flush(); expect(input().pageSegments).toEqual([passages[1]!.text]);
    const modelPassages = [segment('c'.repeat(799)), segment('d'.repeat(800))];
    session.start(modelPassages); await flush();
    expect(input().pageSegments).toEqual(modelPassages.map(item => item.text));
    expect(input().text).toHaveLength(PAGE_BATCH_TARGET_CHARS);
    expect(requests()).toHaveLength(3); session.dispose();
  });

  it('runs a single passage at a time for a serial service, then restores model scheduling on a new start', async () => {
    const { session, clients, requests, done, input } = setup();
    session.start([segment('first passage'), segment('second passage'), segment('third passage')], { concurrency: 1, batchMaxItems: 1 });
    await flush();
    expect(requests()).toHaveLength(1);
    expect(input().pageSegments).toEqual(['first passage']);
    done(); await flush();
    expect(requests()).toHaveLength(2);
    expect(input().pageSegments).toEqual(['second passage']);
    expect(clients.slice(1).every(client => client.start.mock.calls.length === 0)).toBe(true);
    session.cancel(); await flush();
    expect(requests()).toHaveLength(2);
    session.start(Array.from({ length: PAGE_CONCURRENCY + 1 }, (_, index) => wide(index))); await flush();
    expect(requests()).toHaveLength(2 + PAGE_CONCURRENCY);
    session.dispose();
  });

  it('waits for explicit start and bounds concurrent batches while draining later waves', async () => {
    const { session, clients, requests, done } = setup();
    expect(clients).toHaveLength(PAGE_CONCURRENCY);
    expect(requests()).toEqual([]);
    session.start(Array.from({ length: PAGE_CONCURRENCY + 8 }, (_, index) => wide(index))); await flush();
    expect(requests()).toHaveLength(PAGE_CONCURRENCY);
    expect(session.state).toMatchObject({ status: 'running', completed: 0, pending: PAGE_CONCURRENCY + 8 });
    for (let index = 0; index < PAGE_CONCURRENCY; index++) done(index);
    await flush();
    expect(requests()).toHaveLength(PAGE_CONCURRENCY + 8);
    for (let index = 0; index < 8; index++) done(index);
    await flush();
    expect(session.state).toMatchObject({ status: 'done', completed: PAGE_CONCURRENCY + 8, failed: 0, pending: 0 });
  });

  it('packs short passages and immediately routes streamed indices to the correct paragraph', async () => {
    const { session, clients, input, partial, done, onSegment } = setup();
    const passages = [segment('first'), segment('second'), segment('third')];
    session.start(passages); await flush();
    expect(input()).toEqual({ kind: 'text', text: 'first\nsecond\nthird', pageSegments: ['first', 'second', 'third'] });
    expect(clients[1]!.start).not.toHaveBeenCalled();
    partial(0, 2, '第三段');
    expect(onSegment).toHaveBeenCalledWith(passages[2], { status: 'done', text: '第三段' });
    expect(session.state).toMatchObject({ status: 'running', completed: 1, pending: 2 });
    done(0, ['第一段', '第二段', '第三段']); await flush();
    expect(session.state).toMatchObject({ status: 'done', completed: 3, pending: 0 });
  });

  it('bounds item count and joined characters in every batch', async () => {
    const { session, requests } = setup();
    session.start(Array.from({ length: 100 }, (_, index) => segment(`paragraph ${index}`))); await flush();
    expect(requests().length).toBeLessThan(100);
    for (const input of requests()) {
      expect(input.pageSegments!.length).toBeLessThanOrEqual(PAGE_BATCH_MAX_ITEMS);
      expect(input.text.length).toBeLessThanOrEqual(PAGE_BATCH_TARGET_CHARS);
      expect(input.pageSegments!.join('\n')).toBe(input.text);
    }
    session.dispose();
  });

  it('deduplicates rescans and shares cached text with new paragraph nodes', async () => {
    const { session, clients, done, onSegment } = setup();
    const first = segment('Repeated paragraph.');
    session.start([first, segment(first.text)]); await flush();
    session.append([{ ...first }]); expect(session.state.total).toBe(2);
    done(0, ['重复段落。']); await flush();
    const third = segment(first.text); session.append([third]);
    expect(session.state).toMatchObject({ status: 'done', total: 3, completed: 3 });
    expect(onSegment).toHaveBeenCalledWith(third, { status: 'done', text: '重复段落。' });
    expect(clients[0]!.start).toHaveBeenCalledOnce();
  });

  it('restores cached A when the same text node changes A to B and back to A', async () => {
    const { session, requests, done, onSegment } = setup();
    const first = segment('Original paragraph A.');
    session.start([first]); await flush(); done(0, ['译文 A']); await flush();
    fixtures.stale.add(first);
    const changed = { ...first, text: 'Replacement paragraph B.' };
    session.append([changed]); await flush(); done(0, ['译文 B']); await flush();
    fixtures.stale.add(changed);
    const restored = { ...first }; session.append([restored]); await flush();
    expect(onSegment).toHaveBeenCalledWith(restored, { status: 'done', text: '译文 A' });
    expect(requests()).toHaveLength(2);
    expect(session.state).toMatchObject({ status: 'done', total: 1, completed: 1, pending: 0, skipped: 2 });
  });

  it('requeues a passage that becomes stale before dispatch and later reappears', async () => {
    const { session, clients, input } = setup();
    const removed = segment('Paragraph waiting for translation.');
    session.start([removed]); fixtures.stale.add(removed); await flush();
    expect(session.state).toMatchObject({ status: 'done', skipped: 1 });
    session.append([{ ...removed }]); await flush();
    expect(clients[0]!.start).toHaveBeenCalledOnce();
    expect(input().pageSegments).toEqual([removed.text]);
  });

  it('cancels batches, suppresses late events and starts a clean generation', async () => {
    const { session, clients, id, done, onSegment } = setup();
    session.start([segment('old one'), segment('old two')]); await flush();
    const old = id(); session.cancel(); const calls = onSegment.mock.calls.length;
    clients[0]!.receive({ type: 'segment', requestId: old, index: 0, text: '迟到' });
    clients[0]!.receive({ type: 'result', requestId: old, result: { kind: 'text', translation: '迟到' } }); await flush();
    expect(onSegment).toHaveBeenCalledTimes(calls);
    expect(session.state).toMatchObject({ status: 'stopped', completed: 0, pending: 2 });
    const current = segment('new paragraph'); session.start([current]); await flush();
    clients[0]!.receive({ type: 'segment', requestId: old, index: 0, text: '迟到' });
    done(0, ['新结果']); await flush();
    expect(onSegment).toHaveBeenCalledWith(current, { status: 'done', text: '新结果' });
    expect(session.state).toMatchObject({ status: 'done', total: 1, completed: 1 });
  });

  it('stops queued and active work on a rate limit and waits for manual retry', async () => {
    const { session, requests, fail, clients } = setup();
    session.start(Array.from({ length: PAGE_CONCURRENCY + 3 }, (_, index) => wide(index))); await flush();
    fail(0, 'RATE_LIMIT'); await flush();
    expect(session.state).toMatchObject({ status: 'stopped', failed: 0, pending: PAGE_CONCURRENCY + 3, error: { code: 'RATE_LIMIT' } });
    session.append([segment('new dynamic paragraph')]); await flush();
    expect(requests()).toHaveLength(PAGE_CONCURRENCY);
    expect(clients.every(client => client.cancel.mock.calls.length >= 2)).toBe(true);
    session.retryFailed(); await flush();
    expect(requests()).toHaveLength(PAGE_CONCURRENCY * 2);
    expect(session.state.error).toBeUndefined(); session.dispose();
  });

  it.each(['AUTH', 'BALANCE', 'CONFIG', 'DISCONNECTED', 'NETWORK', 'TIMEOUT'] as const)(
    'shows one session-level %s failure and stops active and queued batches without paragraph errors', async code => {
      const { session, requests, clients, fail, onSegment } = setup();
      session.start(Array.from({ length: PAGE_CONCURRENCY + 5 }, (_, index) => wide(index)));
      await flush(); fail(0, code); await flush();
      expect(session.state).toMatchObject({ status: 'stopped', completed: 0, failed: 0,
        pending: PAGE_CONCURRENCY + 5, error: { code } });
      expect(onSegment.mock.calls.some(([, update]) => update.status === 'error')).toBe(false);
      expect(clients.every(client => client.cancel.mock.calls.length >= 2)).toBe(true);
      session.append([segment('New content after the service stopped')]); await flush();
      expect(requests()).toHaveLength(PAGE_CONCURRENCY);
      session.dispose();
    });

  it('keeps streamed successes and retries only unfinished text after a network failure', async () => {
    const { session, requests, input, partial, fail, done, clients, id, onSegment } = setup();
    const passages = ['first success', 'second unfinished', 'third waiting', 'fourth waiting'].map(segment);
    session.start(passages, { concurrency: 1, batchMaxItems: 2 }); await flush();
    const previousRequest = id();
    partial(0, 0, '已完成的译文'); fail(0, 'NETWORK'); await flush();
    expect(session.state).toMatchObject({ status: 'stopped', total: 4, completed: 1, pending: 3, failed: 0,
      error: { code: 'NETWORK' } });
    expect(onSegment.mock.calls.filter(([, update]) => update.status === 'error')).toHaveLength(0);
    expect(onSegment.mock.calls.filter(([item, update]) => item === passages[0] && update.status === 'stopped')).toHaveLength(0);
    clients[0]!.receive({ type: 'result', requestId: previousRequest,
      result: { kind: 'text', translation: '迟到的结果', segments: ['覆盖成功', '迟到结果'] } });
    session.append([segment('Dynamically loaded while stopped')]); await flush();
    expect(requests()).toHaveLength(1);
    session.retryFailed(); await flush();
    expect(input().pageSegments).toEqual(['second unfinished', 'third waiting']);
    done(); await flush(); expect(input().pageSegments).toEqual(['fourth waiting']);
    done(); await flush();
    expect(session.state).toMatchObject({ status: 'done', completed: 4, pending: 0, failed: 0, error: undefined });
    expect(onSegment.mock.calls.filter(([item, update]) => item === passages[0] && update.status === 'done'))
      .toEqual([[passages[0], { status: 'done', text: '已完成的译文' }]]);
    session.dispose();
  });

  it('preserves streamed successes and retries only unfinished passages after a batch fails', async () => {
    const { session, requests, input, partial, fail, done, onSegment } = setup();
    const passages = [segment('first success'), segment('second failure'), segment('third unfinished')];
    session.start(passages); await flush(); partial(0, 0, '成功段'); fail(); await flush();
    expect(session.state).toMatchObject({ status: 'done', completed: 1, failed: 2 });
    session.retryFailed(); await flush();
    expect(input().pageSegments).toEqual(['second failure', 'third unfinished']);
    done(0, ['第二段', '第三段']); await flush();
    expect(requests()).toHaveLength(2);
    expect(onSegment.mock.calls.filter(([item, value]) => item === passages[0] && value.status === 'done')).toHaveLength(1);
    expect(session.state).toMatchObject({ status: 'done', completed: 3, failed: 0 });
  });

  it('drops paragraphs removed before dispatch or changed during translation', async () => {
    const { session, clients, done, onSegment, input } = setup();
    const removed = segment('removed before dispatch'); const changed = segment('changed during translation');
    session.start([removed, changed]); fixtures.stale.add(removed); await flush();
    expect(input().pageSegments).toEqual([changed.text]); expect(clients[1]!.start).not.toHaveBeenCalled();
    fixtures.stale.add(changed); done(); await flush();
    expect(onSegment.mock.calls.filter(([, update]) => update.status === 'done')).toHaveLength(0);
    expect(session.state).toMatchObject({ status: 'done', completed: 0, skipped: 2, pending: 0 });
  });

  it('translates long-paragraph parts concurrently and reassembles source order', async () => {
    const { session, requests, partial, done, onSegment } = setup();
    const long = segment('a'.repeat(1600) + 'b'.repeat(1600) + 'tail');
    session.start([long]); await flush();
    expect(requests().map(input => input.pageSegments!.join('')).join('')).toBe(long.text);
    expect(requests()).toHaveLength(3);
    partial(2, 0, '第三部分'); done(2, ['第三部分']); await flush();
    partial(1, 0, '第二部分'); done(1, ['第二部分']); await flush();
    expect(onSegment.mock.calls.filter(([, update]) => update.status === 'done')).toHaveLength(0);
    done(0, ['第一部分']); await flush();
    expect(onSegment).toHaveBeenCalledWith(long, { status: 'done', text: '第一部分\n\n第二部分\n\n第三部分' });
    expect(session.state.completed).toBe(1);
  });

  it('retains successful long-paragraph parts while retrying only its failed part', async () => {
    const { session, requests, done, fail, input, onSegment } = setup();
    const long = segment('a'.repeat(1600) + 'b'.repeat(1600));
    session.start([long]); await flush(); done(0, ['第一部分']); fail(1); await flush();
    session.retryFailed(); await flush(); expect(input().pageSegments).toEqual(['b'.repeat(1600)]);
    done(0, ['第二部分']); await flush(); expect(requests()).toHaveLength(3);
    expect(onSegment).toHaveBeenCalledWith(long, { status: 'done', text: '第一部分\n\n第二部分' });
  });

  it('rejects an incomplete terminal mapping without replacing streamed successes', async () => {
    const { session, clients, id, partial, onSegment } = setup();
    const passages = [segment('success'), segment('missing')];
    session.start(passages); await flush(); partial(0, 0, '已完成');
    clients[0]!.receive({ type: 'result', requestId: id(), result: { kind: 'text', translation: 'bad', segments: ['wrong count'] } }); await flush();
    expect(session.state).toMatchObject({ status: 'done', completed: 1, failed: 1 });
    expect(onSegment).toHaveBeenCalledWith(passages[0], { status: 'done', text: '已完成' });
  });

  it('keeps the lifetime acceptance bound after stale paragraphs are pruned', async () => {
    const { session } = setup();
    const first = Array.from({ length: MAX_PAGE_SEGMENTS }, (_, index) => segment(`paragraph ${index}`));
    session.start(first); for (const item of first) fixtures.stale.add(item);
    session.append([segment('beyond the lifetime bound')]);
    expect(session.state).toMatchObject({ total: 0, skipped: MAX_PAGE_SEGMENTS, limitReached: true });
    session.dispose(); await flush();
  });

  it('reports the limit without accepting excess paragraphs', () => {
    const { session } = setup();
    session.start(Array.from({ length: MAX_PAGE_SEGMENTS + 1 }, (_, index) => segment(`paragraph ${index}`)));
    expect(session.state).toMatchObject({ total: MAX_PAGE_SEGMENTS, limitReached: true }); session.dispose();
  });

  it('reset clears retained results and invalidates active callbacks', async () => {
    const { session, clients, id, onSegment, requests } = setup();
    session.start([segment('old paragraph')]); await flush(); const old = id(); session.reset();
    expect(session.state).toEqual({ status: 'idle', total: 0, completed: 0, failed: 0, skipped: 0, pending: 0, limitReached: false, error: undefined });
    const rendered = onSegment.mock.calls.length;
    clients[0]!.receive({ type: 'segment', requestId: old, index: 0, text: '旧结果' });
    expect(onSegment).toHaveBeenCalledTimes(rendered);
    session.start([segment('old paragraph')]); await flush(); expect(requests()).toHaveLength(2);
  });

  it('reuses successful text after hiding while releasing paragraph identities', async () => {
    const { session, requests, done, onSegment } = setup();
    session.start([segment('Same paragraph.')]); await flush(); done(0, ['相同段落']); await flush();
    session.reset({ clearCache: false });
    expect(session.state).toMatchObject({ status: 'idle', total: 0 });
    const replacement = segment('Same paragraph.'); session.start([replacement]); await flush();
    expect(requests()).toHaveLength(1);
    expect(session.state).toMatchObject({ status: 'done', total: 1, completed: 1, pending: 0 });
    expect(onSegment).toHaveBeenCalledWith(replacement, { status: 'done', text: '相同段落' });
  });

  it('returns detached translation snapshots that cannot mutate the owned cache', async () => {
    const { session, done } = setup();
    session.start([segment('Original paragraph')]); await flush(); done(0, ['原段落']); await flush();
    const snapshot = session.translationSnapshot as Map<string, string>;
    expect(snapshot.get('Original paragraph')).toBe('原段落');
    snapshot.set('Original paragraph', '被修改'); snapshot.set('Injected paragraph', '外部注入');
    expect([...session.translationSnapshot]).toEqual([['Original paragraph', '原段落']]);
    snapshot.clear();
    expect(session.translationSnapshot.size).toBe(1);
    session.reset();
    expect(session.translationSnapshot.size).toBe(0); session.dispose();
  });

  it('seeds a new idle view without requests and renders cached text only on explicit start', async () => {
    const { session, requests, onChange, onSegment } = setup();
    const entries = new Map([['First paragraph', '第一段'], ['Second paragraph', '第二段']]);
    session.seedTranslations(entries); entries.clear();
    expect(session.state.status).toBe('idle'); expect(onChange).not.toHaveBeenCalled();
    expect(onSegment).not.toHaveBeenCalled(); expect(requests()).toHaveLength(0);
    const first = segment('First paragraph'); const second = segment('Second paragraph');
    session.start([first, second]); await flush();
    expect(requests()).toHaveLength(0);
    expect(session.state).toMatchObject({ status: 'done', total: 2, completed: 2, pending: 0 });
    expect(onSegment).toHaveBeenCalledWith(first, { status: 'done', text: '第一段' });
    expect(onSegment).toHaveBeenCalledWith(second, { status: 'done', text: '第二段' }); session.dispose();
  });

  it('requests only paragraphs missing from a seeded view', async () => {
    const { session, requests, input, done, onSegment } = setup();
    const cached = segment('Cached paragraph'); const missing = segment('Missing paragraph');
    session.seedTranslations(new Map([[cached.text, '已有译文']]));
    session.start([cached, missing]); await flush();
    expect(requests()).toHaveLength(1); expect(input().pageSegments).toEqual([missing.text]);
    expect(onSegment).toHaveBeenCalledWith(cached, { status: 'done', text: '已有译文' });
    done(0, ['新译文']); await flush();
    expect(session.state).toMatchObject({ status: 'done', total: 2, completed: 2 });
    expect(onSegment).toHaveBeenCalledWith(missing, { status: 'done', text: '新译文' }); session.dispose();
  });

  it('reuses a complete seeded paragraph longer than one request without splitting or requests', async () => {
    const { session, requests, onSegment } = setup();
    const text = 'a'.repeat(MAX_TEXT_LENGTH + 1); const translation = '完整译文'.repeat(4_001);
    const paragraph = segment(text);
    session.seedTranslations(new Map([[text, translation]])); session.start([paragraph]); await flush();
    expect(requests()).toHaveLength(0);
    expect(session.state).toMatchObject({ status: 'done', total: 1, completed: 1, pending: 0 });
    expect(onSegment).toHaveBeenCalledExactlyOnceWith(paragraph, { status: 'done', text: translation }); session.dispose();
  });

  it('ignores invalid seeded text', () => {
    const { session } = setup();
    const entries = new Map<unknown, unknown>([
      ['', 'empty source'], ['  \n', 'blank source'], [7, 'numeric source'],
      ['empty translation', ''], ['blank translation', '  \n'], ['numeric translation', 7],
      ['Valid paragraph', '有效译文'],
    ]);
    session.seedTranslations(entries as ReadonlyMap<string, string>);
    expect([...session.translationSnapshot]).toEqual([['Valid paragraph', '有效译文']]);
    session.dispose();
  });

  it('accepts the exact two-MiB entry budget and rejects an oversized source or translation', () => {
    const { session } = setup(); const boundary = 'a'.repeat(1_048_575);
    session.seedTranslations(new Map([[boundary, '译']]));
    expect(session.translationSnapshot.get(boundary)).toBe('译');
    session.seedTranslations(new Map([
      ['b'.repeat(1_048_576), '译'], ['oversized translation', '中'.repeat(1_048_576)],
    ]));
    expect([...session.translationSnapshot]).toEqual([[boundary, '译']]); session.dispose();
  });

  it('keeps seeded entries within the existing item and byte budgets', () => {
    const { session } = setup();
    session.seedTranslations(new Map(Array.from({ length: MAX_PAGE_SEGMENTS + 1 }, (_, index) => [`source ${index}`, `译文 ${index}`])));
    expect(session.translationSnapshot.size).toBe(MAX_PAGE_SEGMENTS);
    expect(session.translationSnapshot.has('source 0')).toBe(false);
    session.reset();
    session.seedTranslations(new Map(['first', 'second', 'third'].map(text => [text, '中'.repeat(400_000)])));
    expect([...session.translationSnapshot.keys()]).toEqual(['second', 'third']); session.dispose();
  });

  it('ignores seeding after start, cancel, completion or disposal', async () => {
    const { session, requests, done, onSegment } = setup(); const paragraph = segment('Active paragraph');
    session.start([paragraph]); await flush();
    session.seedTranslations(new Map([[paragraph.text, '不应覆盖任务']]));
    expect(session.translationSnapshot.size).toBe(0); expect(session.state.status).toBe('running');
    expect(onSegment).not.toHaveBeenCalledWith(paragraph, { status: 'done', text: '不应覆盖任务' });
    done(0, ['真实结果']); await flush();
    session.seedTranslations(new Map([[paragraph.text, '不应覆盖完成结果']]));
    expect(session.translationSnapshot.get(paragraph.text)).toBe('真实结果');
    session.cancel(); session.seedTranslations(new Map([['Stopped paragraph', '不应注入']]));
    expect(session.translationSnapshot.has('Stopped paragraph')).toBe(false);
    session.dispose(); session.seedTranslations(new Map([['Disposed paragraph', '不应注入']]));
    expect(session.translationSnapshot.size).toBe(0); expect(requests()).toHaveLength(1);
  });

  it('clears seeded results on the existing default and explicit clear-cache resets', async () => {
    const { session, requests } = setup(); const entries = new Map([['Seeded paragraph', '已有译文']]);
    session.seedTranslations(entries); session.reset({ clearCache: true });
    expect(session.translationSnapshot.size).toBe(0);
    session.start([segment('Seeded paragraph')]); await flush(); expect(requests()).toHaveLength(1);
    session.reset(); session.seedTranslations(entries); session.reset();
    expect(session.translationSnapshot.size).toBe(0);
    session.start([segment('Seeded paragraph')]); await flush(); expect(requests()).toHaveLength(2); session.dispose();
  });

  it('requests changed text and invalidates warm results on an explicit reset', async () => {
    const { session, requests, done } = setup();
    session.start([segment('Original text')]); await flush(); done(); await flush();
    session.reset({ clearCache: false }); session.start([segment('Changed text')]); await flush();
    expect(requests()).toHaveLength(2); done(); await flush();
    session.reset(); session.start([segment('Original text')]); await flush();
    expect(requests()).toHaveLength(3);
    session.dispose();
  });

  it('never warms incomplete long paragraphs or canceled late results', async () => {
    const { session, requests, input, clients, id, partial, fail, done } = setup();
    const text = 'a'.repeat(1_600) + 'b'.repeat(1_600);
    session.start([segment(text)], { concurrency: 1 }); await flush();
    partial(0, 0, '只有一半'); done(); await flush(); fail(); await flush();
    const old = id(); session.reset({ clearCache: false });
    clients[0]!.receive({ type: 'result', requestId: old, result: { kind: 'text', translation: '迟到', segments: ['迟到'] } });
    session.start([segment(text)], { concurrency: 1 }); await flush();
    expect(requests()).toHaveLength(3);
    expect(input().pageSegments).toEqual(['a'.repeat(1_600)]);
    done(); await flush(); done(); await flush();
    session.reset({ clearCache: false }); session.start([segment(text)]); await flush();
    expect(requests()).toHaveLength(4);
    expect(session.state.completed).toBe(1);
  });

  it('evicts old successful text when the in-memory character budget is exceeded', async () => {
    const { session, requests, done } = setup();
    for (const text of ['first', 'second', 'third']) {
      session.start([segment(text)]); await flush(); done(0, ['中'.repeat(400_000)]); await flush();
    }
    session.reset({ clearCache: false }); session.start([segment('second')]); await flush();
    expect(requests()).toHaveLength(3);
    session.start([segment('first')]); await flush();
    expect(requests()).toHaveLength(4); session.dispose();
  });

  it('disposes every transport and suppresses late callbacks', async () => {
    const { session, clients, id, onChange, onSegment } = setup();
    session.start([segment('paragraph')]); await flush(); const old = id(); session.dispose();
    const rendered = onSegment.mock.calls.length; const changes = onChange.mock.calls.length;
    clients[0]!.receive({ type: 'segment', requestId: old, index: 0, text: '迟到' });
    session.start([segment('ignored')]); await flush();
    expect(clients.every(client => client.dispose.mock.calls.length === 1)).toBe(true);
    expect(onSegment).toHaveBeenCalledTimes(rendered); expect(onChange).toHaveBeenCalledTimes(changes);
  });
});

describe('userscript workload producer policy', () => {
  const policy = userscriptPageExecutionPolicy('deepl-web');
  const passage = (index: number, length = 800) => segment(`${index}:`.padEnd(length, 'x'));

  async function drain(fixture: ReturnType<typeof setup>, finished = new Set<string>()): Promise<void> {
    for (let pass = 0; fixture.session.state.status === 'running' && pass < MAX_PAGE_SEGMENTS; pass++) {
      for (let worker = 0; worker < fixture.clients.length; worker++) {
        const requestId = fixture.clients[worker]!.start.mock.results.at(-1)?.value;
        if (!requestId || finished.has(requestId)) continue;
        finished.add(requestId); fixture.done(worker);
      }
      await flush();
    }
  }

  it('sends one small-page batch at a time and finishes immediately after the final valid result', async () => {
    const fixture = setup();
    const passages = Array.from({ length: 4 }, (_, index) => passage(index));
    fixture.session.start(passages, policy); await flush();
    expect(fixture.requests()).toHaveLength(1);
    fixture.done(); await flush();
    expect(fixture.requests()).toHaveLength(2);
    expect(fixture.session.state).toMatchObject({ status: 'running', completed: 1, pending: 3 });
    await drain(fixture, new Set(['request-1']));
    expect(fixture.requests().map(input => input.pageSegments)).toEqual(passages.map(source => [source.text]));
    expect(fixture.session.state).toMatchObject({ status: 'done', completed: 4, pending: 0, failed: 0 });
    fixture.session.dispose();
  });

  it('keeps eight producers for a shape that cannot fit into eight requests', async () => {
    const fixture = setup();
    const passages = Array.from({ length: 9 }, (_, index) => passage(index));
    fixture.session.start(passages, policy); await flush();
    expect(fixture.requests()).toHaveLength(8);
    fixture.done(); await flush();
    expect(fixture.requests()).toHaveLength(9);
    await drain(fixture, new Set(['request-1']));
    expect(fixture.session.state).toMatchObject({ status: 'done', completed: 9, pending: 0 });
    expect(fixture.requests().flatMap(input => input.pageSegments!)).toEqual(expect.arrayContaining(passages.map(source => source.text)));
    fixture.session.dispose();
  });

  it('deduplicates equal source text before resolving the workload', async () => {
    const fixture = setup();
    const resolveConcurrency = vi.fn(policy.resolveConcurrency!);
    fixture.session.start(Array.from({ length: 1_000 }, () => segment('same')), { ...policy, resolveConcurrency });
    expect(resolveConcurrency).toHaveBeenCalledExactlyOnceWith([4]);
    await flush();
    expect(fixture.requests()).toHaveLength(1);
    fixture.done(); await flush();
    expect(fixture.session.state).toMatchObject({ status: 'done', total: 1_000, completed: 1_000, pending: 0 });
    fixture.session.dispose();
  });

  it('counts the true split lengths of cached whole-text successes when deciding the article tier', async () => {
    const fixture = setup();
    const cached = 'a'.repeat(20_000);
    fixture.session.seedTranslations(new Map([[cached, '已有长段译文']]));
    const resolveConcurrency = vi.fn(policy.resolveConcurrency!);
    const remaining = Array.from({ length: 8 }, (_, index) => passage(index));
    fixture.session.start([segment(cached), ...remaining], { ...policy, resolveConcurrency });
    expect(resolveConcurrency).toHaveBeenCalledExactlyOnceWith([
      ...splitPageBatchText(cached, 1_500).map(text => text.length), ...remaining.map(source => source.text.length),
    ]);
    await flush();
    expect(fixture.requests()).toHaveLength(8);
    expect(fixture.requests().some(input => input.pageSegments!.includes(cached))).toBe(false);
    await drain(fixture);
    expect(fixture.session.state).toMatchObject({ status: 'done', completed: 9, pending: 0 });
    fixture.session.dispose();
  });

  it('promotes a growing page without resetting, canceling or repeating the existing request', async () => {
    const fixture = setup();
    fixture.session.start([passage(0), passage(1)], policy); await flush();
    const firstId = fixture.id();
    const cancellations = fixture.clients.map(client => client.cancel.mock.calls.length);
    fixture.session.append(Array.from({ length: 8 }, (_, index) => passage(index + 2))); await flush();
    expect(fixture.requests()).toHaveLength(8);
    expect(fixture.id()).toBe(firstId);
    expect(fixture.clients.map(client => client.cancel.mock.calls.length)).toEqual(cancellations);
    await drain(fixture);
    expect(fixture.requests()).toHaveLength(10);
    expect(fixture.session.state).toMatchObject({ status: 'done', total: 10, completed: 10, pending: 0 });
    fixture.session.dispose();
  });

  it('retains 193 completed sources and the large-article tier when retrying only the remaining 58', async () => {
    const fixture = setup();
    const completed = Array.from({ length: 193 }, (_, index) => segment(`Completed public source ${index}.`));
    fixture.session.seedTranslations(new Map(completed.map(source => [source.text, '已有译文'])));
    const pending = Array.from({ length: 58 }, (_, index) => passage(index, 900));
    const resolveConcurrency = vi.fn(policy.resolveConcurrency!);
    fixture.session.start([...completed, ...pending], { ...policy, resolveConcurrency }); await flush();
    expect(fixture.requests()).toHaveLength(8);
    expect(fixture.session.state).toMatchObject({ completed: 193, pending: 58 });
    fixture.session.cancel();
    const canceled = new Set(fixture.clients.flatMap(client => client.start.mock.results.map(result => result.value)));
    fixture.session.retryFailed(); await flush();
    expect(fixture.requests()).toHaveLength(16);
    expect(resolveConcurrency).toHaveBeenCalledTimes(1);
    expect(fixture.requests().every(input => input.pageSegments!.every(text => pending.some(source => source.text === text)))).toBe(true);
    await drain(fixture, canceled);
    expect(fixture.session.state).toMatchObject({ status: 'done', total: 251, completed: 251, pending: 0, failed: 0 });
    fixture.session.dispose();
  });

  it('does not dispatch after the resolver synchronously cancels the owning generation', async () => {
    const fixture = setup();
    fixture.session.start([passage(0), passage(1)], { ...policy, resolveConcurrency: () => {
      fixture.session.cancel(); return 8;
    } });
    await flush();
    expect(fixture.requests()).toHaveLength(0);
    expect(fixture.session.state).toMatchObject({ status: 'stopped', pending: 2 });
    fixture.session.dispose();
  });

  it('keeps the default extension and model policies free of workload hooks', async () => {
    for (const engine of ['deepl-web', 'model'] as const) {
      const fixture = setup();
      const defaultPolicy = pageExecutionPolicy(engine);
      fixture.session.start(Array.from({ length: 40 }, (_, index) => passage(index, 1_000)), defaultPolicy); await flush();
      expect(fixture.requests()).toHaveLength(defaultPolicy.concurrency);
      fixture.session.dispose();
    }
  });
});
