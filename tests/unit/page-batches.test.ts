import { describe, expect, it } from 'vitest';
import { PAGE_BATCH_TARGET_CHARS, normalizePageBatchTargetChars, splitPageBatchText } from '../../src/page/batches';
import { MAX_TEXT_LENGTH } from '../../src/shared/contracts';

describe('page batch splitting', () => {
  it('keeps short passages whole without empty parts', () => {
    expect(splitPageBatchText('short paragraph')).toEqual(['short paragraph']);
    expect(splitPageBatchText('')).toEqual([]);
  });
  it('bounds parts without discarding whitespace or splitting Unicode surrogate pairs', () => {
    const text = 'some words. '.repeat(400) + '😀'.repeat(1700) + '\nlast sentence';
    const parts = splitPageBatchText(text);
    expect(parts.join('')).toBe(text);
    expect(parts.every(part => part.length <= PAGE_BATCH_TARGET_CHARS && part.length > 0)).toBe(true);
    expect(parts.every(part => !/[\uD800-\uDBFF]$/.test(part) && !/^[\uDC00-\uDFFF]/.test(part))).toBe(true);
  });
  it('prefers a sentence boundary over splitting a word', () => {
    const prefix = 'A'.repeat(900) + '. ';
    expect(splitPageBatchText(prefix + 'B'.repeat(900))[0]).toBe(prefix);
  });

  it('uses a service-specific budget without changing the model default', () => {
    const text = 'Long English paragraph. '.repeat(150);
    expect(splitPageBatchText(text, 4_800)).toEqual([text]);
    expect(splitPageBatchText(text).length).toBeGreaterThan(1);
    const longer = text.repeat(4) + '😀'.repeat(2_500);
    const parts = splitPageBatchText(longer, 4_800);
    expect(parts.join('')).toBe(longer);
    expect(parts.every(part => part.length <= 4_800 && !/[\uD800-\uDBFF]$/.test(part))).toBe(true);
  });

  it('bounds the configured budget and safely falls back for invalid values', () => {
    for (const value of [undefined, 0, 1, -10, NaN, Infinity, 1.5]) {
      expect(normalizePageBatchTargetChars(value)).toBe(PAGE_BATCH_TARGET_CHARS);
    }
    expect(normalizePageBatchTargetChars(MAX_TEXT_LENGTH * 2)).toBe(MAX_TEXT_LENGTH);
    expect(splitPageBatchText('😀😀', 2)).toEqual(['😀', '😀']);
  });
});
