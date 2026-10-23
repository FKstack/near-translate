import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ contains: vi.fn(), updateSessionRules: vi.fn(), remove: vi.fn() }));
vi.mock('wxt/browser', () => ({ browser: {
  runtime: { id: 'test-extension-id' },
  permissions: { contains: state.contains, remove: state.remove },
  declarativeNetRequest: { updateSessionRules: state.updateSessionRules },
} }));

import { createDeepLWebTransport, DeepLWebTransportError } from '../../src/platform/deepl-web-transport';
import { DEEPL_WEB_ENDPOINT, DEEPL_WEB_ORIGIN, DEEPL_WEB_PREPARATION_PERMISSION } from '../../src/shared/translation-engine';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('MV3 DeepL network boundary', () => {
  it('reports detached, content-free request metrics for success and service limits', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('{}'))
      .mockResolvedValueOnce(new Response('{}', { status: 429 }));
    const network = createDeepLWebTransport(fetcher);
    await network.synchronize(true);
    const privateText = 'Do not include this source in metrics';
    const body = JSON.stringify({ text: [privateText, 'Second.'], target_lang: 'zh-Hans' });
    await network.request(body, new AbortController().signal);
    const snapshot = network.metrics();
    snapshot.statusCounts['200'] = 999;
    snapshot.requests[0]!.textCount = 999;
    snapshot.requests[0]!.maxTextChars = 999;
    await network.request(body, new AbortController().signal);
    const result = network.metrics();
    expect(result).toMatchObject({ requestCount: 2, totalTexts: 4, totalChars: (privateText.length + 7) * 2,
      activeRequests: 0, maxConcurrent: 1, statusCounts: { '200': 1, '429': 1 } });
    expect(result.requests.map(row => row.textCount)).toEqual([2, 2]);
    expect(result.requests.map(row => row.maxTextChars)).toEqual([privateText.length, privateText.length]);
    expect(result.requests.every(row => row.endedAt! >= row.startedAt)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(privateText);
  });

  it('measures the longest POST item in UTF-16 without retaining text and defaults malformed shapes to zero', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
    const network = createDeepLWebTransport(fetcher);
    await network.synchronize(true);
    const bodies = [JSON.stringify({ text: ['短', '😀x', 'ab'], target_lang: 'zh-Hans' }),
      JSON.stringify({ text: ['x'.repeat(1_500)] }), JSON.stringify({ text: [] }),
      JSON.stringify({ text: [null, 123, { text: 'private nested source' }, 'ok'] }),
      JSON.stringify({ text: 'private non-array source' }), 'not JSON'];
    for (const body of bodies) await network.request(body, new AbortController().signal);
    expect(network.metrics().requests.map(({ textCount, charCount, maxTextChars }) => ({ textCount, charCount, maxTextChars })))
      .toEqual([{ textCount: 3, charCount: 6, maxTextChars: 3 }, { textCount: 1, charCount: 1_500, maxTextChars: 1_500 },
        { textCount: 0, charCount: 0, maxTextChars: 0 }, { textCount: 4, charCount: 2, maxTextChars: 2 },
        { textCount: 0, charCount: 0, maxTextChars: 0 }, { textCount: 0, charCount: 0, maxTextChars: 0 }]);
    expect(JSON.stringify(network.metrics())).not.toMatch(/private|😀|zh-Hans|not JSON/);
    expect(fetcher.mock.calls.map(([, init]) => init?.body)).toEqual(bodies);
  });

  afterEach(() => { vi.unstubAllGlobals(); });
  beforeEach(() => {
    vi.resetAllMocks();
    state.contains.mockImplementation(async (query: { origins?: string[] }) => Boolean(query.origins));
    state.updateSessionRules.mockResolvedValue(undefined);
  });

  it('uses the new host without DNR permission and never creates a header rewriting rule', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
    const network = createDeepLWebTransport(fetcher);
    await network.synchronize(true); await network.request('{}', new AbortController().signal);
    expect(state.contains).toHaveBeenCalledWith({ origins: [DEEPL_WEB_ORIGIN] });
    expect(state.updateSessionRules).not.toHaveBeenCalled();
    expect(state.remove).not.toHaveBeenCalled();
    expect(DEEPL_WEB_ENDPOINT).toBe('https://oneshot-free.www.deepl.com/v1/translate');
    expect(DEEPL_WEB_ORIGIN).toBe('https://oneshot-free.www.deepl.com/*');
  });

  it('cleans the owned legacy rule, synchronizes optional preparation and preserves the original anonymous POST', async () => {
    state.contains.mockResolvedValue(true);
    const installed = deferred<void>();
    state.updateSessionRules.mockReturnValueOnce(installed.promise);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
    const network = createDeepLWebTransport(fetcher);
    const enabled = network.synchronize(true);
    const controller = new AbortController();
    const body = '{"text":["Public sentence."],"target_lang":"zh-Hans"}';
    const request = network.request(body, controller.signal);
    await vi.waitFor(() => expect(state.updateSessionRules).toHaveBeenCalledTimes(1));
    expect(fetcher).not.toHaveBeenCalled();
    installed.resolve();
    await enabled;
    await request;
    expect(state.contains).toHaveBeenCalledWith({ origins: [DEEPL_WEB_ORIGIN] });
    expect(state.updateSessionRules).toHaveBeenNthCalledWith(1, { removeRuleIds: [74001] });
    expect(state.updateSessionRules).toHaveBeenCalledTimes(2);
    expect(state.remove).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(DEEPL_WEB_ENDPOINT, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'None' }, body,
      signal: controller.signal, credentials: 'omit', redirect: 'error', cache: 'no-store',
    });
  });

  it('does not require obsolete DNR cleanup to succeed before using the newly authorized host', async () => {
    state.contains.mockResolvedValue(true);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
    const network = createDeepLWebTransport(fetcher);
    state.updateSessionRules.mockRejectedValue(new Error('private browser diagnostics'));
    await network.synchronize(true);
    await network.request('{}', new AbortController().signal);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(state.updateSessionRules).toHaveBeenNthCalledWith(1, { removeRuleIds: [74001] });
    expect(state.updateSessionRules).toHaveBeenCalledTimes(2);
    expect(state.remove).not.toHaveBeenCalled();
  });

  it('resolves the default fetch at request time and binds its receiver correctly', async () => {
    const initial = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', initial);
    const network = createDeepLWebTransport();
    await network.synchronize(true);
    const replacement = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', replacement);
    await network.request('{}', new AbortController().signal);
    expect(initial).not.toHaveBeenCalled();
    expect(replacement).toHaveBeenCalledTimes(1);
    expect(replacement.mock.contexts[0]).toBe(globalThis);
  });

  it('checks the new host again after revocation and does not send another request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const network = createDeepLWebTransport(fetcher);
    await network.synchronize(true);
    state.contains.mockImplementation(async (query: { origins?: string[] }) => !query.origins);
    await expect(network.request('{}', new AbortController().signal)).rejects.toBeInstanceOf(DeepLWebTransportError);
    expect(state.updateSessionRules).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('stays closed when host access is missing or the engine is disabled', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const network = createDeepLWebTransport(fetcher);
    await network.synchronize(true);
    state.contains.mockResolvedValue(false);
    await expect(network.request('{}', new AbortController().signal)).rejects.toBeInstanceOf(DeepLWebTransportError);
    expect(fetcher).not.toHaveBeenCalled();
    await network.synchronize(false);
    await expect(network.request('{}', new AbortController().signal)).rejects.toBeInstanceOf(DeepLWebTransportError);
  });

  it('does not fetch if canceled while permission preparation is pending', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const network = createDeepLWebTransport(fetcher);
    await network.synchronize(true);
    const permission = deferred<boolean>();
    state.contains.mockReturnValueOnce(permission.promise);
    const controller = new AbortController();
    const request = network.request('{}', controller.signal);
    const failed = expect(request).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(state.contains.mock.results.some(result => result.value === permission.promise)).toBe(true));
    controller.abort();
    permission.resolve(true);
    await failed;
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('invalidates a pending preparation when the engine is disabled', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const network = createDeepLWebTransport(fetcher);
    await network.synchronize(true);
    const permission = deferred<boolean>();
    state.contains.mockReturnValueOnce(permission.promise);
    const request = network.request('{}', new AbortController().signal);
    const failed = expect(request).rejects.toBeInstanceOf(DeepLWebTransportError);
    await vi.waitFor(() => expect(state.contains.mock.results.some(result => result.value === permission.promise)).toBe(true));
    const disabled = network.synchronize(false);
    permission.resolve(true);
    await Promise.all([failed, disabled]);
    expect(fetcher).not.toHaveBeenCalled();
    expect(state.updateSessionRules).not.toHaveBeenCalled();
  });

  it('installs only two standard request fields for our exact OPTIONS endpoint and caches synchronization', async () => {
    state.contains.mockResolvedValue(true);
    const network = createDeepLWebTransport(vi.fn<typeof fetch>().mockResolvedValue(new Response('{}')));
    await network.synchronize(true);
    const update = state.updateSessionRules.mock.calls[1]![0];
    expect(update.removeRuleIds).toEqual([74002]);
    expect(update.addRules).toHaveLength(1);
    const rule = update.addRules[0];
    expect(rule).toMatchObject({ id: 74002, priority: 1, condition: {
      initiatorDomains: ['test-extension-id'], requestMethods: ['options'], resourceTypes: ['xmlhttprequest'],
      isUrlFilterCaseSensitive: true,
    }, action: { type: 'modifyHeaders', requestHeaders: [
      { header: 'Access-Control-Request-Method', operation: 'set', value: 'POST' },
      { header: 'Access-Control-Request-Headers', operation: 'set', value: 'authorization,content-type' },
    ] } });
    const pattern = new RegExp(rule.condition.regexFilter);
    expect(pattern.test(DEEPL_WEB_ENDPOINT)).toBe(true);
    for (const url of [DEEPL_WEB_ENDPOINT + '?x=1', DEEPL_WEB_ENDPOINT + '/extra',
      DEEPL_WEB_ENDPOINT.replace('www.deepl', 'wwwXdeepl'), 'https://private.invalid/v1/translate'])
      expect(pattern.test(url)).toBe(false);
    expect(Object.keys(rule.action)).toEqual(['type', 'requestHeaders']);
    await network.synchronize(true);
    await network.request('{}', new AbortController().signal);
    await network.synchronize(true);
    expect(state.updateSessionRules).toHaveBeenCalledTimes(2);
    expect(state.contains).toHaveBeenCalledWith({ permissions: [DEEPL_WEB_PREPARATION_PERMISSION] });
    expect(state.remove).not.toHaveBeenCalled();
  });

  it('prepares with native anonymous OPTIONS and sends no body, Authorization or identity rewriting', async () => {
    state.contains.mockResolvedValue(true);
    const response = new Response(null, { status: 204 });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
    const network = createDeepLWebTransport(fetcher);
    await network.synchronize(true);
    const controller = new AbortController();
    expect(await network.prepare(controller.signal)).toBe(response);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(DEEPL_WEB_ENDPOINT, { method: 'OPTIONS', signal: controller.signal,
      credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store' });
    expect(network.metrics()).toMatchObject({ preparationCount: 1, activePreparations: 0,
      preparations: [{ sequence: 1, status: 204 }], requestCount: 0, statusCounts: {}, errorCounts: {} });
  });

  it('requires both optional permission and an already synchronized rule without installing during prepare', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
    const network = createDeepLWebTransport(fetcher);
    await network.synchronize(true);
    await expect(network.prepare(new AbortController().signal)).rejects.toBeInstanceOf(DeepLWebTransportError);
    state.contains.mockResolvedValue(true);
    await expect(network.prepare(new AbortController().signal)).rejects.toBeInstanceOf(DeepLWebTransportError);
    expect(state.updateSessionRules).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(network.metrics().preparationCount).toBe(0);
    await network.synchronize(true);
    await network.prepare(new AbortController().signal);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('keeps POST usable if optional rule installation fails and does not retry it for each POST', async () => {
    state.contains.mockResolvedValue(true);
    state.updateSessionRules.mockImplementation(async (update: { addRules?: unknown[] }) => {
      if (update.addRules) throw new Error('private rule installation failure');
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
    const network = createDeepLWebTransport(fetcher);
    await network.synchronize(true);
    await expect(network.prepare(new AbortController().signal)).rejects.toBeInstanceOf(DeepLWebTransportError);
    await network.synchronize(true);
    await network.request('{}', new AbortController().signal);
    await network.request('{}', new AbortController().signal);
    expect(state.updateSessionRules).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(([, options]) => options?.method === 'POST')).toBe(true);
    expect(network.metrics().preparationCount).toBe(0);
  });

  it('removes only our preparation rule after optional permission revocation and permits POST', async () => {
    let permission = true;
    state.contains.mockImplementation(async (query: { origins?: string[] }) => !!query.origins || permission);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
    const network = createDeepLWebTransport(fetcher);
    await network.synchronize(true);
    permission = false;
    await network.synchronize(true);
    expect(state.updateSessionRules).toHaveBeenLastCalledWith({ removeRuleIds: [74002] });
    await expect(network.prepare(new AbortController().signal)).rejects.toBeInstanceOf(DeepLWebTransportError);
    await network.request('{}', new AbortController().signal);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('detects host or optional permission loss during prepare even without a synchronization event', async () => {
    for (const revoked of ['host', 'preparation']) {
      state.contains.mockResolvedValue(true);
      const fetcher = vi.fn<typeof fetch>();
      const network = createDeepLWebTransport(fetcher);
      await network.synchronize(true);
      state.contains.mockImplementation(async (query: { origins?: string[] }) => query.origins ? revoked !== 'host' : revoked !== 'preparation');
      await expect(network.prepare(new AbortController().signal)).rejects.toBeInstanceOf(DeepLWebTransportError);
      expect(state.updateSessionRules).toHaveBeenLastCalledWith({ removeRuleIds: [74002] });
      expect(fetcher).not.toHaveBeenCalled();
      expect(network.metrics().preparationCount).toBe(0);
    }
  });

  it('removes the owned preparation rule when disabled and refuses subsequent preparation', async () => {
    state.contains.mockResolvedValue(true);
    const fetcher = vi.fn<typeof fetch>();
    const network = createDeepLWebTransport(fetcher);
    await network.synchronize(true);
    await network.synchronize(false);
    expect(state.updateSessionRules).toHaveBeenLastCalledWith({ removeRuleIds: [74002] });
    await expect(network.prepare(new AbortController().signal)).rejects.toBeInstanceOf(DeepLWebTransportError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects canceled or superseded preparation before fetch while permission checks are pending', async () => {
    for (const canceled of [true, false]) {
      state.contains.mockResolvedValue(true);
      const fetcher = vi.fn<typeof fetch>();
      const network = createDeepLWebTransport(fetcher);
      await network.synchronize(true);
      const permission = deferred<boolean>();
      state.contains.mockReturnValueOnce(permission.promise);
      const controller = new AbortController();
      const prepared = network.prepare(controller.signal);
      const rejected = canceled ? expect(prepared).rejects.toMatchObject({ name: 'AbortError' })
        : expect(prepared).rejects.toBeInstanceOf(DeepLWebTransportError);
      await vi.waitFor(() => expect(state.contains.mock.results.some(result => result.value === permission.promise)).toBe(true));
      const disabled = canceled ? Promise.resolve() : network.synchronize(false);
      if (canceled) controller.abort();
      permission.resolve(true);
      await Promise.all([rejected, disabled]);
      expect(fetcher).not.toHaveBeenCalled();
      expect(network.metrics().preparationCount).toBe(0);
    }
  });

  it('counts preparation activity and errors separately from all POST counts and detaches snapshots', async () => {
    state.contains.mockResolvedValue(true);
    const pending = deferred<Response>();
    const fetcher = vi.fn<typeof fetch>().mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(new Response('{}'))
      .mockRejectedValueOnce(new Error('private network detail'));
    const network = createDeepLWebTransport(fetcher);
    await network.synchronize(true);
    const prepared = network.prepare(new AbortController().signal);
    await vi.waitFor(() => expect(network.metrics().activePreparations).toBe(1));
    expect(network.metrics()).toMatchObject({ requestCount: 0, activeRequests: 0, preparationCount: 1 });
    pending.resolve(new Response(null, { status: 429 })); await prepared;
    const snapshot = network.metrics(); snapshot.preparations[0]!.status = 999;
    await network.request('{"text":["source"]}', new AbortController().signal);
    await expect(network.prepare(new AbortController().signal)).rejects.toThrow('private network detail');
    expect(network.metrics()).toMatchObject({ requestCount: 1, totalTexts: 1, totalChars: 6,
      statusCounts: { '200': 1 }, errorCounts: {}, preparationCount: 2, activePreparations: 0,
      preparations: [{ sequence: 1, status: 429 }, { sequence: 2, errorCode: 'NETWORK' }] });
    expect(JSON.stringify(network.metrics())).not.toContain('private network detail');
    expect(network.metrics().preparations.every(row => row.endedAt! >= row.startedAt)).toBe(true);
    for (const row of network.metrics().preparations) {
      expect(row).not.toHaveProperty('textCount'); expect(row).not.toHaveProperty('charCount');
      expect(row).not.toHaveProperty('maxTextChars');
    }
  });

  it('records native preparation cancellation without adding a POST failure', async () => {
    state.contains.mockResolvedValue(true);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('canceled', 'AbortError')), { once: true });
    }));
    const network = createDeepLWebTransport(fetcher);
    await network.synchronize(true);
    const controller = new AbortController(); const prepared = network.prepare(controller.signal);
    const rejected = expect(prepared).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce()); controller.abort(); await rejected;
    expect(network.metrics()).toMatchObject({ preparationCount: 1, activePreparations: 0,
      preparations: [{ errorCode: 'ABORTED' }], requestCount: 0, errorCounts: {} });
  });

  it('bounds preparation rows to 64 without resetting the cumulative count', async () => {
    state.contains.mockResolvedValue(true);
    const network = createDeepLWebTransport(vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 })));
    await network.synchronize(true);
    for (let i = 0; i < 70; i++) await network.prepare(new AbortController().signal);
    const metrics = network.metrics();
    expect(metrics.preparationCount).toBe(70); expect(metrics.preparations).toHaveLength(64);
    expect(metrics.preparations[0]!.sequence).toBe(7); expect(metrics.preparations.at(-1)!.sequence).toBe(70);
    expect(metrics.requestCount).toBe(0);
  });

  it('uses the current default fetch receiver for optional preparation', async () => {
    state.contains.mockResolvedValue(true);
    const initial = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', initial);
    const network = createDeepLWebTransport(); await network.synchronize(true);
    const replacement = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', replacement); await network.prepare(new AbortController().signal);
    expect(initial).not.toHaveBeenCalled(); expect(replacement.mock.contexts[0]).toBe(globalThis);
  });

  it('keeps distinct timing snapshots but omits ambiguous same-URL POST and OPTIONS entries', async () => {
    for (const gap of [100, 5]) {
      state.contains.mockResolvedValue(true);
      let at = 100; const entries: PerformanceResourceTiming[] = [];
      vi.stubGlobal('performance', { timeOrigin: 1000, now: () => at, getEntriesByName: () => entries });
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => {
        entries.push({ name: DEEPL_WEB_ENDPOINT, entryType: 'resource', startTime: at,
          domainLookupStart: at, domainLookupEnd: at, connectStart: at, connectEnd: at + 2,
          secureConnectionStart: at + 1, requestStart: at + 2, responseStart: at + 5, responseEnd: at + 6,
          duration: options?.method === 'OPTIONS' ? 10 : 20, nextHopProtocol: 'h2' } as PerformanceResourceTiming);
        return new Response(null, { status: options?.method === 'OPTIONS' ? 204 : 200 });
      });
      const network = createDeepLWebTransport(fetcher); await network.synchronize(true);
      await network.prepare(new AbortController().signal); at += gap;
      await network.request('{}', new AbortController().signal);
      const metrics = network.metrics();
      if (gap === 100) {
        expect(metrics.preparations[0]!.networkTiming?.totalMs).toBe(10);
        expect(metrics.requests[0]!.networkTiming?.totalMs).toBe(20);
        metrics.preparations[0]!.networkTiming!.totalMs = 999;
        expect(network.metrics().preparations[0]!.networkTiming?.totalMs).toBe(10);
      } else {
        expect(metrics.preparations[0]!.networkTiming).toBeUndefined();
        expect(metrics.requests[0]!.networkTiming).toBeUndefined();
      }
    }
  });
});
