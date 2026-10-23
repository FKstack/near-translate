import { describe, expect, it } from 'vitest';
import {
  LANGUAGES, DEFAULT_LANGUAGE_PAIR, isSourceLanguage, isTargetLanguage, resolveLanguagePair,
  readLanguagePair, languageName, languageLabel, languageFromTag, isTranslatableText,
  supportsWordDetails, supportsSentenceAnalysis,
} from '../../src/shared/languages';

describe('public language contract', () => {
  it('defines sixteen unique translation targets with readable names and labels', () => {
    const expected = ['zh-Hans', 'zh-Hant', 'en', 'ja', 'ko', 'de', 'fr', 'es', 'ru', 'pt', 'it', 'ar', 'hi', 'id', 'tr', 'vi'];
    expect(LANGUAGES.map(language => language.code)).toEqual(expected);
    expect(new Set(LANGUAGES.map(language => language.code)).size).toBe(16);
    for (const language of LANGUAGES) {
      expect(isTargetLanguage(language.code)).toBe(true);
      expect(isSourceLanguage(language.code)).toBe(true);
      expect(languageName(language.code)).toBe(language.name);
      expect(languageLabel(language.code)).toBe(language.label);
      expect(language.name.length).toBeGreaterThan(0);
      expect(language.label.length).toBeGreaterThan(0);
    }
    expect(isSourceLanguage('auto')).toBe(true);
    expect(isTargetLanguage('auto')).toBe(false);
  });

  it('defaults absent language choices to auto detection into Simplified Chinese', () => {
    expect(DEFAULT_LANGUAGE_PAIR).toEqual({ sourceLanguage: 'auto', targetLanguage: 'zh-Hans' });
    expect(resolveLanguagePair()).toEqual(DEFAULT_LANGUAGE_PAIR);
    expect(resolveLanguagePair({ sourceLanguage: undefined, targetLanguage: undefined })).toEqual(DEFAULT_LANGUAGE_PAIR);
    expect(resolveLanguagePair({ targetLanguage: 'en' })).toEqual({ sourceLanguage: 'auto', targetLanguage: 'en' });
    expect(resolveLanguagePair({ sourceLanguage: 'ja' })).toEqual({ sourceLanguage: 'ja', targetLanguage: 'zh-Hans' });
  });

  it.each([null, false, 0, {}, [], '', 'unsupported', 'ZH-HANS', 'zh-CN'])('rejects unsupported source and target values %j', value => {
    expect(isSourceLanguage(value)).toBe(false);
    expect(isTargetLanguage(value)).toBe(false);
    expect(() => resolveLanguagePair({ sourceLanguage: value })).toThrow(/源语言和目标语言/);
    expect(() => resolveLanguagePair({ targetLanguage: value })).toThrow(/源语言和目标语言/);
  });

  it('migrates invalid stored choices conservatively without mutating storage values', () => {
    const stored = { sourceLanguage: 'not-supported', targetLanguage: null };
    expect(readLanguagePair(stored)).toEqual(DEFAULT_LANGUAGE_PAIR);
    expect(stored).toEqual({ sourceLanguage: 'not-supported', targetLanguage: null });
    expect(readLanguagePair({ sourceLanguage: 'ja', targetLanguage: 'de' }))
      .toEqual({ sourceLanguage: 'ja', targetLanguage: 'de' });
  });

  it.each([
    ['en-US', 'en'], ['JA-jp', 'ja'], ['ko-KR', 'ko'], ['zh-CN', 'zh-Hans'],
    ['zh-Hans', 'zh-Hans'], ['zh-TW', 'zh-Hant'], ['zh-Hant-HK', 'zh-Hant'], ['ar-SA', 'ar'],
  ])('normalizes the document language hint %s to %s', (hint, expected) => {
    expect(languageFromTag(hint)).toBe(expected);
  });

  it('does not invent a supported language for an absent or unknown document hint', () => {
    for (const hint of [undefined, '', 'unknown', 'xx-YY', 'auto']) expect(languageFromTag(hint)).toBeUndefined();
  });

  it('limits dictionary and sentence schemas to their supported English-learning pairs', () => {
    expect(supportsWordDetails()).toBe(true);
    expect(supportsWordDetails({ sourceLanguage: 'en', targetLanguage: 'zh-Hant' })).toBe(true);
    expect(supportsWordDetails({ sourceLanguage: 'fr', targetLanguage: 'zh-Hans' })).toBe(false);
    expect(supportsWordDetails({ sourceLanguage: 'en', targetLanguage: 'en' })).toBe(false);
    expect(supportsSentenceAnalysis()).toBe(true);
    expect(supportsSentenceAnalysis({ sourceLanguage: 'en', targetLanguage: 'zh-Hant' })).toBe(false);
    expect(supportsSentenceAnalysis({ sourceLanguage: 'ja', targetLanguage: 'zh-Hans' })).toBe(false);
  });
});

