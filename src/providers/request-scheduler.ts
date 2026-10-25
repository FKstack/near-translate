export type RequestSchedulingFailureKind = 'RATE_LIMIT' | 'QUEUE_FULL' | 'LOAD_STATE' | 'SAVE_STATE' | 'DISPOSED' | 'RECOVERY_FAILED';

/** Safe scheduling failures; a provider owns their user-facing/domain meaning. */
export class RequestSchedulingFailure extends Error {
  constructor(readonly kind: RequestSchedulingFailureKind, override readonly cause?: unknown) {
    super('Request scheduling failed: ' + kind);
    this.name = 'RequestSchedulingFailure';
  }
}

export interface RequestSchedulerOptions {
  clock?: () => number;
  intervalMs?: number;
  maxConcurrent?: number;
  maxQueuedRequests?: number;
  /** Optional local budget for starts in (now - durationMs, now]. */
  startWindow?: { maxStarts: number; durationMs: number };
  /** All visible foreign starts, including expired anchors; filter only with this scheduler's current clock. */
  readStartHistory?: () => readonly number[];
  /** Synchronous admission record, before execute; no cross-document atomicity is implied. */
  recordStart?: (at: number) => void;
  loadCooldownUntil?: () => Promise<number>;
  persistCooldownUntil?: (until: number) => Promise<void>;
  /** After a service pause, admit one successful execution before restoring concurrency. */
  recoveryProbe?: boolean;
  /** Persist the captured deadline; recheck isCurrent immediately before an asynchronous commit. */
  onRecoverySucceeded?: (throughCooldownUntil: number, isCurrent: () => boolean) => Promise<void>;
}

export interface RequestContext {
  readonly signal: AbortSignal;
  /** Pause the service before awaiting persistence; abort peers, never this job. */
  pauseFor(delayMs: number): Promise<void>;
}

interface Pending<T> {
  execute(context: RequestContext): Promise<T> | T;
  signal: AbortSignal;
  controller: AbortController;
  resolve(value: T): void;
  reject(reason: unknown): void;
  onAbort(): void;
  settled: boolean;
  recoveryEligible: boolean;
}

const cancelled = () => new DOMException('请求已取消。', 'AbortError');
const failure = (kind: RequestSchedulingFailureKind) => new RequestSchedulingFailure(kind);
function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const requested = Math.floor(value ?? fallback);
  return Number.isNaN(requested) ? fallback : Math.max(minimum, Math.min(maximum, requested));
}
function asynchronousHook(value: unknown): boolean {
  if (value && (typeof value === 'object' || typeof value === 'function')
    && typeof (value as { then?: unknown }).then === 'function') {
    void Promise.resolve(value).catch(() => {});
    return true;
  }
  return false;
}

/** Owns one service's bounded FIFO, network slots, cancellation and cooldown lifetime. */
export class RequestScheduler<T> {
  private readonly clock: () => number;
  private readonly intervalMs: number;
  private readonly maxConcurrent: number;
  private readonly maxQueuedRequests: number;
  private readonly startWindow?: Readonly<{ maxStarts: number; durationMs: number }>;
  private readonly recentStarts: number[] = [];
  private readonly queue: Pending<T>[] = [];
  private readonly active = new Set<Pending<T>>();
  private timer?: ReturnType<typeof setTimeout>;
  private lastStartedAt?: number;
  private cooldownUntil = 0;
  private cooldownLoaded: boolean;
  private cooldownLoading = false;
  private cooldownSaving = 0;
  private cooldownLoad?: Promise<void>;
  private stateError?: RequestSchedulingFailure;
  private disposed = false;
  private admissionHookActive = false;
  private needsRecovery = false;
  private recoveryEpoch = 0;
  private recovery?: { job: Pending<T>; epoch: number; throughCooldownUntil: number; failed: boolean; error?: unknown };

  constructor(private readonly options: RequestSchedulerOptions = {}) {
    this.clock = options.clock ?? (() => Date.now());
    this.intervalMs = bounded(options.intervalMs, 0, 0, 60_000);
    this.maxConcurrent = bounded(options.maxConcurrent, 1, 1, 16);
    this.maxQueuedRequests = bounded(options.maxQueuedRequests, 64, 1, 64);
    if (options.startWindow !== undefined) {
      const { maxStarts, durationMs } = options.startWindow;
      if (!Number.isFinite(maxStarts) || maxStarts <= 0 || !Number.isFinite(durationMs) || durationMs <= 0) {
        throw new RangeError('Invalid request start window');
      }
      this.startWindow = Object.freeze({
        maxStarts: bounded(maxStarts, 1, 1, 64),
        durationMs: bounded(durationMs, 1, 1, 60_000),
      });
    }
    this.cooldownLoaded = !options.loadCooldownUntil;
  }

