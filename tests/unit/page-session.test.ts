import { describe, expect, it, vi } from 'vitest';
import type { TranslationInput, TranslationServerMessage } from '../../src/shared/contracts';
import type { PageSegment } from '../../src/page/segments';
import { PAGE_BATCH_MAX_ITEMS, PAGE_BATCH_TARGET_CHARS, PAGE_CONCURRENCY } from '../../src/page/batches';

const fixtures = vi.hoisted(() => ({ stale: new WeakSet<object>() }));
vi.mock('../../src/platform/translation-client', () => ({ TranslationClient: vi.fn() }));
vi.mock('../../src/page/segments', () => ({ segmentIsCurrent: (segment: object) => !fixtures.stale.has(segment) }));
import { MAX_PAGE_SEGMENTS, PageTranslationSession } from '../../src/page/session';

function segment(text: string): PageSegment {
  return { text, nodes: [{} as Text], anchor: {} as Node, container: {} as HTMLElement };
}
function setup() {
  let serial = 0;
  const clients: Array<{
    start: ReturnType<typeof vi.fn<(input: TranslationInput) => string>>;
    cancel: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    receive: (event: TranslationServerMessage) => void;
  }> = [];
  const onChange = vi.fn();
  const onSegment = vi.fn();
  const session = new PageTranslationSession({ onChange, onSegment }, receive => {
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
  const fail = (worker = 0, code: 'SERVER' | 'RATE_LIMIT' | 'AUTH' = 'SERVER') => clients[worker]!.receive({
    type: 'error', requestId: id(worker), error: { code, message: code, retryable: code !== 'AUTH' },
  });
  const requests = () => clients.flatMap(client => client.start.mock.calls.map(([request]) => request));
  return { session, clients, input, id, partial, done, fail, requests, onChange, onSegment };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
const wide = (index: number) => segment(`${index}:` + 'a'.repeat(900));

describe('batched page translation session', () => {
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
    expect(session.state).toMatchObject({ status: 'stopped', failed: 1, pending: PAGE_CONCURRENCY + 2, error: { code: 'RATE_LIMIT' } });
    session.append([segment('new dynamic paragraph')]); await flush();
    expect(requests()).toHaveLength(PAGE_CONCURRENCY);
    expect(clients.every(client => client.cancel.mock.calls.length >= 2)).toBe(true);
    session.retryFailed(); await flush();
    expect(requests()).toHaveLength(PAGE_CONCURRENCY * 2);
    expect(session.state.error).toBeUndefined(); session.dispose();
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
