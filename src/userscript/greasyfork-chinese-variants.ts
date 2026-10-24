import type { TargetLanguage } from '../shared/languages';

type Converter = (text: string) => string;
interface OpenCCLibrary {
  ConverterFactory(dictionary: string[]): Converter;
  Locale: { from: { cn: string[] }; to: { cn: string[] } };
}

// Greasy Fork only: @require supplies the official OpenCC JavaScript 1.4.2 UMD
// library inside the userscript sandbox. Both generic cn dictionaries exactly
// match the dictionaries used by the bundled GitHub/extension distribution.
declare const OpenCC: OpenCCLibrary;
let simplified: Converter | undefined;
let traditional: Converter | undefined;

export function normalizeChineseVariant(text: string, targetLanguage: TargetLanguage): string {
  if (!text || (targetLanguage !== 'zh-Hans' && targetLanguage !== 'zh-Hant')) return text;
  if (typeof OpenCC === 'undefined' || typeof OpenCC.ConverterFactory !== 'function'
    || !Array.isArray(OpenCC.Locale?.from?.cn) || !Array.isArray(OpenCC.Locale?.to?.cn)) {
    throw new Error('OpenCC 字形库尚未加载，请检查篡改猴依赖下载后重新打开页面。');
  }
  if (targetLanguage === 'zh-Hans') return (simplified ??= OpenCC.ConverterFactory(OpenCC.Locale.to.cn))(text);
  return (traditional ??= OpenCC.ConverterFactory(OpenCC.Locale.from.cn))(text);
}
