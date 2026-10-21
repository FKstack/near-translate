import { describe, expect, it } from 'vitest';
import { PAGE_BATCH_TARGET_CHARS, splitPageBatchText } from '../../src/page/batches';

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
});
