import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranslationError, TranslationInput, TranslationServerMessage } from '../../src/shared/contracts';
import type { PageSegment } from '../../src/page/segments';
import { pageExecutionPolicy, userscriptPageExecutionPolicy } from '../../src/shared/translation-policy';
import { DEEPL_USERSCRIPT_SCHEDULING } from '../../src/shared/translation-policy';
import { DeepLWebProvider, type DeepLWebTransport } from '../../src/providers/deepl-web';
import { toTranslationError } from '../../src/core/errors';

vi.mock('../../src/platform/translation-client', () => ({ TranslationClient: class {} }));
import { PageTranslationSession } from '../../src/page/session';

const policy = userscriptPageExecutionPolicy('deepl-web');
const source = (index: number, length = 900): PageSegment => ({
  text: `${index}:`.padEnd(length, 'x'), nodes: [{} as Text], anchor: {} as Node, container: {} as HTMLElement,
});
const flush = async () => { for (let index = 0; index < 4; index++) await Promise.resolve(); };
const limited = (delay = 60_000): TranslationError => ({ code: 'RATE_LIMIT', message: 'Service limited.', retryable: true, retryAt: Date.now() + delay });

function fixture() {
  const requests: Array<{ input: TranslationInput; id: string; receive: (message: TranslationServerMessage) => void; canceled: boolean; settled: boolean }> = [];
  const onChange = vi.fn(), onSegment = vi.fn(), isCurrent = vi.fn(() => true);
  const session = new PageTranslationSession({ onChange, onSegment, isCurrent }, receive => {
    let latest: typeof requests[number] | undefined;
    return {
      start(input) { latest = { input, id: `request-${requests.length + 1}`, receive, canceled: false, settled: false }; requests.push(latest); return latest.id; },
      cancel() { if (latest && !latest.settled) latest.canceled = true; },
      dispose() {},
    };
  });
  const complete = (index: number) => {
    const request = requests[index]!; request.settled = true;
    const segments = request.input.pageSegments!.map(() => '完整译文');
    request.receive({ type: 'result', requestId: request.id, result: { kind: 'text', translation: segments.join('\n'), segments } });
  };
  const fail = (index: number, error = limited()) => {
    const request = requests[index]!; request.settled = true;
    request.receive({ type: 'error', requestId: request.id, error });
  };
  const drain = async () => {
    for (let pass = 0; pass < 100 && session.state.status === 'running' && session.state.waitingUntil === undefined; pass++) {
      requests.forEach((request, index) => { if (!request.canceled && !request.settled) complete(index); });
      await flush();
    }
  };
  return { session, requests, complete, fail, drain, onChange, onSegment, isCurrent };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_700_000_000_000); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('opted-in DeepL automatic page recovery', () => {
  it('retains 193 completed sources, waits until the exact deadline, and resumes only the remaining 58', async () => {
    const f = fixture();
    const done = Array.from({ length: 193 }, (_, index) => source(index, 40));
    const remaining = Array.from({ length: 58 }, (_, index) => source(index + 193));
    f.session.seedTranslations(new Map(done.map(segment => [segment.text, '已有译文'])));
    f.session.start([...done, ...remaining], policy); await flush();
    expect(f.requests).toHaveLength(8);
    const error = limited(); f.fail(0, error);
    expect(f.session.state).toMatchObject({ status: 'running', completed: 193, pending: 58, failed: 0,
      waitingUntil: error.retryAt, automaticRecoveryAttempts: 1, error });
    expect(f.requests.slice(1).every(request => request.canceled)).toBe(true);
    f.complete(1); expect(f.session.state.completed).toBe(193);
    await vi.advanceTimersByTimeAsync(59_999); expect(f.requests).toHaveLength(8);
    await vi.advanceTimersByTimeAsync(1); expect(f.requests).toHaveLength(16);
    expect(f.session.state.waitingUntil).toBeUndefined();
    await f.drain();
    expect(f.session.state).toMatchObject({ status: 'done', total: 251, completed: 251, pending: 0, failed: 0, automaticRecoveryAttempts: 1 });
    const resumed = f.requests.slice(8).flatMap(request => request.input.pageSegments!);
    expect(resumed).toHaveLength(58);
    expect(new Set(resumed)).toEqual(new Set(remaining.map(segment => segment.text)));
    f.session.dispose();
  });

  it('arms one timer for concurrent peer failures and honors a later shared cooldown rejection', async () => {
    const f = fixture(); f.session.start(Array.from({ length: 9 }, (_, index) => source(index)), policy); await flush();
    const first = limited(1_000); f.fail(0, first); f.fail(1, limited(120_000));
    expect(f.session.state).toMatchObject({ waitingUntil: first.retryAt, automaticRecoveryAttempts: 1 });
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    const later = limited(120_000); f.fail(8, later);
    expect(f.session.state).toMatchObject({ waitingUntil: later.retryAt, automaticRecoveryAttempts: 2 });
    const starts = f.requests.length;
    await vi.advanceTimersByTimeAsync(119_999); expect(f.requests).toHaveLength(starts);
    await vi.advanceTimersByTimeAsync(1); expect(f.requests.length).toBeGreaterThan(starts);
    await f.drain(); expect(f.session.state).toMatchObject({ status: 'done', completed: 9 });
    f.session.dispose();
  });

  it.each(['cancel', 'reset', 'dispose', 'start'] as const)('never revives an old wait after %s, even when its stale callback runs', async action => {
    const timer = vi.spyOn(globalThis, 'setTimeout');
    const f = fixture(); f.session.start([source(1)], policy); await flush(); f.fail(0, limited(1_000));
    const stale = timer.mock.calls.at(-1)![0] as () => void;
    if (action === 'start') f.session.start([source(2)], policy); else f.session[action]();
    await flush(); const starts = f.requests.length;
    stale(); await vi.advanceTimersByTimeAsync(60_000);
    expect(f.requests).toHaveLength(starts); expect(f.session.state.waitingUntil).toBeUndefined();
    if (action === 'cancel' || action === 'reset') expect(f.session.state.status).not.toBe('running');
    if (action === 'dispose') expect(f.session.state.total).toBe(0);
    f.session.dispose();
  });

  it('allows three automatic recoveries, then requires a new explicit retry intent', async () => {
    const f = fixture(); f.session.start([source(1)], policy); await flush();
    for (let attempt = 1; attempt <= 3; attempt++) {
      f.fail(f.requests.length - 1, limited(1_000));
      expect(f.session.state).toMatchObject({ status: 'running', automaticRecoveryAttempts: attempt });
      await vi.advanceTimersByTimeAsync(1_000); expect(f.requests).toHaveLength(attempt + 1);
    }
    f.fail(3, limited(1_000));
    expect(f.session.state).toMatchObject({ status: 'stopped', automaticRecoveryAttempts: 3 });
    expect(f.session.state.waitingUntil).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000); expect(f.requests).toHaveLength(4);
    f.session.retryFailed(); await flush(); expect(f.requests).toHaveLength(5);
    expect(f.session.state.automaticRecoveryAttempts).toBe(0);
    f.fail(4, limited(1_000)); expect(f.session.state.automaticRecoveryAttempts).toBe(1);
    f.session.dispose();
  });

  it('never shortens a server deadline beyond the fifteen-minute window', async () => {
    const f = fixture(); f.session.start([source(1)], policy); await flush(); const error = limited(900_001); f.fail(0, error);
    expect(f.session.state).toMatchObject({ status: 'stopped', error, automaticRecoveryAttempts: 0 });
    expect(f.session.state.waitingUntil).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000_000); expect(f.requests).toHaveLength(1);
    f.session.dispose();
  });

  it('accepts the full fifteen-minute deadline but cannot resume after a late background callback exceeds the window', async () => {
    const timer = vi.spyOn(globalThis, 'setTimeout');
    const f = fixture(); f.session.start([source(1)], policy); await flush(); f.fail(0, limited(900_000));
    expect(f.session.state.waitingUntil).toBe(Date.now() + 900_000);
    const stale = timer.mock.calls.at(-1)![0] as () => void;
    vi.setSystemTime(Date.now() + 900_001); stale(); await flush();
    expect(f.session.state.status).toBe('stopped'); expect(f.session.state.waitingUntil).toBeUndefined();
    expect(f.requests).toHaveLength(1); f.session.dispose();
  });

  it.each([
    { code: 'CONFIG' }, { code: 'AUTH' }, { code: 'INVALID_RESPONSE' }, { code: 'NETWORK' }, { code: 'TIMEOUT' },
    { code: 'RATE_LIMIT', retryAt: undefined }, { code: 'RATE_LIMIT', retryAt: NaN },
    { code: 'RATE_LIMIT', retryAt: Infinity }, { code: 'RATE_LIMIT', retryAt: -1 },
    { code: 'RATE_LIMIT', retryable: false, retryAt: 1_700_000_060_000 },
  ] as const)('does not automatically retry a nonqualifying error $code/$retryAt', async override => {
    const f = fixture(); f.session.start([source(1)], policy); await flush();
    f.fail(0, { message: 'Failure.', retryable: true, serviceWide: true, ...override });
    expect(f.session.state.status).toBe('stopped'); expect(f.session.state.waitingUntil).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000_000); expect(f.requests).toHaveLength(1); f.session.dispose();
  });

  it('does not retry an earlier invalid-response part while recovering other rate-limited work', async () => {
    const f = fixture(); f.session.start([source(0), source(1), source(2)], { ...policy, concurrency: 1, batchMaxItems: 1 }); await flush();
    f.fail(0, { code: 'INVALID_RESPONSE', message: 'Invalid.', retryable: true }); await flush();
    f.fail(1, limited(1_000)); await vi.advanceTimersByTimeAsync(1_000); await f.drain();
    expect(f.session.state).toMatchObject({ status: 'done', completed: 2, failed: 1, pending: 0 });
    expect(f.requests.slice(2).every(request => !request.input.pageSegments!.includes(source(0).text))).toBe(true);
    f.session.dispose();
  });

  it('honors Stop callbacks both while pausing and while revalidating sources at resume', async () => {
    for (const point of ['pause', 'resume']) {
      const f = fixture(); f.session.start([source(1)], policy); await flush();
      if (point === 'pause') f.onSegment.mockImplementation((_segment, view) => { if (view.status === 'stopped') f.session.cancel(); });
      f.fail(0, limited(1_000));
      if (point === 'resume') {
        f.isCurrent.mockReturnValue(false);
        f.onSegment.mockImplementation((_segment, view) => { if (view.status === 'stopped') f.session.cancel(); });
      }
      await vi.advanceTimersByTimeAsync(1_000);
      expect(f.session.state.status).toBe('stopped'); expect(f.requests).toHaveLength(1);
      expect(f.session.state.waitingUntil).toBeUndefined(); f.session.dispose();
    }
  });

  it.each(['deepl-web', 'model'] as const)('preserves the manual-only default %s path', async engine => {
    const f = fixture(); f.session.start([source(1)], pageExecutionPolicy(engine)); await flush(); f.fail(0);
    expect(f.session.state.status).toBe('stopped');
    expect(f.session.state.waitingUntil).toBeUndefined(); expect(f.session.state.automaticRecoveryAttempts).toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000); expect(f.requests).toHaveLength(1); f.session.dispose();
  });

  it('uses the existing provider half-open gate for one actual unfinished batch before releasing recovery peers', async () => {
    let release!: (response: Response) => void;
    const probe = new Promise<Response>(resolve => { release = resolve; });
    const reply = (body: string) => new Response(JSON.stringify({ translations: JSON.parse(body).text.map(() => ({ text: '完整译文' })) }));
    const transport = vi.fn<DeepLWebTransport>().mockImplementation(async body => {
      if (transport.mock.calls.length === 1) return new Response('{}', { status: 429 });
      if (transport.mock.calls.length === 2) return probe;
      return reply(body);
    });
    const provider = new DeepLWebProvider(transport, DEEPL_USERSCRIPT_SCHEDULING);
    let serial = 0;
    const session = new PageTranslationSession({ onChange() {}, onSegment() {}, isCurrent: () => true }, receive => {
      let controller: AbortController | undefined;
      return {
        start(input) {
          const id = `provider-${++serial}`, owner = new AbortController(); controller = owner;
          void (async () => {
            try {
              for await (const event of provider.translate(input, owner.signal)) {
                if (event.type === 'result') receive({ type: 'result', requestId: id, result: event.result });
              }
            } catch (error) { if (!owner.signal.aborted) receive({ type: 'error', requestId: id, error: toTranslationError(error) }); }
          })();
          return id;
        },
        cancel() { controller?.abort(); }, dispose() { controller?.abort(); },
      };
    });
    const completed = Array.from({ length: 193 }, (_, index) => source(index, 40));
    const remaining = Array.from({ length: 58 }, (_, index) => source(index + 193));
    session.seedTranslations(new Map(completed.map(segment => [segment.text, '已有译文'])));
    session.start([...completed, ...remaining], policy); await vi.advanceTimersByTimeAsync(0);
    expect(session.state).toMatchObject({ status: 'running', completed: 193, pending: 58, automaticRecoveryAttempts: 1 });
    expect(session.state.waitingUntil).toBe(Date.now() + 10_000);
    await vi.advanceTimersByTimeAsync(10_000); expect(transport).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000); expect(transport).toHaveBeenCalledTimes(2);
    release(reply(transport.mock.calls[1]![0]));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(session.state).toMatchObject({ status: 'done', completed: 251, pending: 0, failed: 0 });
    expect(transport).toHaveBeenCalledTimes(59);
    expect(transport.mock.calls.every(([body]) => JSON.parse(body).text.every((text: string) => remaining.some(segment => segment.text === text)))).toBe(true);
    session.dispose();
  });
});
