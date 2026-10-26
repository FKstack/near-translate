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

export interface PageAutomaticRecoveryPolicy {
  readonly maxAttempts: number;
  readonly maxWaitMs: number;
}

export interface PageExecutionPolicy {
  readonly concurrency: number;
  readonly resolveConcurrency?: (ownedPartLengths: readonly number[]) => number;
  readonly automaticRecovery?: PageAutomaticRecoveryPolicy;
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

/** A client workload estimate, independent of URLs and upstream quota assumptions. */
function userscriptDeepLConcurrency(ownedPartLengths: readonly number[]): number {
  let estimatedRequests = 0;
  let items = 0;
  let characters = 0;
  let sourceCharacters = 0;
  for (const length of ownedPartLengths) {
    if (!Number.isSafeInteger(length) || length <= 0 || length > DEEPL_WEB_LIMITS.maxBatchChars) return DEEPL_PAGE_POLICY.concurrency;
    sourceCharacters += length;
    // Keep client time headroom for larger payloads; this is not a service quota.
    if (sourceCharacters > 9_000) return DEEPL_PAGE_POLICY.concurrency;
    const first = estimatedRequests === 0;
    const maxItems = first ? DEEPL_PAGE_POLICY.firstBatchMaxItems! : DEEPL_PAGE_POLICY.batchMaxItems;
    const targetChars = first ? DEEPL_PAGE_POLICY.firstBatchTargetChars! : DEEPL_PAGE_POLICY.batchTargetChars;
    if (items && (items >= maxItems || characters + length > targetChars)) {
      estimatedRequests++;
      if (estimatedRequests >= DEEPL_PAGE_POLICY.concurrency) return DEEPL_PAGE_POLICY.concurrency;
      items = 0; characters = 0;
    }
    // Like the real soft first batch, its first intact part may exceed 800.
    items++; characters += length;
  }
  // Viewport ordering and tail filling can change actual wire grouping.
  return 1;
}

const DEEPL_USERSCRIPT_PAGE_POLICY: PageExecutionPolicy = Object.freeze({
  ...DEEPL_PAGE_POLICY,
  resolveConcurrency: userscriptDeepLConcurrency,
  automaticRecovery: Object.freeze({ maxAttempts: 3, maxWaitMs: 15 * 60_000 }),
});

export function userscriptPageExecutionPolicy(engine?: TranslationEngine): PageExecutionPolicy {
  return engine === 'deepl-web' ? DEEPL_USERSCRIPT_PAGE_POLICY : pageExecutionPolicy(engine);
}
