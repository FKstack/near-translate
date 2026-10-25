import { TranslationFailure } from '../core/errors';
import type { DeepLWebTransport } from '../providers/deepl-web';
import { DEEPL_WEB_ENDPOINT } from '../shared/translation-engine';
import { createGMFetch } from './transport';

/** Fixed, content-free request lanes; the provider remains the only scheduler. */
export function createDeepLUserscriptTransport(beforeRequest?: () => Promise<void>): DeepLWebTransport {
  const endpoints = Array.from({ length: 8 }, (_, lane) => {
    const endpoint = new URL(DEEPL_WEB_ENDPOINT);
    endpoint.searchParams.set('near_translate_lane', String(lane));
    return endpoint.href;
  });
  const leases: Array<symbol | undefined> = Array(8).fill(undefined);
  return async (body, signal) => {
    signal.throwIfAborted();
    const lane = leases.findIndex(owner => owner === undefined);
    // The provider admits at most eight requests. Fail closed if that contract
    // is violated instead of adding another queue or reusing an occupied lane.
    if (lane < 0) throw new TranslationFailure('RATE_LIMIT', '等待 DeepL 翻译的任务较多，请稍后手动重试。', true);
    const owner = Symbol();
    leases[lane] = owner;
    const release = () => { if (leases[lane] === owner) leases[lane] = undefined; };
    const endpoint = endpoints[lane]!;
    try {
      return await createGMFetch(endpoint, beforeRequest, { responseType: 'text', onSettled: release })(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'None' },
        body, signal, credentials: 'omit', redirect: 'error',
      });
    } catch (error) {
      // Preflight validation can reject before a GM request and its hook exist.
      release();
      throw error;
    }
  };
}
