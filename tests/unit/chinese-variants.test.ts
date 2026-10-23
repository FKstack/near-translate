import { describe, expect, it, vi } from 'vitest';
import { normalizeChineseVariant } from '../../src/core/chinese-variants';
import { LANGUAGES } from '../../src/shared/languages';

vi.mock('opencc-js/core', async importOriginal => {
  const core = await importOriginal<typeof import('opencc-js/core')>();
  return { ...core, ConverterFactory: vi.fn(core.ConverterFactory) };
});

describe('local Chinese target variant normalization', () => {
  it('normalizes the unchanged Traditional Chinese MDN notice into Simplified Chinese', () => {
    const source = '此頁面由社群從英文翻譯而來。了解更多並加入 MDN Web Docs 社群。';
    expect(normalizeChineseVariant(source, 'zh-Hans'))
      .toBe('此页面由社群从英文翻译而来。了解更多并加入 MDN Web Docs 社群。');
  });

  it('uses generic Traditional Chinese without replacing vocabulary with Taiwan terms', () => {
    expect(normalizeChineseVariant('软件与数据库、网络和鼠标。', 'zh-Hant'))
      .toBe('軟件與數據庫、網絡和鼠標。');
  });

  it('uses phrase context for characters with multiple Traditional Chinese forms', () => {
    expect(normalizeChineseVariant('头发与发展。', 'zh-Hant')).toBe('頭髮與發展。');
    expect(normalizeChineseVariant('頭髮與發展。', 'zh-Hans')).toBe('头发与发展。');
  });

  it('preserves astral characters, combining accents, literal markup and whitespace', () => {
    const source = '𠮷 😀 e\u0301 𝄞 <code>translate()</code>\n\t头发\r\n';
    const expected = '𠮷 😀 e\u0301 𝄞 <code>translate()</code>\n\t頭髮\r\n';
    expect(normalizeChineseVariant(source, 'zh-Hant')).toBe(expected);
    expect(normalizeChineseVariant(expected, 'zh-Hans')).toBe(source);
  });

  it.each(LANGUAGES.filter(({ code }) => !code.startsWith('zh-')))('leaves the $code target byte-for-byte unchanged', ({ code }) => {
    const source = '简体与繁體，头发與頭髮。日本語 한국어 العربية हिन्दी tiếng Việt 😀 e\u0301\n\t';
    expect(normalizeChineseVariant(source, code)).toBe(source);
  });

  it('returns empty Chinese output unchanged', () => {
    expect(normalizeChineseVariant('', 'zh-Hans')).toBe('');
    expect(normalizeChineseVariant('', 'zh-Hant')).toBe('');
  });

  it('builds each needed converter lazily once and reuses it for subsequent segments', async () => {
    vi.resetModules();
    const core = await import('opencc-js/core');
    const build = vi.mocked(core.ConverterFactory);
    build.mockClear();
    const { normalizeChineseVariant: normalize } = await import('../../src/core/chinese-variants');
    expect(build).not.toHaveBeenCalled();
    expect(normalize('繁體与简体', 'ja')).toBe('繁體与简体');
    expect(normalize('', 'zh-Hans')).toBe('');
    expect(build).not.toHaveBeenCalled();
    expect(normalize('繁體', 'zh-Hans')).toBe('繁体');
    expect(normalize('翻譯', 'zh-Hans')).toBe('翻译');
    expect(build).toHaveBeenCalledOnce();
    expect(normalize('头发', 'zh-Hant')).toBe('頭髮');
    expect(normalize('发展', 'zh-Hant')).toBe('發展');
    expect(build).toHaveBeenCalledTimes(2);
  });
});
