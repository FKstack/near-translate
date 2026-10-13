import { MAX_CONTEXT_LENGTH, MAX_TEXT_LENGTH, type TranslationInput } from '../shared/contracts';
import { TranslationFailure } from './errors';

export function isEnglishWord(text: string): boolean {
  return /^[A-Za-z]+(?:['’\-][A-Za-z]+)*$/.test(text.trim());
}

/** Validate again in the background: content scripts are not a trusted input boundary. */
export function normalizeTranslationInput(value: unknown): TranslationInput {
  if (!value || typeof value !== 'object') {
    throw new TranslationFailure('INVALID_INPUT', '请选择需要翻译的英文。');
  }
  const input = value as Record<string, unknown>;
  if (typeof input.text !== 'string' || (input.kind !== 'word' && input.kind !== 'text')) {
    throw new TranslationFailure('INVALID_INPUT', '翻译内容格式不正确，请重新选择。');
  }
  const text = input.text.replace(/\r\n?/g, '\n').trim();
  if (!text) throw new TranslationFailure('INVALID_INPUT', '请选择需要翻译的英文。');
  if (text.length > MAX_TEXT_LENGTH) {
    throw new TranslationFailure('INVALID_INPUT', `一次最多翻译 ${MAX_TEXT_LENGTH.toLocaleString('zh-CN')} 个字符，请缩短选区。`);
  }
  if (input.kind === 'word' && !isEnglishWord(text)) {
    throw new TranslationFailure('INVALID_INPUT', '单词选区格式不正确，请重新选择。');
  }
  if (input.context !== undefined && typeof input.context !== 'string') {
    throw new TranslationFailure('INVALID_INPUT', '上下文格式不正确，请重新选择。');
  }
  const context = typeof input.context === 'string'
    ? input.context.replace(/\r\n?/g, '\n').trim().slice(0, MAX_CONTEXT_LENGTH)
    : '';
  return { text, kind: input.kind, ...(context ? { context } : {}) };
}
