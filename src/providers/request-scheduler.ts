export type RequestSchedulingFailureKind = 'RATE_LIMIT' | 'QUEUE_FULL' | 'LOAD_STATE' | 'SAVE_STATE' | 'DISPOSED';

/** Safe scheduling failures; a provider owns their user-facing/domain meaning. */
export class RequestSchedulingFailure extends Error {
  constructor(readonly kind: RequestSchedulingFailureKind) {
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
  loadCooldownUntil?: () => Promise<number>;
  persistCooldownUntil?: (until: number) => Promise<void>;
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
}

const cancelled = () => new DOMException('请求已取消。', 'AbortError');
const failure = (kind: RequestSchedulingFailureKind) => new RequestSchedulingFailure(kind);
function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const requested = Math.floor(value ?? fallback);
  return Number.isNaN(requested) ? fallback : Math.max(minimum, Math.min(maximum, requested));
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

  run(execute: Pending<T>['execute'], signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(cancelled());
    if (this.disposed) return Promise.reject(failure('DISPOSED'));
    if (this.stateError) return Promise.reject(this.stateError);
    if (this.clock() < this.cooldownUntil) return Promise.reject(failure('RATE_LIMIT'));
    if (this.queue.length >= this.maxQueuedRequests) return Promise.reject(failure('QUEUE_FULL'));
    return new Promise((resolve, reject) => {
      const job: Pending<T> = { execute, signal, controller: new AbortController(), resolve, reject,
        settled: false, onAbort: () => {
          const index = this.queue.indexOf(job);
          if (index >= 0) this.queue.splice(index, 1);
          this.settle(job, cancelled());
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

  private pump(): void {
    if (this.disposed || this.active.size >= this.maxConcurrent) return;
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
    const now = this.clock();
    if (now < this.cooldownUntil) {
      for (const job of this.queue.splice(0)) this.settle(job, failure('RATE_LIMIT'));
      clearTimeout(this.timer); this.timer = undefined;
      return;
    }
    let availableAt = this.lastStartedAt === undefined ? now : this.lastStartedAt + this.intervalMs;
    if (this.startWindow) {
      const expiresBefore = now - this.startWindow.durationMs;
      while (this.recentStarts.length && this.recentStarts[0]! <= expiresBefore) this.recentStarts.shift();
      if (this.recentStarts.length >= this.startWindow.maxStarts) {
        availableAt = Math.max(availableAt, this.recentStarts[0]! + this.startWindow.durationMs);
      }
    }
    // A backward wall-clock adjustment keeps both budgets closed until their
    // recorded start times catch up; cancellation never refunds a start.
    const wait = availableAt - now;
    if (wait > 0) {
      if (this.timer === undefined) this.timer = setTimeout(() => { this.timer = undefined; this.pump(); }, wait);
      return;
    }
    const job = this.queue.shift()!;
    if (job.signal.aborted) { this.settle(job, cancelled()); this.pump(); return; }
    this.active.add(job);
    this.lastStartedAt = now;
    if (this.startWindow) this.recentStarts.push(now);
    const context: RequestContext = { signal: job.controller.signal,
      pauseFor: delay => this.pauseFor(job, delay) };
    let execution: Promise<T>;
    try { execution = Promise.resolve(job.execute(context)); }
    catch (error) { execution = Promise.reject(error); }
    void execution.then(result => this.settle(job, undefined, result), error => this.settle(job, error)).finally(() => {
      // A public abort may already have settled, but its slot belongs to the
      // execution until transport and response cleanup have actually finished.
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
