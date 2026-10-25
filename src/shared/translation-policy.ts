import type { TranslationEngine } from './contracts';

/** Protocol/anonymous-client budgets are separate from our scheduling choices. */
export const DEEPL_WEB_LIMITS = Object.freeze({
  maxBatchItems: 32,
  maxBatchChars: 1_500,
  maxRequestBytes: 64 * 1024,
  maxResponseBytes: 1_000_000,
});

/** Extension admission is shared; userscripts also inherit already visible document starts. */
export const DEEPL_WEB_SCHEDULING = Object.freeze({
  maxConcurrent: 8,
  intervalMs: 100,
  maxQueuedRequests: 64,
  startWindow: Object.freeze({ maxStarts: 30, durationMs: 12_000 }),
});

/** Userscript transport allowance; the extra time is client headroom, not an upstream quota. */
export const DEEPL_USERSCRIPT_SCHEDULING = Object.freeze({
  ...DEEPL_WEB_SCHEDULING,
  maxConcurrent: 7,
  startWindow: Object.freeze({ ...DEEPL_WEB_SCHEDULING.startWindow, durationMs: 12_250 }),
});

export interface PageExecutionPolicy {
  readonly concurrency: number;
  readonly batchMaxItems: number;
  readonly batchTargetChars: number;
  readonly batchSeparatorChars: 0 | 1 | 2;
  readonly packing: 'ordered' | 'fill';
  readonly viewportPriority: boolean;
  readonly firstBatchMaxItems?: number;
  readonly firstBatchTargetChars?: number;
}

export const MODEL_PAGE_POLICY: PageExecutionPolicy = Object.freeze({
  concurrency: 32, batchMaxItems: 16, batchTargetChars: 1_600,
  batchSeparatorChars: 1, packing: 'ordered', viewportPriority: false,
});

const DEEPL_PAGE_POLICY: PageExecutionPolicy = Object.freeze({
  concurrency: DEEPL_WEB_SCHEDULING.maxConcurrent,
  batchMaxItems: DEEPL_WEB_LIMITS.maxBatchItems,
  batchTargetChars: DEEPL_WEB_LIMITS.maxBatchChars,
  batchSeparatorChars: 0,
  packing: 'fill',
  viewportPriority: true,
  firstBatchMaxItems: 2,
  firstBatchTargetChars: 800,
});

export function pageExecutionPolicy(engine?: TranslationEngine): PageExecutionPolicy {
  return engine === 'deepl-web' ? DEEPL_PAGE_POLICY : MODEL_PAGE_POLICY;
}
