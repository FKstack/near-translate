import { describe, expect, it } from 'vitest';
import { DEEPL_USERSCRIPT_SCHEDULING, DEEPL_WEB_LIMITS, DEEPL_WEB_SCHEDULING, pageExecutionPolicy, userscriptPageExecutionPolicy } from '../../src/shared/translation-policy';

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

  it('adds workload smoothing only to the userscript DeepL producer', () => {
    const userscript = userscriptPageExecutionPolicy('deepl-web');
    const { resolveConcurrency, automaticRecovery, ...unchanged } = userscript;
    expect(unchanged).toEqual(pageExecutionPolicy('deepl-web'));
    expect(resolveConcurrency).toBeTypeOf('function');
    expect(automaticRecovery).toEqual({ maxAttempts: 3, maxWaitMs: 900_000 });
    expect(Object.isFrozen(automaticRecovery)).toBe(true);
    expect(pageExecutionPolicy('deepl-web').resolveConcurrency).toBeUndefined();
    expect(pageExecutionPolicy('deepl-web').automaticRecovery).toBeUndefined();
    expect(userscriptPageExecutionPolicy('model').automaticRecovery).toBeUndefined();
    expect(userscriptPageExecutionPolicy('model')).toBe(pageExecutionPolicy('model'));
    expect(userscriptPageExecutionPolicy()).toBe(pageExecutionPolicy());
    expect(Object.isFrozen(userscript)).toBe(true);
  });

  it.each([
    { parts: [], expected: 1 },
    { parts: Array(8).fill(800), expected: 1 },
    { parts: Array(9).fill(800), expected: 8 },
    { parts: Array(6).fill(1_500), expected: 1 },
    { parts: Array(7).fill(1_500), expected: 8 },
    { parts: Array(8).fill(1_500), expected: 8 },
    { parts: Array(9).fill(1_500), expected: 8 },
    { parts: Array(226).fill(4), expected: 1 },
    { parts: Array(227).fill(4), expected: 8 },
    { parts: Array(1_000).fill(4), expected: 8 },
    { parts: [400, 400, ...Array(5).fill(1_500), 700], expected: 1 },
    { parts: [400, 400, ...Array(5).fill(1_500), 701], expected: 8 },
    { parts: [400, 400, ...Array(7).fill(1_500)], expected: 8 },
    { parts: [400, 400, ...Array(8).fill(1_500)], expected: 8 },
  ])('estimates request shapes with the real item/character and soft first-batch limits ($expected)', ({ parts, expected }) => {
    expect(userscriptPageExecutionPolicy('deepl-web').resolveConcurrency!(parts)).toBe(expected);
  });
});
