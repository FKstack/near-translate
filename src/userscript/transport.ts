import { TranslationFailure } from '../core/errors';
import { REQUEST_TIMEOUT_MS } from '../shared/contracts';
import { requireSafeUserscriptNetwork, type GMResponse } from './gm';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const aborted = () => new DOMException('翻译请求已取消。', 'AbortError');
const networkFailure = () => new TypeError('Unable to connect to the configured translation service.');

function headersFrom(raw = ''): Headers {
  const headers = new Headers();
  for (const row of raw.slice(0, 64 * 1024).split(/\r?\n/)) {
    const separator = row.indexOf(':');
    if (separator < 1) continue;
    try { headers.append(row.slice(0, separator).trim(), row.slice(separator + 1).trim()); } catch { /* Ignore malformed optional headers. */ }
  }
  return headers;
}

/** A provider-bound adapter: the caller cannot supply arbitrary network destinations. */
export function createGMFetch(endpoint: string, beforeRequest?: () => Promise<void>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    try { requireSafeUserscriptNetwork(); }
    catch (error) { throw new TranslationFailure('CONFIG', error instanceof Error ? error.message : '请更新到新版篡改猴后使用网络翻译。'); }
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url !== endpoint || init?.method !== 'POST' || typeof init.body !== 'string'
      || init.credentials !== 'omit' || init.redirect !== 'error') {
      throw new TranslationFailure('CONFIG', '翻译请求与已保存的服务配置不一致。');
    }
    const signal = init.signal;
    if (signal?.aborted) throw signal.reason ?? aborted();
    if (beforeRequest) await beforeRequest();
    if (signal?.aborted) throw signal.reason ?? aborted();
    if (typeof GM_xmlhttpRequest !== 'function') throw new TranslationFailure('CONFIG', '当前用户脚本管理器缺少跨域请求支持。');
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      if (!['authorization', 'content-type', 'accept', 'x-goog-api-client'].includes(key)) {
        throw new TranslationFailure('CONFIG', '翻译请求包含不支持的请求头。');
      }
      headers[key] = value;
    });
    return new Promise<Response>((resolve, reject) => {
      let request: { abort(): void } | undefined;
      let responseOpened = false;
      let finished = false;
      let streaming = false;
      let cursor = 0;
      let bytes = 0;
      let streamController!: ReadableStreamDefaultController<Uint8Array>;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) { streamController = controller; },
        cancel() { fail(aborted()); },
      });
      // The body may fail before a Response is exposed. Mark that rejection handled.
      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
      };
      const fail = (error: unknown) => {
        if (finished) return; finished = true; cleanup();
        reject(error);
        try { streamController.error(error); } catch { /* Already closed by the consumer. */ }
        void reader?.cancel().catch(() => {});
        try { request?.abort(); } catch { /* A closed GM request needs no further cleanup. */ }
      };
      const onAbort = () => fail(signal?.reason ?? aborted());
      const timeout = setTimeout(() => fail(new TranslationFailure('TIMEOUT', '翻译服务响应超时，请重试。', true)), REQUEST_TIMEOUT_MS);
      const close = () => {
        if (finished) return; finished = true; cleanup();
        try { streamController.close(); } catch { /* Cancelled response. */ }
      };
      const push = (chunk: Uint8Array) => {
        if (finished || !chunk.byteLength) return;
        bytes += chunk.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) { fail(new TranslationFailure('INVALID_RESPONSE', '翻译服务响应过大，请缩短内容后重试。', true)); return; }
        streamController.enqueue(chunk);
      };
      const open = (response: GMResponse): boolean => {
        if (finished) return false;
        // redirect:error prevents credential forwarding; finalUrl independently verifies the result.
        if ((response.finalUrl && response.finalUrl !== endpoint) || (response.status >= 300 && response.status < 400)) {
          fail(new TranslationFailure('NETWORK', '翻译服务发生了重定向，请核对已保存的 API 地址。', false)); return false;
        }
        if (!responseOpened && Number.isInteger(response.status) && response.status >= 200 && response.status <= 599) {
          responseOpened = true;
          try { resolve(new Response([204, 205, 304].includes(response.status) ? null : body,
            { status: response.status, headers: headersFrom(response.responseHeaders) })); }
          catch { fail(networkFailure()); return false; }
        }
        return responseOpened;
      };
      const receive = (response: GMResponse, complete = false) => {
        if (!open(response) || finished) return;
        const value = response.response;
        if (!streaming && value && typeof (value as ReadableStream<Uint8Array>).getReader === 'function') {
          streaming = true;
          reader = (value as ReadableStream<Uint8Array>).getReader();
          void (async () => {
            try {
              while (!finished) {
                const chunk = await reader!.read();
                if (chunk.done) { close(); return; }
                if (!(chunk.value instanceof Uint8Array)) { fail(networkFailure()); return; }
                push(chunk.value);
              }
            } catch { fail(networkFailure()); }
            finally { try { reader?.releaseLock(); } catch { /* Pending cancellation. */ } }
          })();
        } else if (!streaming && typeof response.responseText === 'string') {
          // Older managers may deliver only the complete text on onload.
          const text = response.responseText;
          if (text.length < cursor) { fail(networkFailure()); return; }
          // Preserve a split UTF-16 surrogate pair in incremental text fallbacks.
          let end = text.length;
          if (!complete && end && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end--;
          if (end > cursor) { push(encoder.encode(text.slice(cursor, end))); cursor = end; }
        }
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        request = GM_xmlhttpRequest({ method: 'POST', url: endpoint, headers, data: init.body as string,
          responseType: 'stream', anonymous: true, redirect: 'error', timeout: REQUEST_TIMEOUT_MS, nocache: true,
          onloadstart: receive,
          onreadystatechange(response) { if ((response.readyState ?? 0) >= 2) receive(response); },
          onprogress: receive,
          onload(response) {
            receive(response, true);
            if (!responseOpened) fail(networkFailure());
            else if (!streaming) close();
          },
          onerror() { fail(networkFailure()); },
          ontimeout() { fail(new TranslationFailure('TIMEOUT', '翻译服务响应超时，请重试。', true)); },
          onabort() { fail(aborted()); },
        });
        if (finished) request.abort();
        if (signal?.aborted) onAbort();
      } catch { fail(networkFailure()); }
    });
  }) as typeof fetch;
}
