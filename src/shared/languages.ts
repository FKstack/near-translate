/** One public language contract shared by settings, content selection and providers. */
export const LANGUAGES = [
  { code: 'zh-Hans', label: '简体中文', name: 'Simplified Chinese' },
  { code: 'zh-Hant', label: '繁體中文', name: 'Traditional Chinese' },
  { code: 'en', label: '英语', name: 'English' },
  { code: 'ja', label: '日语', name: 'Japanese' },
  { code: 'ko', label: '韩语', name: 'Korean' },
  { code: 'de', label: '德语', name: 'German' },
  { code: 'fr', label: '法语', name: 'French' },
  { code: 'es', label: '西班牙语', name: 'Spanish' },
  { code: 'ru', label: '俄语', name: 'Russian' },
  { code: 'pt', label: '葡萄牙语', name: 'Portuguese' },
  { code: 'it', label: '意大利语', name: 'Italian' },
  { code: 'ar', label: '阿拉伯语', name: 'Arabic' },
  { code: 'hi', label: '印地语', name: 'Hindi' },
  { code: 'id', label: '印尼语', name: 'Indonesian' },
  { code: 'tr', label: '土耳其语', name: 'Turkish' },
  { code: 'vi', label: '越南语', name: 'Vietnamese' },
] as const;

export type TargetLanguage = typeof LANGUAGES[number]['code'];
export type SourceLanguage = 'auto' | TargetLanguage;
export interface LanguagePair { sourceLanguage: SourceLanguage; targetLanguage: TargetLanguage }
export interface LanguageOptions { sourceLanguage?: SourceLanguage; targetLanguage?: TargetLanguage }
export const DEFAULT_LANGUAGE_PAIR: Readonly<LanguagePair> = { sourceLanguage: 'auto', targetLanguage: 'zh-Hans' };

export function isTargetLanguage(value: unknown): value is TargetLanguage {
  return typeof value === 'string' && LANGUAGES.some(language => language.code === value);
}
export function isSourceLanguage(value: unknown): value is SourceLanguage { return value === 'auto' || isTargetLanguage(value); }

/** Strict at request/save boundaries. Absent fields keep the legacy auto → Simplified Chinese behavior. */
export function resolveLanguagePair(value: { sourceLanguage?: unknown; targetLanguage?: unknown } = {}): LanguagePair {
  const sourceLanguage = value.sourceLanguage === undefined ? DEFAULT_LANGUAGE_PAIR.sourceLanguage : value.sourceLanguage;
  const targetLanguage = value.targetLanguage === undefined ? DEFAULT_LANGUAGE_PAIR.targetLanguage : value.targetLanguage;
  if (!isSourceLanguage(sourceLanguage) || !isTargetLanguage(targetLanguage)) throw new Error('请选择支持的源语言和目标语言。');
  return { sourceLanguage, targetLanguage };
}

/** Stored settings are migrated conservatively; unknown old fields never become request parameters. */
export function readLanguagePair(value: { sourceLanguage?: unknown; targetLanguage?: unknown }): LanguagePair {
  return { sourceLanguage: isSourceLanguage(value.sourceLanguage) ? value.sourceLanguage : 'auto',
    targetLanguage: isTargetLanguage(value.targetLanguage) ? value.targetLanguage : 'zh-Hans' };
}
export function languageName(code: SourceLanguage): string {
  return code === 'auto' ? 'automatically detected source language' : LANGUAGES.find(language => language.code === code)!.name;
}
export function languageLabel(code: SourceLanguage): string {
  return code === 'auto' ? '自动识别' : LANGUAGES.find(language => language.code === code)!.label;
}

export function supportsWordDetails(options: LanguageOptions = {}): boolean {
  const pair = resolveLanguagePair(options);
  return (pair.sourceLanguage === 'auto' || pair.sourceLanguage === 'en') && /^zh-Han[st]$/.test(pair.targetLanguage);
}
export function supportsSentenceAnalysis(options: LanguageOptions = {}): boolean {
  const pair = resolveLanguagePair(options);
  return (pair.sourceLanguage === 'auto' || pair.sourceLanguage === 'en') && pair.targetLanguage === 'zh-Hans';
}

/** Normalize document lang hints only; an unknown hint must not pretend to be a detected language. */
export function languageFromTag(tag: string | undefined): TargetLanguage | undefined {
  const value = tag?.trim().toLowerCase();
  if (!value) return undefined;
  if (/^zh(?:-|$)/.test(value)) return /(?:hant|tw|hk|mo)/.test(value) ? 'zh-Hant' : 'zh-Hans';
  return LANGUAGES.find(language => language.code.toLowerCase() === value.split('-')[0])?.code;
}

/** Script-level fallback for text eligibility; providers still own actual automatic language detection. */
export function isTranslatableText(text: string, options: LanguageOptions = {}, languageHint?: string): boolean {
  const trimmed = text.trim();
  if (!/\p{L}/u.test(trimmed) || /^\s*(?:https?:\/\/|www\.)\S+\s*$/i.test(trimmed)) return false;
  const pair = resolveLanguagePair(options);
  const hint = pair.sourceLanguage === 'auto' ? languageFromTag(languageHint) : pair.sourceLanguage;
  if (pair.sourceLanguage !== 'auto' && pair.sourceLanguage === pair.targetLanguage) return false;
  if (pair.targetLanguage === 'zh-Hans' || pair.targetLanguage === 'zh-Hant') {
    if (hint === 'ja' || (hint?.startsWith('zh-') && hint !== pair.targetLanguage)) return true;
    const han = text.match(/\p{Script=Han}/gu)?.length ?? 0;
    const other = (text.match(/\p{L}/gu)?.length ?? 0) - han;
    return other > 0 && (/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text) || other > han * 2);
  }
  if (hint === pair.targetLanguage) {
    const scripts: Record<TargetLanguage, RegExp> = {
      'zh-Hans': /\p{Script=Han}/gu, 'zh-Hant': /\p{Script=Han}/gu,
      en: /\p{Script=Latin}/gu, de: /\p{Script=Latin}/gu, fr: /\p{Script=Latin}/gu,
      es: /\p{Script=Latin}/gu, pt: /\p{Script=Latin}/gu, it: /\p{Script=Latin}/gu,
      ja: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu,
      ko: /\p{Script=Hangul}/gu, ru: /\p{Script=Cyrillic}/gu, ar: /\p{Script=Arabic}/gu,
      hi: /\p{Script=Devanagari}/gu, id: /\p{Script=Latin}/gu, tr: /\p{Script=Latin}/gu, vi: /\p{Script=Latin}/gu,
    };
    const native = text.match(scripts[pair.targetLanguage])?.length ?? 0;
    const letters = text.match(/\p{L}/gu)?.length ?? 0;
    if (native > letters / 2) return false;
  }
  return true;
}
