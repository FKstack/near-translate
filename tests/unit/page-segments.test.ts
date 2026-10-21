import { describe, expect, it } from 'vitest';
import { isTranslatablePageText, splitPageText } from '../../src/page/segments';
import { MAX_TEXT_LENGTH } from '../../src/shared/contracts';

describe('page translation text policy', () => {
  it('selects English prose and titles while avoiding Chinese copies and bare URLs', () => {
    expect(isTranslatablePageText('Abstract')).toBe(true);
    expect(isTranslatablePageText('Go at Google: Language Design in the Service of Software Engineering')).toBe(true);
    expect(isTranslatablePageText('Go 编程语言是为提高软件开发的效率而设计的。')).toBe(false);
    expect(isTranslatablePageText('这里介绍 DeepSeek 模型的配置与使用方法。')).toBe(false);
    expect(isTranslatablePageText('https://go.dev/doc/')).toBe(false);
    expect(isTranslatablePageText('123 + 456')).toBe(false);
  });

  it('returns ordinary paragraphs as a single complete request', () => {
    expect(splitPageText('Hello, world.')).toEqual(['Hello, world.']);
    expect(splitPageText('')).toEqual([]);
    expect(splitPageText('a'.repeat(MAX_TEXT_LENGTH))).toEqual(['a'.repeat(MAX_TEXT_LENGTH)]);
  });

  it('prefers sentence boundaries and keeps all whitespace and punctuation', () => {
    const first = 'a'.repeat(7_000) + '.\n\n';
    const text = first + 'b'.repeat(7_000) + '! Next sentence.';
    const chunks = splitPageText(text);
    expect(chunks[0]).toBe(first);
    expect(chunks.join('')).toBe(text);
    expect(chunks.every(chunk => chunk.length <= MAX_TEXT_LENGTH)).toBe(true);
  });

  it('uses whitespace then a hard boundary for very long unbroken prose', () => {
    const text = ('word '.repeat(5_000)) + 'x'.repeat(25_000);
    const chunks = splitPageText(text);
    expect(chunks.join('')).toBe(text);
    expect(chunks.every(chunk => chunk.length > 0 && chunk.length <= MAX_TEXT_LENGTH)).toBe(true);
    expect(chunks[0]?.endsWith(' ')).toBe(true);
  });

  it('does not split a surrogate pair at the hard limit', () => {
    const text = 'a'.repeat(MAX_TEXT_LENGTH - 1) + '😀' + 'b'.repeat(MAX_TEXT_LENGTH);
    const chunks = splitPageText(text);
    expect(chunks[0]?.length).toBe(MAX_TEXT_LENGTH - 1);
    expect(chunks[1]?.startsWith('😀')).toBe(true);
    expect(chunks.join('')).toBe(text);
  });
});