describe('multilingual text eligibility', () => {
  it('does not retranslate Chinese prose merely because it contains an English product name', () => {
    const chinese = '这里介绍 DeepSeek 模型的配置与使用方法，阅读模式会完整保留文章正文，方便继续阅读。';
    expect(isTranslatableText(chinese)).toBe(false);
    expect(isTranslatableText(chinese, {}, 'zh-CN')).toBe(false);
    expect(isTranslatableText('This is a complete English paragraph for translation.')).toBe(true);
  });

  it.each([
    ['Japanese', '日本語の文章です。'], ['Korean', '이 문장은 한국어로 작성되었습니다.'],
    ['Russian', 'Этот текст написан на русском языке.'], ['Arabic', 'هذه فقرة مكتوبة باللغة العربية.'],
    ['Hindi', 'यह अनुच्छेद हिंदी में लिखा गया है।'], ['Indonesian', 'Perpustakaan dibuka setiap pagi.'],
    ['Turkish', 'Kütüphane her sabah açılır.'], ['Vietnamese', 'Thư viện mở cửa vào mỗi buổi sáng.'],
  ])('admits %s text without requiring ASCII letters', (_name, source) => {
    expect(isTranslatableText(source)).toBe(true);
  });

  it('admits pure-Han Japanese when its source is explicitly Japanese', () => {
    expect(isTranslatableText('情報処理学会', { sourceLanguage: 'ja', targetLanguage: 'zh-Hans' })).toBe(true);
    expect(isTranslatableText('情報処理学会', { sourceLanguage: 'ja', targetLanguage: 'zh-Hans' }, 'zh-CN')).toBe(true);
  });

  it('admits Chinese to English and Simplified/Traditional conversion', () => {
    expect(isTranslatableText('这是一篇中文文章。', { sourceLanguage: 'zh-Hans', targetLanguage: 'en' })).toBe(true);
    expect(isTranslatableText('中文文章转换测试', { sourceLanguage: 'zh-Hans', targetLanguage: 'zh-Hant' })).toBe(true);
    expect(isTranslatableText('這是一篇中文文章。', { targetLanguage: 'en' }, 'zh-TW')).toBe(true);
  });

  it.each(LANGUAGES)('skips an explicitly identical $code source and target', ({ code }) => {
    expect(isTranslatableText('A meaningful source passage.', { sourceLanguage: code, targetLanguage: code })).toBe(false);
  });

  it('does not let a mismatched document hint hide text written in a clearly different language script', () => {
    expect(isTranslatableText('An English paragraph remains translatable.', {}, 'zh-CN')).toBe(true);
    expect(isTranslatableText('日本語の文章です。', {}, 'zh-CN')).toBe(true);
    expect(isTranslatableText('한국어 문장입니다.', {}, 'zh-CN')).toBe(true);
    expect(isTranslatableText('Русский текст.', { targetLanguage: 'en' }, 'en-US')).toBe(true);
    expect(isTranslatableText('هذه فقرة عربية.', { targetLanguage: 'en' }, 'en-US')).toBe(true);
  });

  it.each(['', '   ', '12345 + 6789', '# ¶ !', 'https://example.test/article', 'www.example.test'])('skips non-prose %j', source => {
    expect(isTranslatableText(source)).toBe(false);
  });
});
