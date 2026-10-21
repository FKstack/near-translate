import { MAX_SENTENCE_ANALYSIS_LENGTH, type GrammarCategory, type SentenceAnalysis } from '../shared/contracts';
import { TranslationFailure } from './errors';

export { MAX_SENTENCE_ANALYSIS_LENGTH } from '../shared/contracts';

const words = (text: string): string[] => text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? [];
const compact = (text: string): string => text.replace(/\s+/g, ' ').trim();
const GRAMMAR_CATEGORIES = new Set<GrammarCategory>(['subject', 'predicate', 'object', 'clause', 'modifier', 'other']);

/** Whitelisted presentation categories, including conservative interpretation of older role-only output. */
export function normalizeGrammarCategory(role: string, category?: GrammarCategory): GrammarCategory {
  if (category && GRAMMAR_CATEGORIES.has(category)) return category;
  if (role.includes('从句')) return 'clause';
  // In these labels “主语/宾语/谓语” describes the modifier's attachment, not its own role.
  if (/补(?:足)?语|非谓语/.test(role)) return 'modifier';
  const subject = role.includes('主语');
  const predicate = /谓语|系动词/.test(role);
  const object = role.includes('宾语');
  if ([subject, predicate, object].filter(Boolean).length > 1) return 'other';
  if (subject) return 'subject';
  if (predicate) return 'predicate';
  if (object) return 'object';
  if (/状语|定语|补语|表语|介词短语|分词/.test(role)) return 'modifier';
  return 'other';
}

/** Sentence analysis is an explicit selection follow-up, never a whole-page or word operation. */
export function canAnalyzeSentence(raw: string): boolean {
  const text = raw.replace(/\r\n?/g, '\n').trim();
  if (!text || text.length > MAX_SENTENCE_ANALYSIS_LENGTH) return false;
  const englishWords = text.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) ?? [];
  if (englishWords.length < 6) return false;
  const englishLetters = text.match(/[A-Za-z]/g)?.length ?? 0;
  const allLetters = text.match(/\p{L}/gu)?.length ?? 0;
  if (!allLetters || englishLetters < allLetters * 0.7) return false;
  const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
  return [...segmenter.segment(text)].filter(part => /[\p{L}\p{N}]/u.test(part.segment)).length === 1;
}

function invalid(): never {
  throw new TranslationFailure('INVALID_RESPONSE', '句子分析格式不完整或与原文不符，请重试分析。', true);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function field(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum) invalid();
  return value.trim();
}

/** Validates analysis independently, so malformed grammar output cannot replace a good translation. */
export function parseSentenceAnalysis(content: string, original: string): SentenceAnalysis {
  if (content.length > 30_000) invalid();
  let value: unknown;
  try { value = JSON.parse(content); }
  catch { invalid(); }
  if (!record(value) || !record(value.mainClause) || !Array.isArray(value.chunks)
    || value.chunks.length < 1 || value.chunks.length > 12) invalid();
  const mainClause = {
    text: field(value.mainClause.text, MAX_SENTENCE_ANALYSIS_LENGTH),
    translation: field(value.mainClause.translation, 4_000),
    explanation: field(value.mainClause.explanation, 4_000),
  };
  const source = compact(original);
  const sourceWords = words(source);
  const mainWords = words(mainClause.text);
  if (!mainWords.length) invalid();
  let wordCursor = 0;
  for (const word of mainWords) {
    while (wordCursor < sourceWords.length && sourceWords[wordCursor] !== word) wordCursor++;
    if (wordCursor >= sourceWords.length) invalid();
    wordCursor++;
  }
  let cursor = 0;
  const chunks = value.chunks.map(chunk => {
    if (!record(chunk)) invalid();
    const text = field(chunk.text, MAX_SENTENCE_ANALYSIS_LENGTH);
    const needle = compact(text);
    const start = source.indexOf(needle, cursor);
    if (start < 0 || /[\p{L}\p{N}]/u.test(source.slice(cursor, start))) invalid();
    cursor = start + needle.length;
    if (chunk.category !== undefined && (typeof chunk.category !== 'string'
      || !GRAMMAR_CATEGORIES.has(chunk.category as GrammarCategory))) invalid();
    return { text, role: field(chunk.role, 100), explanation: field(chunk.explanation, 1_500),
      ...(chunk.category !== undefined ? { category: chunk.category as GrammarCategory } : {}) };
  });
  if (/[\p{L}\p{N}]/u.test(source.slice(cursor))) invalid();
  return { mainClause, chunks, readingGuide: field(value.readingGuide, 4_000) };
}
