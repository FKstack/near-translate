import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequestScheduler, type RequestContext } from '../../src/providers/request-scheduler';
import { DeepLWebProvider } from '../../src/providers/deepl-web';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function fakeTime() { vi.useFakeTimers(); vi.setSystemTime(1000); }
const signal = () => new AbortController().signal;
afterEach(() => { vi.useRealTimers(); });

describe('visible cross-document start history admission', () => {
  it('waits for the correct expiry when foreign starts already exceed the whole window', async () => {
    fakeTime();
    const scheduler = new RequestScheduler<number>({ maxConcurrent: 8, startWindow: { maxStarts: 3, durationMs: 1_000 },
      readStartHistory: () => [1000, 1100, 1200, 1300, 1400] });
    const execute = vi.fn(() => Date.now()); const result = scheduler.run(execute, signal());
    expect(execute).not.toHaveBeenCalled();
    await vi.advanceTimersToNextTimerAsync();
    expect(Date.now()).toBe(2200); expect(await result).toBe(2200); scheduler.dispose();
  });

  it('counts equal timestamps as distinct foreign starts rather than deduplicating them', async () => {
    fakeTime();
    const scheduler = new RequestScheduler<number>({ startWindow: { maxStarts: 3, durationMs: 1_000 },
      readStartHistory: () => [1000, 1000, 1000] });
    const execute = vi.fn(() => Date.now()); const result = scheduler.run(execute, signal());
    expect(execute).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(999); expect(execute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(await result).toBe(2000); scheduler.dispose();
  });

  it('combines own starts with foreign history and records each actual admission before execute', async () => {
    fakeTime(); const events: string[] = []; const times: number[] = [];
    const scheduler = new RequestScheduler<number>({ startWindow: { maxStarts: 2, durationMs: 1_000 },
      readStartHistory: () => [900], recordStart: at => { times.push(at); events.push('record'); } });
    expect(await scheduler.run(() => { events.push('execute'); return 1; }, signal())).toBe(1);
    const second = scheduler.run(() => { events.push('execute'); return 2; }, signal());
    await vi.advanceTimersByTimeAsync(899); expect(times).toEqual([1000]);
    await vi.advanceTimersByTimeAsync(1); expect(await second).toBe(2); expect(times).toEqual([1000, 1900]);
    expect(events).toEqual(['record', 'execute', 'record', 'execute']); scheduler.dispose();
  });

  it('takes the latest foreign start into account for spacing, including a backward clock', async () => {
    fakeTime(); const scheduler = new RequestScheduler<number>({ intervalMs: 100, readStartHistory: () => [900, 1250, 1100] });
    const execute = vi.fn(() => Date.now()); const result = scheduler.run(execute, signal());
    await vi.advanceTimersByTimeAsync(349); expect(execute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(await result).toBe(1350); scheduler.dispose();
  });

  it('uses the post-hook clock without losing old anchors when the clock moves backwards inside the read', async () => {
    fakeTime(); vi.setSystemTime(15_000); let changed = false;
    const scheduler = new RequestScheduler<number>({ intervalMs: 100, readStartHistory: () => {
      if (!changed) { changed = true; vi.setSystemTime(500); }
      return [1000, 2000];
    } });
    const execute = vi.fn(() => Date.now()); const result = scheduler.run(execute, signal());
    expect(Date.now()).toBe(500); expect(execute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1599); expect(execute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(await result).toBe(2100); scheduler.dispose();
  });

  it.each([NaN, Infinity, -1, 0.5])('does not admit a history-backed request with an invalid clock %j', async now => {
    const scheduler = new RequestScheduler<number>({ clock: () => now, readStartHistory: () => [] });
    const execute = vi.fn(() => 1);
    await expect(scheduler.run(execute, signal())).rejects.toMatchObject({ kind: 'LOAD_STATE' });
    expect(execute).not.toHaveBeenCalled(); scheduler.dispose();
  });

  it('inherits another document starts on a new scheduler without resetting the rolling budget', async () => {
    fakeTime(); const firstHistory: number[] = [];
    const first = new RequestScheduler<number>({ intervalMs: 100, startWindow: { maxStarts: 2, durationMs: 1_000 },
      recordStart: at => { firstHistory.push(at); } });
    expect(await first.run(() => 1, signal())).toBe(1);
    const next = first.run(() => 2, signal()); await vi.advanceTimersByTimeAsync(100); expect(await next).toBe(2);
    first.dispose(); expect(firstHistory).toEqual([1000, 1100]);
    const scheduler = new RequestScheduler<number>({ intervalMs: 100, startWindow: { maxStarts: 2, durationMs: 1_000 },
      readStartHistory: () => firstHistory });
    const execute = vi.fn(() => Date.now()); const result = scheduler.run(execute, signal());
    await vi.advanceTimersByTimeAsync(899); expect(execute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(await result).toBe(2000); scheduler.dispose();
  });

  it.each([undefined, null, {}, [NaN], [Infinity], [-1], [1.5], [Number.MAX_SAFE_INTEGER + 1], ['1000'], Array(1)])(
    'fails closed on invalid visible history %j without executing queued work', async value => {
      fakeTime(); const restored = deferred<number>();
      const read = vi.fn(() => value as readonly number[]);
      const scheduler = new RequestScheduler<number>({ maxConcurrent: 8, loadCooldownUntil: () => restored.promise, readStartHistory: read });
      const execute = vi.fn(() => 1);
      const jobs = Array.from({ length: 3 }, () => scheduler.run(execute, signal()).catch(error => error));
      restored.resolve(0); expect((await Promise.all(jobs)).every(error => error.kind === 'LOAD_STATE')).toBe(true);
      expect(execute).not.toHaveBeenCalled(); expect(read).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
      await expect(scheduler.run(execute, signal())).rejects.toMatchObject({ kind: 'LOAD_STATE' }); scheduler.dispose();
    });

  it('isolates read exceptions and stops the whole queue without publishing a service rate-limit', async () => {
    fakeTime(); const restored = deferred<number>(); const persist = vi.fn(async () => {});
    const scheduler = new RequestScheduler<number>({ loadCooldownUntil: () => restored.promise, persistCooldownUntil: persist,
      readStartHistory: () => { throw new Error('private storage detail'); } });
    const execute = vi.fn(() => 1); const first = scheduler.run(execute, signal()).catch(error => error);
    const second = scheduler.run(execute, signal()).catch(error => error); restored.resolve(0);
    for (const result of await Promise.all([first, second])) {
      expect(result).toMatchObject({ kind: 'LOAD_STATE' }); expect(result.message).not.toContain('private');
    }
    expect(execute).not.toHaveBeenCalled(); expect(persist).not.toHaveBeenCalled(); scheduler.dispose();
  });

  it('blocks nested execution when a write callback enqueues more work and then fails', async () => {
    fakeTime(); const execute = vi.fn(() => 1); let nested!: Promise<unknown>;
    const scheduler = new RequestScheduler<number>({ maxConcurrent: 8, recordStart: () => {
      nested = scheduler.run(execute, signal()).catch(error => error); throw new Error('private save failure');
    } });
    const first = scheduler.run(execute, signal()).catch(error => error);
    expect(await first).toMatchObject({ kind: 'SAVE_STATE' }); expect(await nested).toMatchObject({ kind: 'SAVE_STATE' });
    expect(execute).not.toHaveBeenCalled(); await expect(scheduler.run(execute, signal())).rejects.toMatchObject({ kind: 'SAVE_STATE' });
    expect(vi.getTimerCount()).toBe(0); scheduler.dispose();
  });

  it.each(['read', 'write'] as const)('aborts an admitted DeepL guard before I/O when a later %s hook fails', async mode => {
    fakeTime(); const guard = deferred<void>(); let reads = 0; let writes = 0;
    const transport = vi.fn(async () => new Response('{"translations":[{"text":"完整译文"}]}'));
    const onDiagnostic = vi.fn(); const persistCooldownUntil = vi.fn(async () => {});
    const provider = new DeepLWebProvider(transport, { maxConcurrent: 2, intervalMs: 100, onDiagnostic, persistCooldownUntil,
      readStartHistory: () => { reads++; if (mode === 'read' && reads === 2) throw new Error('private read'); return []; },
      recordStart: () => { writes++; if (mode === 'write' && writes === 2) throw new Error('private write'); },
    });
    const collect = async (beforeRequest?: () => Promise<void>) => {
      try { for await (const _event of provider.translate({ kind: 'text', text: 'Public guard fixture.' }, signal(), beforeRequest)) { /* No HTTP may complete. */ } }
      catch (error) { return error; }
    };
    const first = collect(() => guard.promise); const second = collect();
    await vi.advanceTimersByTimeAsync(100);
    expect(await first).toMatchObject({ code: 'CONFIG' }); expect(await second).toMatchObject({ code: 'CONFIG' });
    guard.resolve(undefined); await vi.advanceTimersByTimeAsync(1000);
    expect(transport).not.toHaveBeenCalled(); expect(onDiagnostic).not.toHaveBeenCalled(); expect(persistCooldownUntil).not.toHaveBeenCalled();
  });

  it.each(['read', 'write'] as const)('rejects accidental asynchronous %s hooks instead of treating a pending write as admission', async mode => {
    fakeTime();
    const asynchronous = async () => { throw new Error('private asynchronous failure'); };
    const scheduler = new RequestScheduler<number>({
      ...(mode === 'read' ? { readStartHistory: asynchronous as unknown as () => readonly number[] } : { recordStart: asynchronous }),
    });
    const execute = vi.fn(() => 1);
    await expect(scheduler.run(execute, signal())).rejects.toMatchObject({ kind: mode === 'read' ? 'LOAD_STATE' : 'SAVE_STATE' });
    await vi.advanceTimersByTimeAsync(0); expect(execute).not.toHaveBeenCalled(); scheduler.dispose();
  });

  it('does not execute a selected job cancelled by its synchronous record callback', async () => {
    fakeTime(); const controller = new AbortController(); const recorded: number[] = [];
    const scheduler = new RequestScheduler<number>({ recoveryProbe: true, recordStart: at => { recorded.push(at); controller.abort(); } });
    const execute = vi.fn(() => 1);
    await expect(scheduler.run(execute, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(recorded).toEqual([1000]); expect(execute).not.toHaveBeenCalled();
    expect(await scheduler.getCooldownUntil()).toBe(0); scheduler.dispose();
  });

  it('does not admit work when a read callback observes a new shared cooldown', async () => {
    fakeTime();
    const scheduler = new RequestScheduler<number>({ recoveryProbe: true, readStartHistory: () => {
      scheduler.observeCooldownUntil(61_000); return [];
    } });
    const execute = vi.fn(() => 1);
    await expect(scheduler.run(execute, signal())).rejects.toMatchObject({ kind: 'RATE_LIMIT' });
    expect(execute).not.toHaveBeenCalled(); expect(await scheduler.getCooldownUntil()).toBe(61_000); scheduler.dispose();
  });

  it('retains an issued start after cancellation instead of refunding recorded admission', async () => {
    fakeTime(); const old = deferred<number>(); const controller = new AbortController(); const recorded: number[] = [];
    const scheduler = new RequestScheduler<number>({ startWindow: { maxStarts: 1, durationMs: 1_000 }, recordStart: at => { recorded.push(at); } });
    const first = scheduler.run(() => old.promise, controller.signal).catch(error => error);
    controller.abort(); expect(await first).toMatchObject({ name: 'AbortError' }); old.resolve(1);
    const execute = vi.fn(() => 2); const second = scheduler.run(execute, signal());
    await vi.advanceTimersByTimeAsync(999); expect(execute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(await second).toBe(2); expect(recorded).toEqual([1000, 2000]); scheduler.dispose();
  });

  it('chunks an extremely distant valid timestamp without timer overflow or a busy loop', async () => {
    fakeTime(); const controller = new AbortController();
    const scheduler = new RequestScheduler<number>({ intervalMs: 100, readStartHistory: () => [Number.MAX_SAFE_INTEGER] });
    const execute = vi.fn(() => 1); const result = scheduler.run(execute, controller.signal).catch(error => error);
    await vi.advanceTimersToNextTimerAsync(); expect(Date.now()).toBe(1000 + 2_147_483_647);
    expect(execute).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(1);
    controller.abort(); expect(await result).toMatchObject({ name: 'AbortError' }); expect(vi.getTimerCount()).toBe(0); scheduler.dispose();
  });

  it('passes history admission hooks through the DeepL provider without issuing HTTP early', async () => {
    fakeTime(); const recorded: number[] = [];
    const transport = vi.fn(async () => new Response('{"translations":[{"text":"完整译文"}]}'));
    const provider = new DeepLWebProvider(transport, { intervalMs: 100, maxConcurrent: 8,
      startWindow: { maxStarts: 30, durationMs: 12_000 }, readStartHistory: () => Array(30).fill(1000),
      recordStart: at => { expect(transport).not.toHaveBeenCalled(); recorded.push(at); } });
    const result = (async () => { for await (const event of provider.translate({ kind: 'text', text: 'Public fixture.' }, signal())) {
      if (event.type === 'result') return event.result;
    } })();
    await vi.advanceTimersByTimeAsync(11_999); expect(recorded).toEqual([]); expect(transport).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(await result).toMatchObject({ kind: 'text', translation: '完整译文' });
    expect(recorded).toEqual([13000]); expect(transport).toHaveBeenCalledOnce();
  });
});

describe('optional service recovery admission', () => {
  it('starts exactly one probe before charging further starts, then keeps FIFO, interval and rolling budgets', async () => {
    fakeTime();
    const probe = deferred<number>();
    const scheduler = new RequestScheduler<number>({ recoveryProbe: true, loadCooldownUntil: async () => 500,
      maxConcurrent: 8, intervalMs: 100, startWindow: { maxStarts: 2, durationMs: 1_000 } });
    const starts: number[] = [];
    const jobs = Array.from({ length: 4 }, (_, index) => scheduler.run(() => {
      starts.push(Date.now()); return index === 0 ? probe.promise : index;
    }, signal()));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(starts).toEqual([1000]);
    probe.resolve(0); await vi.advanceTimersByTimeAsync(0);
    expect(starts).toEqual([1000, 2500]);
    await vi.advanceTimersByTimeAsync(100);
    expect(starts).toEqual([1000, 2500, 2600]);
    await vi.advanceTimersByTimeAsync(899); expect(starts).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(starts).toEqual([1000, 2500, 2600, 3500]);
    expect(await Promise.all(jobs)).toEqual([0, 1, 2, 3]); scheduler.dispose();
  });

  it('fails the existing attempt as one unit instead of automatically probing every waiter', async () => {
    fakeTime();
    const probe = deferred<number>(); const error = new TypeError('network failure');
    const scheduler = new RequestScheduler<number>({ recoveryProbe: true, loadCooldownUntil: async () => 500, maxConcurrent: 8 });
    const execute = vi.fn(() => probe.promise);
    const jobs = Array.from({ length: 8 }, () => scheduler.run(execute, signal()).catch(reason => reason));
    await vi.advanceTimersByTimeAsync(0); probe.reject(error);
    expect((await Promise.all(jobs)).every(result => result.kind === 'RECOVERY_FAILED' && result.cause === error)).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000); expect(execute).toHaveBeenCalledOnce();
    expect(await scheduler.run(() => 9, signal())).toBe(9); scheduler.dispose();
  });

  it('flushes waiters immediately on cancellation and an ignored-abort late success cannot open recovery', async () => {
    fakeTime();
    const probe = deferred<number>(); const controller = new AbortController();
    const recovered = vi.fn(async () => {});
    const scheduler = new RequestScheduler<number>({ recoveryProbe: true, onRecoverySucceeded: recovered,
      loadCooldownUntil: async () => 500, maxConcurrent: 8 });
    const first = scheduler.run(() => probe.promise, controller.signal).catch(reason => reason);
    const execute = vi.fn(() => 2);
    const waiting = scheduler.run(execute, signal()).catch(reason => reason);
    await vi.advanceTimersByTimeAsync(0); controller.abort();
    expect(await first).toMatchObject({ name: 'AbortError' });
    expect(await waiting).toMatchObject({ name: 'AbortError' });
    probe.resolve(1); await vi.advanceTimersByTimeAsync(1000);
    expect(recovered).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
    const next = deferred<number>();
    const retry = scheduler.run(() => next.promise, signal());
    const after = scheduler.run(execute, signal());
    await vi.advanceTimersByTimeAsync(1000); expect(execute).not.toHaveBeenCalled();
    next.resolve(3); expect(await retry).toBe(3); expect(await after).toBe(2);
    expect(recovered).toHaveBeenCalledExactlyOnceWith(500, expect.any(Function)); scheduler.dispose();
  });

  it('captures the old deadline and waits for recovery persistence before admitting peers', async () => {
    fakeTime(); const saved = deferred<void>();
    const recovered = vi.fn(() => saved.promise);
    const scheduler = new RequestScheduler<number>({ recoveryProbe: true, onRecoverySucceeded: recovered,
      loadCooldownUntil: async () => 500, maxConcurrent: 8 });
    const first = scheduler.run(() => 1, signal());
    const execute = vi.fn(() => 2); const second = scheduler.run(execute, signal());
    await vi.advanceTimersByTimeAsync(0);
    expect(recovered).toHaveBeenCalledExactlyOnceWith(500, expect.any(Function)); expect(execute).not.toHaveBeenCalled();
    saved.resolve(undefined); expect(await first).toBe(1); expect(await second).toBe(2); scheduler.dispose();
  });

  it('fails closed when recovery persistence fails and never releases waiting work', async () => {
    const scheduler = new RequestScheduler<number>({ recoveryProbe: true, loadCooldownUntil: async () => 1,
      onRecoverySucceeded: async () => { throw new Error('private storage failure'); }, maxConcurrent: 8 });
    const execute = vi.fn(() => 2);
    const first = scheduler.run(() => 1, signal()).catch(reason => reason);
    const second = scheduler.run(execute, signal()).catch(reason => reason);
    expect(await first).toMatchObject({ kind: 'SAVE_STATE' }); expect(await second).toMatchObject({ kind: 'SAVE_STATE' });
    await expect(scheduler.run(execute, signal())).rejects.toMatchObject({ kind: 'SAVE_STATE' });
    expect(execute).not.toHaveBeenCalled(); scheduler.dispose();
  });

  it('checks cancellation again after recovery persistence, without allowing its late resolution to open the gate', async () => {
    fakeTime(); const saved = deferred<void>(); const controller = new AbortController();
    const scheduler = new RequestScheduler<number>({ recoveryProbe: true, loadCooldownUntil: async () => 500,
      onRecoverySucceeded: () => saved.promise, maxConcurrent: 8 });
    const first = scheduler.run(() => 1, controller.signal).catch(reason => reason);
    const execute = vi.fn(() => 2); const second = scheduler.run(execute, signal()).catch(reason => reason);
    await vi.advanceTimersByTimeAsync(0); controller.abort();
    expect(await first).toMatchObject({ name: 'AbortError' }); expect(await second).toMatchObject({ name: 'AbortError' });
    saved.resolve(undefined); await vi.advanceTimersByTimeAsync(0); expect(execute).not.toHaveBeenCalled(); scheduler.dispose();
  });

  it('never lets metadata-only execution recover a paused service', async () => {
    const scheduler = new RequestScheduler<number>({ recoveryProbe: true, loadCooldownUntil: async () => 1, maxConcurrent: 8 });
    const metadata = vi.fn(() => 0);
    await expect(scheduler.run(metadata, signal(), { recoveryEligible: false })).rejects.toMatchObject({ kind: 'RATE_LIMIT' });
    expect(metadata).not.toHaveBeenCalled();
    expect(await scheduler.run(() => 1, signal())).toBe(1); scheduler.dispose();
  });

  it('provides a commit guard that becomes false after cancellation without poisoning later attempts', async () => {
    fakeTime(); const saved = deferred<void>(); const controller = new AbortController(); let committed = false;
    const scheduler = new RequestScheduler<number>({ recoveryProbe: true, loadCooldownUntil: async () => 500,
      onRecoverySucceeded: async (_through, current) => { await saved.promise; if (!current()) throw new DOMException('cancelled', 'AbortError'); committed = true; } });
    const first = scheduler.run(() => 1, controller.signal).catch(reason => reason);
    await vi.advanceTimersByTimeAsync(0); controller.abort(); saved.resolve(undefined);
    expect(await first).toMatchObject({ name: 'AbortError' }); await vi.advanceTimersByTimeAsync(0);
    expect(committed).toBe(false);
    expect(await scheduler.run(() => 2, signal())).toBe(2); expect(committed).toBe(true); scheduler.dispose();
  });

  it('invalidates the recovery commit guard when a newer shared cooldown arrives during its write', async () => {
    fakeTime(); const saved = deferred<void>(); let guard!: () => boolean; const captured: number[] = [];
    const scheduler = new RequestScheduler<number>({ recoveryProbe: true, loadCooldownUntil: async () => 500, maxConcurrent: 8,
      onRecoverySucceeded: async (through, current) => { captured.push(through); guard = current; await saved.promise; } });
    const first = scheduler.run(() => 1, signal()).catch(reason => reason);
    const execute = vi.fn(() => 2); const waiting = scheduler.run(execute, signal()).catch(reason => reason);
    await vi.advanceTimersByTimeAsync(0); expect(guard()).toBe(true);
    scheduler.observeCooldownUntil(3_000); expect(guard()).toBe(false);
    expect(await first).toMatchObject({ kind: 'RATE_LIMIT' }); expect(await waiting).toMatchObject({ kind: 'RATE_LIMIT' });
    saved.resolve(undefined); await vi.advanceTimersByTimeAsync(2_000);
    expect(execute).not.toHaveBeenCalled(); expect(captured).toEqual([500]);
    expect(await scheduler.run(() => 3, signal())).toBe(3); expect(captured).toEqual([500, 3000]); scheduler.dispose();
  });

  it('recovers cautiously after an active external abort without creating or persisting a rate limit', async () => {
    fakeTime(); const old = deferred<number>(); const controller = new AbortController();
    const persist = vi.fn(async () => {}); const recovered = vi.fn(async () => {});
    const scheduler = new RequestScheduler<number>({ recoveryProbe: true, maxConcurrent: 8, intervalMs: 100,
      persistCooldownUntil: persist, onRecoverySucceeded: recovered });
    const first = scheduler.run(() => old.promise, controller.signal).catch(reason => reason);
    controller.abort(); expect(await first).toMatchObject({ name: 'AbortError' });
    old.resolve(1); await vi.advanceTimersByTimeAsync(100);
    expect(await scheduler.getCooldownUntil()).toBe(0); expect(persist).not.toHaveBeenCalled();
    const probe = deferred<number>(); const start = vi.fn(() => 3);
    const second = scheduler.run(() => probe.promise, signal()); const third = scheduler.run(start, signal());
    await vi.advanceTimersByTimeAsync(1_000); expect(start).not.toHaveBeenCalled();
    probe.resolve(2); expect(await second).toBe(2); expect(await third).toBe(3);
    expect(recovered).toHaveBeenCalledExactlyOnceWith(0, expect.any(Function)); scheduler.dispose();
  });

  it('does not arm recovery for queued cancellation or aborting an already successful owner', async () => {
    fakeTime(); const first = deferred<number>(); const queuedController = new AbortController(); const settledController = new AbortController();
    const recovered = vi.fn(async () => {});
    const scheduler = new RequestScheduler<number>({ recoveryProbe: true, maxConcurrent: 8, intervalMs: 100, onRecoverySucceeded: recovered });
    const active = scheduler.run(() => first.promise, settledController.signal);
    const queued = scheduler.run(() => 2, queuedController.signal).catch(reason => reason);
    queuedController.abort(); expect(await queued).toMatchObject({ name: 'AbortError' });
    first.resolve(1); expect(await active).toBe(1); settledController.abort();
    const work = Array.from({ length: 8 }, () => deferred<number>()); const starts: number[] = [];
    const jobs = work.map((item, index) => scheduler.run(() => { starts.push(index); return item.promise; }, signal()));
    await vi.advanceTimersByTimeAsync(800); expect(starts).toHaveLength(8);
    work.forEach((item, index) => item.resolve(index)); await Promise.all(jobs);
    expect(recovered).not.toHaveBeenCalled(); scheduler.dispose();
  });
});

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