  run(execute: Pending<T>['execute'], signal: AbortSignal, options: { recoveryEligible?: boolean } = {}): Promise<T> {
    if (signal.aborted) return Promise.reject(cancelled());
    if (this.disposed) return Promise.reject(failure('DISPOSED'));
    if (this.stateError) return Promise.reject(this.stateError);
    const now = this.clock();
    if ((this.options.readStartHistory || this.options.recordStart) && (!Number.isSafeInteger(now) || now < 0)) {
      this.failStartState('LOAD_STATE'); return Promise.reject(this.stateError);
    }
    if (now < this.cooldownUntil) return Promise.reject(failure('RATE_LIMIT'));
    if (this.needsRecovery && options.recoveryEligible === false) return Promise.reject(failure('RATE_LIMIT'));
    if (this.queue.length >= this.maxQueuedRequests) return Promise.reject(failure('QUEUE_FULL'));
    return new Promise((resolve, reject) => {
      const job: Pending<T> = { execute, signal, controller: new AbortController(), resolve, reject,
        settled: false, recoveryEligible: options.recoveryEligible !== false, onAbort: () => {
          if (this.options.recoveryProbe && this.active.has(job) && !job.settled) {
            // Aborting local I/O cannot establish that upstream work stopped.
            // Resume cautiously, without inventing a rate-limit or deadline.
            this.needsRecovery = true; this.recoveryEpoch++;
          }
          const index = this.queue.indexOf(job);
          if (index >= 0) this.queue.splice(index, 1);
          const error = cancelled();
          this.settle(job, error);
          this.failRecovery(job, error);
          job.controller.abort();
          this.pump();
        } };
      signal.addEventListener('abort', job.onAbort, { once: true });
      this.queue.push(job);
      this.pump();
    });
  }

  /** Observe restored cooldown without admitting work or spending a request start. */
  async getCooldownUntil(): Promise<number> {
    if (this.disposed) throw failure('DISPOSED');
    if (this.stateError) throw this.stateError;
    if (!this.cooldownLoaded) await this.restoreCooldown();
    if (this.disposed) throw failure('DISPOSED');
    if (this.stateError) throw this.stateError;
    return this.cooldownUntil;
  }

