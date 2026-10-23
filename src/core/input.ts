import { MAX_CONTEXT_LENGTH, MAX_PAGE_BATCH_ITEMS, MAX_TEXT_LENGTH, type TranslationInput } from '../shared/contracts';
import { TranslationFailure } from './errors';
import { canAnalyzeSentence } from './sentence-analysis';
import { isSourceLanguage, isTargetLanguage, resolveLanguagePair, type LanguageOptions } from '../shared/languages';

export function isEnglishWord(text: string): boolean {
  return /^[A-Za-z]+(?:['’\-][A-Za-z]+)*$/.test(text.trim());
}

/** Validate again in the background: content scripts are not a trusted input boundary. */
export function normalizeTranslationInput(value: unknown): TranslationInput {
  if (!value || typeof value !== 'object') {
    throw new TranslationFailure('INVALID_INPUT', '请选择需要翻译的文字。');
  }
  const input = value as Record<string, unknown>;
  if (typeof input.text !== 'string' || (input.kind !== 'word' && input.kind !== 'text')) {
    throw new TranslationFailure('INVALID_INPUT', '翻译内容格式不正确，请重新选择。');
  }
  const languages: LanguageOptions = {};
  if (Object.hasOwn(input, 'sourceLanguage')) {
    if (!isSourceLanguage(input.sourceLanguage)) throw new TranslationFailure('INVALID_INPUT', '请选择支持的源语言。');
    languages.sourceLanguage = input.sourceLanguage;
  }
  if (Object.hasOwn(input, 'targetLanguage')) {
    if (!isTargetLanguage(input.targetLanguage)) throw new TranslationFailure('INVALID_INPUT', '请选择支持的目标语言。');
    languages.targetLanguage = input.targetLanguage;
  }
  const pair = resolveLanguagePair(languages);
  const englishSource = pair.sourceLanguage === 'auto' || pair.sourceLanguage === 'en';
  if (input.kind === 'word' && (!englishSource || !['zh-Hans', 'zh-Hant'].includes(pair.targetLanguage))) {
    throw new TranslationFailure('INVALID_INPUT', '英语词典仅支持英语到简体或繁体中文，请使用普通文本翻译。');
  }
  if (input.task === 'sentence-analysis' && (!englishSource || pair.targetLanguage !== 'zh-Hans')) {
    throw new TranslationFailure('INVALID_INPUT', '长难句拆解仅支持英语到简体中文，请使用普通文本翻译。');
  }
  if (input.task !== undefined && (input.task !== 'sentence-analysis' || input.kind !== 'text'
    || input.pageSegments !== undefined)) {
    throw new TranslationFailure('INVALID_INPUT', '句子分析请求格式不正确，请重新选择一句英文。');
  }
  let pageSegments: string[] | undefined;
  if (input.pageSegments !== undefined) {
    if (input.kind !== 'text' || !Array.isArray(input.pageSegments)
      || !input.pageSegments.length || input.pageSegments.length > MAX_PAGE_BATCH_ITEMS
      || input.pageSegments.some(part => typeof part !== 'string' || !part.trim())) {
      throw new TranslationFailure('INVALID_INPUT', '整页翻译分段格式不正确，请重新翻译。');
    }
    pageSegments = input.pageSegments.map(part => (part as string).replace(/\r\n?/g, '\n').trim());
  }
  const text = pageSegments ? pageSegments.join('\n') : input.text.replace(/\r\n?/g, '\n').trim();
  if (!text) throw new TranslationFailure('INVALID_INPUT', '请选择需要翻译的文字。');
  if (text.length > MAX_TEXT_LENGTH) {
    throw new TranslationFailure('INVALID_INPUT', `一次最多翻译 ${MAX_TEXT_LENGTH.toLocaleString('zh-CN')} 个字符，请缩短选区。`);
  }
  if (input.kind === 'word' && !isEnglishWord(text)) {
    throw new TranslationFailure('INVALID_INPUT', '单词选区格式不正确，请重新选择。');
  }
  if (input.task === 'sentence-analysis' && !canAnalyzeSentence(text)) {
    throw new TranslationFailure('INVALID_INPUT', '请选择至少六个英文单词、最多 2,000 字符的单句进行分析。');
  }
  if (input.context !== undefined && typeof input.context !== 'string') {
    throw new TranslationFailure('INVALID_INPUT', '上下文格式不正确，请重新选择。');
  }
  const context = typeof input.context === 'string'
    ? input.context.replace(/\r\n?/g, '\n').trim().slice(0, MAX_CONTEXT_LENGTH)
    : '';
  return { text, kind: input.kind, ...languages, ...(pageSegments ? { pageSegments } : context ? { context } : {}),
    ...(input.task === 'sentence-analysis' ? { task: input.task } : {}) };
}
