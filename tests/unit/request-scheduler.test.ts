import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequestScheduler, type RequestContext } from '../../src/providers/request-scheduler';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function fakeTime() { vi.useFakeTimers(); vi.setSystemTime(1000); }
const signal = () => new AbortController().signal;
afterEach(() => { vi.useRealTimers(); });

describe('RequestScheduler bounded execution ownership', () => {
  it('shares read-only cooldown restoration without admitting work or allocating start timers', async () => {
    fakeTime();
    const restored = deferred<number>();
    const loadCooldownUntil = vi.fn(() => restored.promise);
    const scheduler = new RequestScheduler<number>({ loadCooldownUntil });
    const first = scheduler.getCooldownUntil();
    const second = scheduler.getCooldownUntil();
    await Promise.resolve();
    expect(loadCooldownUntil).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    restored.resolve(61_000);
    expect(await Promise.all([first, second])).toEqual([61_000, 61_000]);
    await expect(scheduler.getCooldownUntil()).resolves.toBe(61_000);
    expect(loadCooldownUntil).toHaveBeenCalledOnce();
    const execute = vi.fn(() => 1);
    await expect(scheduler.run(execute, signal())).rejects.toMatchObject({ kind: 'RATE_LIMIT' });
    expect(execute).not.toHaveBeenCalled(); scheduler.dispose();
  });

  it('does not spend or reset either start budget when service status is read', async () => {
    fakeTime();
    const scheduler = new RequestScheduler<number>({ intervalMs: 100, startWindow: { maxStarts: 1, durationMs: 1_000 },
      loadCooldownUntil: async () => 0 });
    const execute = vi.fn(() => 1);
    expect(await scheduler.getCooldownUntil()).toBe(0);
    expect(execute).not.toHaveBeenCalled();
    expect(await scheduler.run(execute, signal())).toBe(1);
    await Promise.all(Array.from({ length: 5 }, () => scheduler.getCooldownUntil()));
    const next = scheduler.run(execute, signal());
    await vi.advanceTimersByTimeAsync(999); expect(execute).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(await next).toBe(1);
    expect(execute).toHaveBeenCalledTimes(2); scheduler.dispose();
  });

  it('fails closed on a status-read restoration failure rather than reporting zero cooldown', async () => {
    const loadCooldownUntil = vi.fn(async () => { throw new Error('private storage detail'); });
    const scheduler = new RequestScheduler<number>({ loadCooldownUntil });
    await expect(scheduler.getCooldownUntil()).rejects.toMatchObject({ kind: 'LOAD_STATE' });
    const execute = vi.fn(() => 1);
    await expect(scheduler.run(execute, signal())).rejects.toMatchObject({ kind: 'LOAD_STATE' });
    expect(execute).not.toHaveBeenCalled(); expect(loadCooldownUntil).toHaveBeenCalledOnce(); scheduler.dispose();
  });

  it('supports zero interval without exceeding the 16-slot hard limit or reordering FIFO', async () => {
    fakeTime();
    const scheduler = new RequestScheduler<number>({ maxConcurrent: Infinity, intervalMs: 0 });
    const work = Array.from({ length: 17 }, () => deferred<number>());
    const starts: number[] = [];
    const pending = work.map((item, index) => scheduler.run(() => { starts.push(index); return item.promise; }, signal()));
    expect(starts).toEqual(Array.from({ length: 16 }, (_, index) => index));
    work[7]!.resolve(7);
    expect(await pending[7]).toBe(7);
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toEqual(Array.from({ length: 17 }, (_, index) => index));
    work.forEach((item, index) => item.resolve(index));
    expect(await Promise.all(pending)).toEqual(Array.from({ length: 17 }, (_, index) => index));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([undefined, -10, 0, NaN])('keeps invalid/default concurrency %s at one slot', async maxConcurrent => {
    const scheduler = new RequestScheduler<number>({ maxConcurrent });
    const work = deferred<number>();
    const start = vi.fn(() => 2);
    const first = scheduler.run(() => work.promise, signal());
    const second = scheduler.run(start, signal());
    expect(start).not.toHaveBeenCalled();
    work.resolve(1);
    expect(await first).toBe(1); expect(await second).toBe(2);
  });

  it.each([{ intervalMs: -1, gap: 0 }, { intervalMs: NaN, gap: 0 }, { intervalMs: Infinity, gap: 60000 }])(
    'bounds interval $intervalMs to $gap ms', async ({ intervalMs, gap }) => {
      fakeTime();
      const scheduler = new RequestScheduler<number>({ intervalMs });
      const starts: number[] = [];
      const run = () => scheduler.run(() => { starts.push(Date.now()); return starts.length; }, signal());
      expect(await run()).toBe(1);
      const second = run();
      if (gap) {
        await vi.advanceTimersByTimeAsync(gap - 1);
        expect(starts).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
      }
      expect(await second).toBe(2);
      expect(starts).toEqual([1000, 1000 + gap]);
    },
  );

  it('bounds the waiting queue independently of active slots and preserves synchronous execution failures', async () => {
    const scheduler = new RequestScheduler<number>({ maxQueuedRequests: 1 });
    const work = deferred<number>();
    const first = scheduler.run(() => work.promise, signal());
    const thrown = new Error('execution failure');
    const second = scheduler.run(() => { throw thrown; }, signal()).catch(error => error);
    await expect(scheduler.run(() => 3, signal())).rejects.toMatchObject({ kind: 'QUEUE_FULL' });
    work.resolve(1); expect(await first).toBe(1);
    expect(await second).toBe(thrown);
    expect(await scheduler.run(() => 4, signal())).toBe(4);
  });

  it('uses private abort signals and retains an ignored-abort execution slot until actual settlement', async () => {
    fakeTime();
    const scheduler = new RequestScheduler<number>({ intervalMs: 100 });
    const work = deferred<number>();
    const controller = new AbortController();
    let child!: AbortSignal;
    const first = scheduler.run(context => { child = context.signal; return work.promise; }, controller.signal).catch(error => error);
    const start = vi.fn(() => 2);
    const second = scheduler.run(start, signal());
    expect(child).not.toBe(controller.signal);
    controller.abort(); expect(await first).toMatchObject({ name: 'AbortError' });
    expect(child.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(start).not.toHaveBeenCalled();
    work.resolve(1);
    expect(await second).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('loads cooldown once, sharing a pending load while waiting callers can abort', async () => {
    fakeTime();
    const loaded = deferred<number>();
    const load = vi.fn(() => loaded.promise);
    const scheduler = new RequestScheduler<number>({ loadCooldownUntil: load });
    const controller = new AbortController();
    const start = vi.fn(() => 1);
    const first = scheduler.run(start, controller.signal).catch(error => error);
    const second = scheduler.run(() => 2, signal());
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledOnce(); expect(start).not.toHaveBeenCalled();
    controller.abort(); expect(await first).toMatchObject({ name: 'AbortError' });
    loaded.resolve(0);
    expect(await second).toBe(2);
    expect(await scheduler.run(() => 3, signal())).toBe(3);
    expect(load).toHaveBeenCalledOnce();
  });

  it.each(['throw', 'invalid'] as const)('fails closed after %s cooldown load without leaking storage details', async mode => {
    const load = vi.fn(async () => { if (mode === 'throw') throw new Error('private storage'); return NaN; });
    const scheduler = new RequestScheduler<number>({ loadCooldownUntil: load });
    const start = vi.fn(() => 1);
    for (let count = 0; count < 2; count++) {
      const error = await scheduler.run(start, signal()).catch(value => value);
      expect(error).toMatchObject({ kind: 'LOAD_STATE' });
      expect(error.message).not.toContain('private');
    }
    expect(load).toHaveBeenCalledOnce(); expect(start).not.toHaveBeenCalled();
  });

  it('establishes service pause, flushes the queue and aborts peers before awaiting persistence', async () => {
    fakeTime();
    const saved = deferred<void>();
    const peerWork = deferred<number>();
    const persist = vi.fn(() => saved.promise);
    const scheduler = new RequestScheduler<number>({ maxConcurrent: 2, persistCooldownUntil: persist });
    const caller = new AbortController();
    let peerSignal!: AbortSignal;
    const peer = scheduler.run(context => { peerSignal = context.signal; return peerWork.promise; }, caller.signal).catch(error => error);
    let context!: RequestContext;
    const currentWork = deferred<number>();
    const current = scheduler.run(value => { context = value; return currentWork.promise; }, signal());
    const queued = scheduler.run(() => 3, signal()).catch(error => error);
    const paused = context.pauseFor(1000);
    expect(await peer).toMatchObject({ kind: 'RATE_LIMIT' });
    expect(await queued).toMatchObject({ kind: 'RATE_LIMIT' });
    expect(peerSignal.aborted).toBe(true); expect(caller.signal.aborted).toBe(false);
    expect(context.signal.aborted).toBe(false);
    expect(persist).toHaveBeenCalledWith(2000);
    await expect(scheduler.run(() => 4, signal())).rejects.toMatchObject({ kind: 'RATE_LIMIT' });
    peerWork.resolve(1); saved.resolve(undefined); await paused;
    currentWork.resolve(2); expect(await current).toBe(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await scheduler.run(() => 5, signal())).toBe(5);
    expect(persist).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not reopen after deadline expiry while persistence is pending, and fails closed on save failure', async () => {
    fakeTime();
    const saved = deferred<void>();
    const scheduler = new RequestScheduler<number>({ maxConcurrent: 2, persistCooldownUntil: () => saved.promise });
    const currentWork = deferred<number>();
    let context!: RequestContext;
    const current = scheduler.run(value => { context = value; return currentWork.promise; }, signal());
    const paused = context.pauseFor(100).catch(error => error);
    await vi.advanceTimersByTimeAsync(100);
    const start = vi.fn(() => 2);
    const waiting = scheduler.run(start, signal()).catch(error => error);
    expect(start).not.toHaveBeenCalled();
    saved.reject(new Error('private write failure'));
    expect(await paused).toMatchObject({ kind: 'SAVE_STATE' });
    expect(await waiting).toMatchObject({ kind: 'SAVE_STATE' });
    await expect(scheduler.run(start, signal())).rejects.toMatchObject({ kind: 'SAVE_STATE' });
    expect(start).not.toHaveBeenCalled();
    currentWork.resolve(1); expect(await current).toBe(1);
  });

  it('makes disposal idempotent, cancels active and queued callers and removes the start timer', async () => {
    fakeTime();
    const scheduler = new RequestScheduler<number>({ maxConcurrent: 2, intervalMs: 100 });
    const work = deferred<number>();
    let child!: AbortSignal;
    const first = scheduler.run(context => { child = context.signal; return work.promise; }, signal()).catch(error => error);
    const start = vi.fn(() => 2);
    const second = scheduler.run(start, signal()).catch(error => error);
    expect(vi.getTimerCount()).toBe(1);
    scheduler.dispose(); scheduler.dispose();
    expect(await first).toMatchObject({ name: 'AbortError' });
    expect(await second).toMatchObject({ name: 'AbortError' });
    expect(child.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
    await expect(scheduler.run(start, signal())).rejects.toMatchObject({ kind: 'DISPOSED' });
    work.resolve(1); await vi.advanceTimersByTimeAsync(1000);
    expect(start).not.toHaveBeenCalled();
  });

  it('ignores stale completed-job pause handles instead of pausing later work', async () => {
    const scheduler = new RequestScheduler<number>();
    let context!: RequestContext;
    expect(await scheduler.run(value => { context = value; return 1; }, signal())).toBe(1);
    await expect(context.pauseFor(1000)).rejects.toMatchObject({ name: 'AbortError' });
    expect(await scheduler.run(() => 2, signal())).toBe(2);
  });
});

describe('RequestScheduler optional rolling start budget', () => {
  it('allows a bounded burst, then resumes FIFO exactly at the rolling window boundary', async () => {
    fakeTime();
    const scheduler = new RequestScheduler<number>({ maxConcurrent: 16, startWindow: { maxStarts: 3, durationMs: 1000 } });
    const starts: { index: number; at: number }[] = [];
    const pending = Array.from({ length: 7 }, (_, index) => scheduler.run(() => {
      starts.push({ index, at: Date.now() }); return index;
    }, signal()));
    await vi.advanceTimersByTimeAsync(0);
    expect(starts.map(item => item.index)).toEqual([0, 1, 2]);
    await vi.advanceTimersByTimeAsync(999);
    expect(starts).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(starts.map(item => item.index)).toEqual([0, 1, 2, 3, 4, 5]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await Promise.all(pending)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(starts.map(item => item.at)).toEqual([1000, 1000, 1000, 2000, 2000, 2000, 3000]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses the later of the interval and rolling budget without adding their waits', async () => {
    fakeTime();
    const scheduler = new RequestScheduler<number>({ maxConcurrent: 4, intervalMs: 300,
      startWindow: { maxStarts: 2, durationMs: 1000 } });
    const starts: number[] = [];
    const pending = Array.from({ length: 4 }, () => scheduler.run(() => {
      starts.push(Date.now()); return starts.length;
    }, signal()));
    await vi.advanceTimersByTimeAsync(1299);
    expect(starts).toEqual([1000, 1300, 2000]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await Promise.all(pending)).toEqual([1, 2, 3, 4]);
    expect(starts).toEqual([1000, 1300, 2000, 2300]);
  });

  it('does not refund active cancellation, consume a queued cancellation, or reset history when idle', async () => {
    fakeTime();
    const scheduler = new RequestScheduler<number>({ maxConcurrent: 1, startWindow: { maxStarts: 1, durationMs: 1000 } });
    const work = deferred<number>();
    const activeController = new AbortController();
    const first = scheduler.run(() => work.promise, activeController.signal).catch(error => error);
    const waitingController = new AbortController();
    const cancelledStart = vi.fn(() => 2);
    const waiting = scheduler.run(cancelledStart, waitingController.signal).catch(error => error);
    waitingController.abort(); activeController.abort();
    expect(await waiting).toMatchObject({ name: 'AbortError' });
    expect(await first).toMatchObject({ name: 'AbortError' });
    work.resolve(1); await vi.advanceTimersByTimeAsync(0);
    const starts: number[] = [];
    const second = scheduler.run(() => { starts.push(Date.now()); return 3; }, signal());
    await vi.advanceTimersByTimeAsync(999);
    expect(starts).toEqual([]); expect(cancelledStart).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await second).toBe(3); expect(starts).toEqual([2000]);
    // The cancelled waiting job did not consume another window at 2000.
    const third = scheduler.run(() => 4, signal());
    await vi.advanceTimersByTimeAsync(1000);
    expect(await third).toBe(4);
  });

  it('keeps the window after a pause, while immediately flushing queued jobs and aborting peers', async () => {
    fakeTime();
    const saved = deferred<void>();
    const persist = vi.fn(() => saved.promise);
    const scheduler = new RequestScheduler<number>({ maxConcurrent: 2, startWindow: { maxStarts: 2, durationMs: 1000 },
      persistCooldownUntil: persist });
    const peerWork = deferred<number>();
    let peerSignal!: AbortSignal;
    const peer = scheduler.run(context => { peerSignal = context.signal; return peerWork.promise; }, signal()).catch(error => error);
    const currentWork = deferred<number>();
    let currentContext!: RequestContext;
    const current = scheduler.run(context => { currentContext = context; return currentWork.promise; }, signal());
    const queuedStart = vi.fn(() => 3);
    const queued = scheduler.run(queuedStart, signal()).catch(error => error);
    const paused = currentContext.pauseFor(100);
    expect(await queued).toMatchObject({ kind: 'RATE_LIMIT' });
    expect(await peer).toMatchObject({ kind: 'RATE_LIMIT' });
    expect(peerSignal.aborted).toBe(true); expect(currentContext.signal.aborted).toBe(false);
    expect(persist).toHaveBeenCalledWith(1100); expect(vi.getTimerCount()).toBe(0);
    peerWork.resolve(1); currentWork.resolve(2); saved.resolve(undefined);
    await paused; expect(await current).toBe(2);
    await vi.advanceTimersByTimeAsync(100);
    const resumedStart = vi.fn(() => 4);
    const resumed = scheduler.run(resumedStart, signal());
    await vi.advanceTimersByTimeAsync(899);
    expect(resumedStart).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await resumed).toBe(4); expect(queuedStart).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears a pending window timer on idempotent disposal without starting late work', async () => {
    fakeTime();
    const scheduler = new RequestScheduler<number>({ startWindow: { maxStarts: 1, durationMs: 1000 } });
    expect(await scheduler.run(() => 1, signal())).toBe(1);
    await vi.advanceTimersByTimeAsync(0);
    const start = vi.fn(() => 2);
    const waiting = scheduler.run(start, signal()).catch(error => error);
    expect(vi.getTimerCount()).toBe(1);
    scheduler.dispose(); scheduler.dispose();
    expect(await waiting).toMatchObject({ name: 'AbortError' });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(start).not.toHaveBeenCalled();
    await expect(scheduler.run(start, signal())).rejects.toMatchObject({ kind: 'DISPOSED' });
  });

  it('copies the supplied window so later caller mutation cannot refund starts', async () => {
    fakeTime();
    const window = { maxStarts: 2, durationMs: 1000 };
    const scheduler = new RequestScheduler<number>({ maxConcurrent: 2, startWindow: window });
    window.maxStarts = 64; window.durationMs = 1;
    expect(await scheduler.run(() => 1, signal())).toBe(1);
    expect(await scheduler.run(() => 2, signal())).toBe(2);
    const start = vi.fn(() => 3);
    const waiting = scheduler.run(start, signal());
    await vi.advanceTimersByTimeAsync(999);
    expect(start).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await waiting).toBe(3);
  });

  it('bounds finite windows to 64 starts and 60000 ms', async () => {
    fakeTime();
    const scheduler = new RequestScheduler<number>({ maxConcurrent: 16,
      startWindow: { maxStarts: 999, durationMs: 999999 } });
    const starts: number[] = [];
    const pending = Array.from({ length: 65 }, (_, index) => scheduler.run(() => {
      starts.push(Date.now()); return index;
    }, signal()));
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toHaveLength(64);
    await vi.advanceTimersByTimeAsync(59999);
    expect(starts).toHaveLength(64);
    await vi.advanceTimersByTimeAsync(1);
    expect(await Promise.all(pending)).toHaveLength(65);
    expect(starts[64]).toBe(61000);
  });

  it.each([
    { maxStarts: 0, durationMs: 1000 }, { maxStarts: -1, durationMs: 1000 },
    { maxStarts: NaN, durationMs: 1000 }, { maxStarts: Infinity, durationMs: 1000 },
    { maxStarts: 1, durationMs: 0 }, { maxStarts: 1, durationMs: -1 },
    { maxStarts: 1, durationMs: NaN }, { maxStarts: 1, durationMs: Infinity },
  ])('rejects the whole invalid window $maxStarts / $durationMs instead of silently disabling it', startWindow => {
    expect(() => new RequestScheduler({ startWindow })).toThrow(RangeError);
  });

  it('waits conservatively through a backward clock adjustment, including when the window has spare capacity', async () => {
    fakeTime();
    const scheduler = new RequestScheduler<number>({ maxConcurrent: 3, startWindow: { maxStarts: 2, durationMs: 1000 } });
    const starts: number[] = [];
    const run = () => scheduler.run(() => { starts.push(Date.now()); return starts.length; }, signal());
    expect(await run()).toBe(1);
    vi.setSystemTime(500);
    const second = run();
    await vi.advanceTimersByTimeAsync(499);
    expect(starts).toEqual([1000]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await second).toBe(2); expect(starts).toEqual([1000, 1000]);
    const third = run();
    await vi.advanceTimersByTimeAsync(999);
    expect(starts).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(await third).toBe(3); expect(starts).toEqual([1000, 1000, 2000]);
  });
});
