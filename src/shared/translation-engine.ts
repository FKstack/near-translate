import type { TranslationEngine } from './contracts';

/** Permission pattern; the request destination is separately fixed below. */
export const DEEPL_WEB_ORIGIN = 'https://oneshot-free.www.deepl.com/*';
export const DEEPL_WEB_ENDPOINT = 'https://oneshot-free.www.deepl.com/v1/translate';
/** Optional capability for own-worker HTTP preparation; ordinary POST translation does not require it. */
export const DEEPL_WEB_PREPARATION_PERMISSION = 'declarativeNetRequestWithHostAccess' as const;
/** @deprecated Legacy cleanup alias; new preparation code uses DEEPL_WEB_PREPARATION_PERMISSION. */
export const DEEPL_WEB_PERMISSION = DEEPL_WEB_PREPARATION_PERMISSION;

export function isTranslationEngine(value: unknown): value is TranslationEngine {
  return value === 'model' || value === 'deepl-web';
}

export function normalizeTranslationEngine(value: unknown): TranslationEngine {
  return value === 'deepl-web' ? 'deepl-web' : 'model';
}
