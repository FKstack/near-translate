import { ConverterFactory, type ConverterFunction } from 'opencc-js/core';
import { from as cnSource } from 'opencc-js/preset/cn2t';
import { to as cnTarget } from 'opencc-js/preset/t2cn';
import type { TargetLanguage } from '../shared/languages';

// Only the generic cn dictionaries are used; regional vocabulary is not a target policy.
// Each immutable dictionary trie is built at most once for this module's lifetime.
let simplified: ConverterFunction | undefined;
let traditional: ConverterFunction | undefined;

/** Normalize a complete translated source segment, preserving all non-Chinese targets. */
export function normalizeChineseVariant(text: string, targetLanguage: TargetLanguage): string {
  if (!text) return text;
  if (targetLanguage === 'zh-Hans') return (simplified ??= ConverterFactory(cnTarget.cn!))(text);
  if (targetLanguage === 'zh-Hant') return (traditional ??= ConverterFactory(cnSource.cn!))(text);
  return text;
}
