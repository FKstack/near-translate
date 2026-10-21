import { describe, expect, it } from 'vitest';
import type { GrammarCategory, SentenceAnalysis } from '../../src/shared/contracts';
import { mapSentenceHighlights } from '../../src/ui/translator/sentence-highlights';

function analysis(parts: Array<{ text: string; role: string; category?: GrammarCategory }>): SentenceAnalysis {
  return {
    mainClause: { text: '', translation: '', explanation: '' },
    chunks: parts.map(part => ({ ...part, explanation: '说明' })), readingGuide: '',
  };
}

function reconstruct(source: string, ranges: NonNullable<ReturnType<typeof mapSentenceHighlights>>): string {
  let result = '';
  let cursor = 0;
  for (const range of ranges) {
    result += source.slice(cursor, range.start) + range.text;
    cursor = range.end;
  }
  return result + source.slice(cursor);
}

describe('original sentence color ranges', () => {
  it('maps subject, predicate, object and a clause without changing source text', () => {
    const source = 'The team, which studied Go, published the report.';
    const ranges = mapSentenceHighlights(source, analysis([
      { text: 'The team,', role: '主语', category: 'subject' },
      { text: 'which studied Go,', role: '定语从句', category: 'clause' },
      { text: 'published', role: '谓语', category: 'predicate' },
      { text: 'the report.', role: '宾语', category: 'object' },
    ]))!;
    expect(ranges.map(range => range.category)).toEqual(['subject', 'clause', 'predicate', 'object']);
    expect(ranges.map(range => range.label)).toEqual(['主语', '从句', '谓语', '宾语']);
    expect(reconstruct(source, ranges)).toBe(source);
  });

  it('keeps tabs, repeated spaces, NBSP, CRLF and leading/trailing whitespace exactly', () => {
    const source = ' \tThe\u00a0\u00a0team,\r\nwhich studied Go,  published\tthe report.  ';
    const ranges = mapSentenceHighlights(source, analysis([
      { text: 'The team,', role: '主语' },
      { text: 'which studied Go,', role: '定语从句' },
      { text: 'published', role: '谓语' },
      { text: 'the report.', role: '宾语' },
    ]))!;
    expect(ranges[0]!.text).toBe('The\u00a0\u00a0team,');
    expect(source.slice(ranges[0]!.end, ranges[1]!.start)).toBe('\r\n');
    expect(reconstruct(source, ranges)).toBe(source);
  });

  it('maps repeated identical fragments to their own occurrence in reading order', () => {
    const source = 'The team saw the team.';
    const ranges = mapSentenceHighlights(source, analysis([
      { text: 'The team', role: '主语' }, { text: 'saw', role: '谓语' }, { text: 'the team', role: '宾语' },
    ]))!;
    expect(ranges.map(range => [range.start, range.end])).toEqual([[0, 8], [9, 12], [13, 21]]);
    expect(reconstruct(source, ranges)).toBe(source);
  });

  it('falls back to neutral color for an old mixed role instead of inventing a split', () => {
    const source = 'The report explains why the method works.';
    const ranges = mapSentenceHighlights(source, analysis([
      { text: 'The report', role: '主语核心' },
      { text: 'explains why the method works.', role: '谓语与宾语从句' },
    ]))!;
    expect(ranges.map(range => range.category)).toEqual(['subject', 'clause']);
    const mixed = mapSentenceHighlights('The team works.', analysis([{ text: 'The team works.', role: '主语与谓语' }]))!;
    expect(mixed[0]!.category).toBe('other');
  });

  it.each([
    [{ text: 'The team', role: '主语' }, { text: 'the report.', role: '宾语' }],
    [{ text: 'the report.', role: '宾语' }, { text: 'The team', role: '主语' }],
    [{ text: 'The teams', role: '主语' }, { text: 'published the report.', role: '谓语' }],
    [{ text: 'The team', role: '主语' }],
    [{ text: '', role: '主语' }],
  ].map(chunks => ({ chunks })))('leaves the source plain when a chunk is missing, shifted or mismatched: %j', ({ chunks }) => {
    expect(mapSentenceHighlights('The team published the report.', analysis(chunks))).toBeUndefined();
  });

  it('preserves non-BMP characters and punctuation between aligned passages', () => {
    const source = 'The team 😀 published the report.';
    const ranges = mapSentenceHighlights(source, analysis([
      { text: 'The team', role: '主语' }, { text: 'published', role: '谓语' }, { text: 'the report.', role: '宾语' },
    ]))!;
    expect(reconstruct(source, ranges)).toBe(source);
    expect(source.slice(ranges[0]!.end, ranges[1]!.start)).toBe(' 😀 ');
  });

  it('never produces a range splitting a surrogate pair', () => {
    const source = 'The team 😀 published the report.';
    expect(mapSentenceHighlights(source, analysis([
      { text: 'The team \ud83d', role: '主语' }, { text: '\ude00 published the report.', role: '修饰' },
    ]))).toBeUndefined();
  });
});
