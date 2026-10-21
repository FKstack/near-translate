import type { GrammarCategory, SentenceAnalysis } from '../../shared/contracts';
import { normalizeGrammarCategory } from '../../core/sentence-analysis';

export const GRAMMAR_LABELS: Record<GrammarCategory, string> = {
  subject: '主语', predicate: '谓语', object: '宾语', clause: '从句', modifier: '修饰成分', other: '其他',
};

export interface SentenceHighlight {
  index: number;
  start: number;
  end: number;
  category: GrammarCategory;
  label: string;
  text: string;
}

/** Keep a reverse UTF-16 map while matching the parser's whitespace-normalized passages. */
function indexedSource(source: string): { text: string; starts: number[]; ends: number[] } {
  let text = '';
  const starts: number[] = [];
  const ends: number[] = [];
  for (let index = 0; index < source.length;) {
    if (/\s/u.test(source[index]!)) {
      const start = index;
      while (index < source.length && /\s/u.test(source[index]!)) index++;
      if (text && index < source.length) { text += ' '; starts.push(start); ends.push(index); }
    } else {
      text += source[index]!;
      starts.push(index); ends.push(++index);
    }
  }
  return { text, starts, ends };
}

function dividesSurrogate(source: string, offset: number): boolean {
  const before = source.charCodeAt(offset - 1);
  const after = source.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

/** All or nothing: never place a grammar color on an approximate or shifted match. */
export function mapSentenceHighlights(source: string, analysis: SentenceAnalysis): SentenceHighlight[] | undefined {
  if (!source || !analysis.chunks?.length) return;
  const original = indexedSource(source);
  const ranges: SentenceHighlight[] = [];
  let cursor = 0;
  for (const [index, chunk] of analysis.chunks.entries()) {
    const needle = chunk.text.replace(/\s+/gu, ' ').trim();
    if (!needle) return;
    const found = original.text.indexOf(needle, cursor);
    if (found < 0 || /[\p{L}\p{N}]/u.test(original.text.slice(cursor, found))) return;
    const end = found + needle.length;
    const sourceStart = original.starts[found];
    const sourceEnd = original.ends[end - 1];
    if (sourceStart === undefined || sourceEnd === undefined
      || dividesSurrogate(source, sourceStart) || dividesSurrogate(source, sourceEnd)) return;
    const category = normalizeGrammarCategory(chunk.role, chunk.category);
    ranges.push({ index, start: sourceStart, end: sourceEnd, category, label: GRAMMAR_LABELS[category],
      text: source.slice(sourceStart, sourceEnd) });
    cursor = end;
  }
  if (/[\p{L}\p{N}]/u.test(original.text.slice(cursor))) return;
  return ranges;
}
