import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeepLUserscriptTransport } from '../../src/userscript/deepl-transport';
import type { GMRequest } from '../../src/userscript/gm';
import { DEEPL_WEB_ENDPOINT } from '../../src/shared/translation-engine';

const BODY = JSON.stringify({ text: ['Fixed public test input.'], target_lang: 'zh-Hans' });
let requests: Array<{ details: GMRequest; abort: ReturnType<typeof vi.fn> }>;
function observe<T>(promise: Promise<T>): Promise<T> { void promise.catch(() => undefined); return promise; }
function headers(index: number, finalUrl = requests[index]!.details.url) {
  requests[index]!.details.onreadystatechange({ status: 200, readyState: 2, finalUrl });
}
function complete(index: number) {
  requests[index]!.details.onload({ status: 200, finalUrl: requests[index]!.details.url,
    responseText: JSON.stringify({ translations: [{ text: '固定测试译文。' }] }) });
}
async function settle() { for (let index = 0; index < 25; index++) await Promise.resolve(); }

beforeEach(() => {
  requests = [];
  vi.stubGlobal('GM_info', { scriptHandler: 'Tampermonkey', version: '5.4.1' });
  vi.stubGlobal('GM_xmlhttpRequest', (details: GMRequest) => {
    const abort = vi.fn(() => details.onabort()); requests.push({ details, abort }); return { abort };
  });
});
afterEach(async () => { requests.forEach(({ details }) => details.onabort()); await settle(); vi.unstubAllGlobals(); });

describe('dedicated anonymous DeepL request lanes', () => {
  it('leases only eight fixed lane URLs and keeps a lane occupied until its complete text arrives', async () => {
    const send = createDeepLUserscriptTransport();
    const pending = Array.from({ length: 8 }, () => observe(send(BODY, new AbortController().signal)));
    expect(requests.map(({ details }) => details.url)).toEqual(Array.from({ length: 8 }, (_, lane) =>
      `${DEEPL_WEB_ENDPOINT}?near_translate_lane=${lane}`));
    expect(requests.every(({ details }) => details.redirect === 'error' && details.anonymous && details.responseType === 'text')).toBe(true);
    requests.forEach((_, index) => headers(index));
    const responses = await Promise.all(pending);
    await expect(send(BODY, new AbortController().signal)).rejects.toMatchObject({ code: 'RATE_LIMIT' });
    expect(requests).toHaveLength(8);
    const firstText = observe(responses[0]!.text());
    complete(0);
    expect(await firstText).toContain('固定测试译文。');
    const next = observe(send(BODY, new AbortController().signal));
    expect(requests).toHaveLength(9);
    expect(requests[8]!.details.url).toBe(`${DEEPL_WEB_ENDPOINT}?near_translate_lane=0`);
    // An old manager callback must not release the new owner of lane zero.
    requests[0]!.details.onabort(); complete(0);
    await expect(send(BODY, new AbortController().signal)).rejects.toMatchObject({ code: 'RATE_LIMIT' });
    expect(requests).toHaveLength(9);
    complete(8); await next;
  });

  it('reuses only a cancelled lease and ignores its late callbacks after reassignment', async () => {
    const send = createDeepLUserscriptTransport();
    const controllers = Array.from({ length: 8 }, () => new AbortController());
    const pending = controllers.map(controller => observe(send(BODY, controller.signal)));
    controllers[3]!.abort();
    await expect(pending[3]).rejects.toMatchObject({ name: 'AbortError' });
    const next = observe(send(BODY, new AbortController().signal));
    expect(requests[8]!.details.url).toBe(`${DEEPL_WEB_ENDPOINT}?near_translate_lane=3`);
    complete(3); requests[3]!.details.onerror();
    await expect(send(BODY, new AbortController().signal)).rejects.toMatchObject({ code: 'RATE_LIMIT' });
    expect(requests).toHaveLength(9);
    complete(8); await next;
    expect(requests[3]!.abort).toHaveBeenCalledOnce();
  });

  it('releases a lease when its response body is cancelled after early headers', async () => {
    const send = createDeepLUserscriptTransport();
    const pending = observe(send(BODY, new AbortController().signal));
    headers(0);
    await (await pending).body!.cancel();
    const next = observe(send(BODY, new AbortController().signal));
    expect(requests[1]!.details.url).toBe(requests[0]!.details.url);
    expect(requests[0]!.abort).toHaveBeenCalledOnce();
    complete(1); await next;
  });

  it('releases after preflight rejection and does not fall back to the canonical URL on network failure', async () => {
    const beforeRequest = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error('Local check failed.'))
      .mockResolvedValue(undefined);
    const send = createDeepLUserscriptTransport(beforeRequest);
    await expect(send(BODY, new AbortController().signal)).rejects.toThrow('Local check failed.');
    expect(requests).toHaveLength(0);
    const failed = observe(send(BODY, new AbortController().signal));
    await settle(); requests[0]!.details.onerror();
    await expect(failed).rejects.toBeInstanceOf(TypeError);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.details.url).toBe(`${DEEPL_WEB_ENDPOINT}?near_translate_lane=0`);
    const next = observe(send(BODY, new AbortController().signal));
    await settle(); complete(1); await next;
    expect(requests).toHaveLength(2);
    expect(requests.every(({ details }) => details.url !== DEEPL_WEB_ENDPOINT)).toBe(true);
  });

  it.each(Array.from({ length: 8 }, (_, lane) => lane))('rejects mismatched final URLs for lane %i', async lane => {
    const send = createDeepLUserscriptTransport();
    const pending = Array.from({ length: lane + 1 }, () => observe(send(BODY, new AbortController().signal)));
    headers(lane, `${DEEPL_WEB_ENDPOINT}?near_translate_lane=${(lane + 1) % 8}`);
    await expect(pending[lane]).rejects.toMatchObject({ code: 'NETWORK' });
    expect(requests).toHaveLength(lane + 1);
    expect(requests[lane]!.abort).toHaveBeenCalledOnce();
  });

  it.each([302, 307, 308])('rejects HTTP %i without a second or canonical request', async status => {
    const send = createDeepLUserscriptTransport();
    const pending = observe(send(BODY, new AbortController().signal));
    requests[0]!.details.onload({ status, finalUrl: requests[0]!.details.url, responseText: '' });
    await expect(pending).rejects.toMatchObject({ code: 'NETWORK' });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.details.redirect).toBe('error');
  });
});
