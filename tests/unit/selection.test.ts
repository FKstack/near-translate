import { describe, expect, it } from 'vitest';
import { boundedContext, classifySelection, isEnglishSelection, placeOverlay, selectionError } from '../../src/selection/helpers';

describe('selection boundaries', () => {
  it('identifies a word without treating punctuation or phrases as one', () => {
    expect(classifySelection("don't")).toBe('word');
    expect(classifySelection('load-bearing')).toBe('word');
    expect(classifySelection('finite element')).toBe('text');
    expect(isEnglishSelection('中文 123')).toBe(false);
    expect(isEnglishSelection('模型 error')).toBe(true);
  });
  it('rejects oversized targets rather than silently truncating them', () => {
    expect(selectionError('a'.repeat(12_000))).toBeUndefined();
    expect(selectionError('a'.repeat(12_001))).toContain('12,000');
  });
  it('keeps a selected ambiguous word within its bounded sentence context', () => {
    expect(boundedContext('Open the file. The bank raised rates. Prices fell.', 'bank', 'word')).toBe('The bank raised rates.');
    const block = `${'x '.repeat(500)}bank${' y'.repeat(500)}`;
    const context = boundedContext(block, 'bank', 'word');
    expect(context?.length).toBeLessThanOrEqual(600);
    expect(context).toContain('bank');
  });
  it('only supplies surrounding context for a complete sentence selection', () => {
    const context = boundedContext('Previous sentence. Target sentence. Next sentence.', 'Target sentence.', 'text');
    expect(context).toBe('Previous sentence.');
    expect(boundedContext('Target sentence. Next sentence. Last sentence.', 'Target sentence.', 'text')).toBe('Next sentence.');
  });
  it('excludes the previous sentence for a word selected at a sentence start', () => {
    expect(boundedContext('Open the file. Bank loans increased. Prices fell.', 'Bank', 'word')).toBe('Bank loans increased.');
    expect(boundedContext('Bank loans increased. Prices fell.', 'Bank', 'word')).toBe('Bank loans increased.');
  });
  it('uses the containing sentence for a phrase and only one neighbor for a paragraph', () => {
    expect(boundedContext('The finite element method is useful. It converges.', 'finite element', 'text')).toBe('The finite element method is useful.');
    expect(boundedContext('Previous sentence. First paragraph sentence. Second paragraph sentence. Next sentence.', 'First paragraph sentence. Second paragraph sentence.', 'text')).toBe('Previous sentence.');
    expect(boundedContext('Only selected text.', 'Only selected text.', 'text')).toBeUndefined();
  });
  it('uses reliable DOM offsets to disambiguate repeated words', () => {
    const block = 'The bank raised rates. The river bank flooded.';
    expect(boundedContext(block, 'bank', 'word')).toBeUndefined();
    expect(boundedContext(block, 'bank', 'word', block.lastIndexOf('bank'))).toBe('The river bank flooded.');
    expect(boundedContext(block, 'bank', 'word', 0)).toBeUndefined();
  });
  it('places the card above a bottom-edge anchor and clamps both edges', () => {
    expect(placeOverlay({ x: 900, y: 700 }, 420, 300, { width: 1000, height: 800 })).toEqual({ x: 570, y: 390 });
    expect(placeOverlay({ x: -100, y: -100 }, 36, 36, { width: 1000, height: 800 })).toEqual({ x: 10, y: 10 });
  });
});