  /** A shared observation adds local protection; it never persists or counts an upstream failure. */
  observeCooldownUntil(until: number): boolean {
    if (!Number.isSafeInteger(until) || until < 0) throw failure('LOAD_STATE');
    if (this.disposed || until === 0 || until < this.cooldownUntil
      || (until === this.cooldownUntil && this.needsRecovery)) return false;
    this.cooldownUntil = until;
    if (this.options.recoveryProbe) { this.needsRecovery = true; this.recoveryEpoch++; }
    clearTimeout(this.timer); this.timer = undefined;
    for (const job of this.queue.splice(0)) this.settle(job, failure('RATE_LIMIT'));
    for (const job of this.active) {
      const error = failure('RATE_LIMIT');
      this.settle(job, error); this.failRecovery(job, error); job.controller.abort();
    }
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer); this.timer = undefined;
    this.recentStarts.length = 0;
    for (const job of this.queue.splice(0)) this.settle(job, cancelled());
    for (const job of this.active) {
      this.settle(job, cancelled());
      job.controller.abort();
    }
  }

  private settle(job: Pending<T>, error?: unknown, result?: T): void {
    if (job.settled) return;
    job.settled = true;
    job.signal.removeEventListener('abort', job.onAbort);
    if (error !== undefined) job.reject(error);
    else job.resolve(result!);
  }

  private failRecovery(job: Pending<T>, error: unknown): unknown {
    const recovery = this.recovery;
    if (recovery?.job !== job) return error;
    if (recovery.failed) return recovery.error;
    recovery.failed = true;
    recovery.error = error instanceof RequestSchedulingFailure || (error instanceof Error && error.name === 'AbortError')
      ? error : new RequestSchedulingFailure('RECOVERY_FAILED', error);
    // Existing waiters belong to this attempt. A failure never promotes one
    // of them to another automatic probe, even when abort is ignored.
    for (const waiting of this.queue.splice(0)) this.settle(waiting, recovery.error);
    clearTimeout(this.timer); this.timer = undefined;
    return recovery.error;
  }

  private failStartState(kind: 'LOAD_STATE' | 'SAVE_STATE'): void {
    this.stateError = failure(kind);
    clearTimeout(this.timer); this.timer = undefined;
    for (const job of this.queue.splice(0)) this.settle(job, this.stateError);
    for (const job of this.active) {
      this.settle(job, this.stateError); this.failRecovery(job, this.stateError); job.controller.abort();
    }
  }

  private pump(): void {
    if (this.admissionHookActive || this.disposed || this.active.size >= this.maxConcurrent) return;
    if (!this.queue.length) { clearTimeout(this.timer); this.timer = undefined; return; }
    if (this.stateError) {
      for (const job of this.queue.splice(0)) this.settle(job, this.stateError);
      return;
    }
    if (this.cooldownSaving) return;
    if (!this.cooldownLoaded) {
      if (!this.cooldownLoading) {
        this.cooldownLoading = true;
        void this.restoreCooldown().then(() => {
          this.cooldownLoading = false; this.pump();
        }, () => {
          this.cooldownLoading = false;
          for (const job of this.queue.splice(0)) this.settle(job, this.stateError!);
        });
      }
      return;
    }
    let now = this.clock();
    if ((this.options.readStartHistory || this.options.recordStart) && (!Number.isSafeInteger(now) || now < 0)) {
      this.failStartState('LOAD_STATE'); return;
    }
    if (now < this.cooldownUntil) {
      for (const job of this.queue.splice(0)) this.settle(job, failure('RATE_LIMIT'));
      clearTimeout(this.timer); this.timer = undefined;
      return;
    }
    if (this.recovery) return;
    if (this.needsRecovery && !this.queue[0]!.recoveryEligible) {
      this.settle(this.queue.shift()!, failure('RATE_LIMIT'));
      this.pump(); return;
    }
    let foreign: number[] | undefined;
    if (this.options.readStartHistory) {
      this.admissionHookActive = true;
      try {
        const value: unknown = this.options.readStartHistory();
        if (asynchronousHook(value) || !Array.isArray(value)) throw new Error('Invalid start history');
        foreign = Array.from(value);
        if (foreign.some(at => !Number.isSafeInteger(at) || at < 0)) throw new Error('Invalid start timestamp');
      } catch { this.failStartState('LOAD_STATE'); return; }
      finally { this.admissionHookActive = false; }
      // Storage callbacks can synchronously cancel, pause or dispose the owner.
      now = this.clock();
      if (!Number.isSafeInteger(now) || now < 0) { this.failStartState('LOAD_STATE'); return; }
      if (this.disposed || this.stateError || !this.queue.length || this.cooldownSaving || this.recovery
        || now < this.cooldownUntil || (this.needsRecovery && !this.queue[0]!.recoveryEligible)) {
        this.pump(); return;
      }
    }
    let availableAt = this.lastStartedAt === undefined ? now : this.lastStartedAt + this.intervalMs;
    for (const at of foreign ?? []) availableAt = Math.max(availableAt, at + this.intervalMs);
    if (this.startWindow) {
      const expiresBefore = now - this.startWindow.durationMs;
      while (this.recentStarts.length && this.recentStarts[0]! <= expiresBefore) this.recentStarts.shift();
      if (foreign !== undefined) {
        const visible = [...this.recentStarts, ...foreign.filter(at => at > expiresBefore)].sort((a, b) => a - b);
        if (visible.length >= this.startWindow.maxStarts) {
          availableAt = Math.max(availableAt, visible[visible.length - this.startWindow.maxStarts]! + this.startWindow.durationMs);
        }
      } else if (this.recentStarts.length >= this.startWindow.maxStarts) {
        availableAt = Math.max(availableAt, this.recentStarts[0]! + this.startWindow.durationMs);
      }
    }
    // A backward wall-clock adjustment keeps both budgets closed until their
    // recorded start times catch up; cancellation never refunds a start.
    const wait = availableAt - now;
    if (wait > 0) {
      if (this.timer === undefined) this.timer = setTimeout(() => { this.timer = undefined; this.pump(); }, Math.min(wait, 2_147_483_647));
      return;
    }
    const job = this.queue.shift()!;
    if (job.signal.aborted) { this.settle(job, cancelled()); this.pump(); return; }
    this.active.add(job);
    if (this.needsRecovery) this.recovery = { job, epoch: this.recoveryEpoch, throughCooldownUntil: this.cooldownUntil, failed: false };
    this.lastStartedAt = now;
    if (this.startWindow) this.recentStarts.push(now);
    if (this.options.recordStart) {
      this.admissionHookActive = true;
      try {
        if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid start timestamp');
        const recorded: unknown = this.options.recordStart(now);
        if (asynchronousHook(recorded)) throw new Error('Asynchronous start record');
      } catch {
        this.failStartState('SAVE_STATE');
        this.settle(job, this.failRecovery(job, this.stateError));
        this.active.delete(job);
        if (this.recovery?.job === job) this.recovery = undefined;
        return;
      } finally { this.admissionHookActive = false; }
      if (job.settled || job.signal.aborted || job.controller.signal.aborted || this.disposed || this.stateError) {
        this.active.delete(job);
        if (this.recovery?.job === job) this.recovery = undefined;
        this.pump(); return;
      }
    }
    const context: RequestContext = { signal: job.controller.signal,
      pauseFor: delay => this.pauseFor(job, delay) };
    let execution: Promise<T>;
    try { execution = Promise.resolve(job.execute(context)); }
    catch (error) { execution = Promise.reject(error); }
    void execution.then(async result => {
      const recovery = this.recovery;
      if (recovery?.job === job && !recovery.failed) {
        const valid = () => !this.disposed && this.recovery === recovery && !recovery.failed
          && recovery.epoch === this.recoveryEpoch && !job.settled && !job.signal.aborted && !job.controller.signal.aborted;
        if (valid()) {
          try { await this.options.onRecoverySucceeded?.(recovery.throughCooldownUntil, valid); }
          catch {
            if (!valid()) {
              const error = cancelled();
              this.failRecovery(job, error); this.settle(job, error); return;
            }
            this.stateError = failure('SAVE_STATE');
            this.failRecovery(job, this.stateError); this.settle(job, this.stateError); return;
          }
        }
        if (!valid()) {
          const error = cancelled();
          this.failRecovery(job, error); this.settle(job, error); return;
        }
        this.needsRecovery = false;
      }
      this.settle(job, undefined, result);
    }, error => { this.settle(job, this.failRecovery(job, error)); }).finally(() => {
      // A public abort may already have settled, but its slot belongs to the
      // execution until transport and response cleanup have actually finished.
      if (this.recovery?.job === job) this.recovery = undefined;
      this.active.delete(job); this.pump();
    });
    this.pump();
  }

  private restoreCooldown(): Promise<void> {
    if (!this.cooldownLoad) this.cooldownLoad = Promise.resolve().then(async () => {
      try {
        const until = await this.options.loadCooldownUntil!();
        if (!Number.isSafeInteger(until) || until < 0) throw new Error('Invalid cooldown state');
        this.cooldownUntil = Math.max(this.cooldownUntil, until);
        if (this.options.recoveryProbe && until > 0) this.needsRecovery = true;
        this.cooldownLoaded = true;
      } catch {
        this.stateError = failure('LOAD_STATE');
        throw this.stateError;
      }
    });
    return this.cooldownLoad;
  }

  private async pauseFor(current: Pending<T>, delayMs: number): Promise<void> {
    if (this.disposed || current.settled || !this.active.has(current)) throw cancelled();
    const delay = Number.isFinite(delayMs) ? Math.max(0, Math.floor(delayMs)) : 0;
    this.cooldownUntil = Math.max(this.cooldownUntil, Math.min(Number.MAX_SAFE_INTEGER, this.clock() + delay));
    if (this.options.recoveryProbe) { this.needsRecovery = true; this.recoveryEpoch++; }
    clearTimeout(this.timer); this.timer = undefined;
    for (const job of this.queue.splice(0)) this.settle(job, failure('RATE_LIMIT'));
    for (const job of this.active) {
      if (job === current) continue;
      this.settle(job, failure('RATE_LIMIT'));
      job.controller.abort();
    }
    if (this.options.persistCooldownUntil) {
      this.cooldownSaving++;
      try { await this.options.persistCooldownUntil(this.cooldownUntil); }
      catch {
        this.stateError = failure('SAVE_STATE');
        throw this.stateError;
      } finally {
        this.cooldownSaving--;
        this.pump();
      }
    }
  }
}
