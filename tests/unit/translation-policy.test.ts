import { describe, expect, it } from 'vitest';
import { DEEPL_USERSCRIPT_SCHEDULING, DEEPL_WEB_LIMITS, DEEPL_WEB_SCHEDULING, pageExecutionPolicy } from '../../src/shared/translation-policy';

describe('platform-specific DeepL scheduling', () => {
  it('preserves extension admission while giving userscripts seven slots and explicit send-time headroom', () => {
    expect(DEEPL_WEB_SCHEDULING).toEqual({ maxConcurrent: 8, intervalMs: 100, maxQueuedRequests: 64,
      startWindow: { maxStarts: 30, durationMs: 12_000 } });
    expect(DEEPL_USERSCRIPT_SCHEDULING).toEqual({ maxConcurrent: 7, intervalMs: 100, maxQueuedRequests: 64,
      startWindow: { maxStarts: 30, durationMs: 12_250 } });
    expect(Object.isFrozen(DEEPL_USERSCRIPT_SCHEDULING)).toBe(true);
    expect(Object.isFrozen(DEEPL_USERSCRIPT_SCHEDULING.startWindow)).toBe(true);
    expect(DEEPL_USERSCRIPT_SCHEDULING.startWindow).not.toBe(DEEPL_WEB_SCHEDULING.startWindow);
  });

  it('keeps the existing page batches and producer workers for provider backpressure', () => {
    expect(DEEPL_WEB_LIMITS).toMatchObject({ maxBatchItems: 32, maxBatchChars: 1500 });
    expect(pageExecutionPolicy('deepl-web')).toEqual({ concurrency: 8, batchMaxItems: 32, batchTargetChars: 1500,
      batchSeparatorChars: 0, packing: 'fill', viewportPriority: true, firstBatchMaxItems: 2, firstBatchTargetChars: 800 });
    expect(pageExecutionPolicy('model')).toMatchObject({ concurrency: 32, batchMaxItems: 16, batchTargetChars: 1600 });
  });
});
