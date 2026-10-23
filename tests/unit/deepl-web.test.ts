import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeepLWebProvider, type DeepLWebTransport } from '../../src/providers/deepl-web';
import type { TranslationEvent, TranslationInput } from '../../src/shared/contracts';
import { DEEPL_WEB_SCHEDULING } from '../../src/shared/translation-policy';
import { LANGUAGES } from '../../src/shared/languages';
import { toTranslationError } from '../../src/core/errors';

const input: TranslationInput = { kind: 'text', text: 'This is a public test.' };
function requestTexts(body: string): string[] { return JSON.parse(body).text; }
function reply(body: string, text: string | string[] = '公开测试译文', headers?: HeadersInit): Response {
  const texts = Array.isArray(text) ? text : requestTexts(body).map(() => text);
  return new Response(JSON.stringify({ translations: texts.map(text => ({ text, detected_source_language: 'en' })) }), {
    headers: { 'content-type': 'application/json', ...headers },
  });
}
function echo(body: string): Response { return reply(body, requestTexts(body)); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function collect(provider: DeepLWebProvider, value = input, signal = new AbortController().signal): Promise<TranslationEvent[]> {
  const events: TranslationEvent[] = [];
  for await (const event of provider.translate(value, signal)) events.push(event);
  return events;
}
function fakeTime() { vi.useFakeTimers(); vi.setSystemTime(1_700_000_000_000); }
afterEach(() => { vi.useRealTimers(); });

describe('DeepL language snapshots and read-only service status', () => {
  it('reports an unused service as ready without contacting either injected transport', async () => {
    const transport = vi.fn<DeepLWebTransport>();
    const prepareTransport = vi.fn(async () => new Response(null, { status: 204 }));
    const provider = new DeepLWebProvider(transport, { prepareTransport });
    expect(await provider.getServiceStatus()).toEqual({ cooldownUntil: 0 });
    expect(transport).not.toHaveBeenCalled(); expect(prepareTransport).not.toHaveBeenCalled();
  });

  it.each(LANGUAGES)('uses selected target $code while auto source remains omitted', async ({ code }) => {
    const transport = vi.fn<DeepLWebTransport>().mockImplementation(async body => reply(body));
    await collect(new DeepLWebProvider(transport), { text: '日本語の文章です。', kind: 'text', targetLanguage: code });
    expect(JSON.parse(transport.mock.calls[0]![0])).toEqual({ text: ['日本語の文章です。'], target_lang: code });
  });

  it.each(['zh-Hans', 'zh-Hant'] as const)('maps explicit Chinese source %s to the shared DeepL zh code', async sourceLanguage => {
    const transport = vi.fn<DeepLWebTransport>().mockImplementation(async body => reply(body));
    await collect(new DeepLWebProvider(transport), { text: '中文文章', kind: 'text', sourceLanguage, targetLanguage: 'en' });
    expect(JSON.parse(transport.mock.calls[0]![0])).toEqual({ text: ['中文文章'], target_lang: 'en', source_lang: 'zh' });
  });

  it('keeps queued source, target and text independent of later input mutations', async () => {
    fakeTime();
    const first = deferred<Response>();
    const transport = vi.fn<DeepLWebTransport>().mockImplementationOnce(() => first.promise)
      .mockImplementation(async body => reply(body));
    const provider = new DeepLWebProvider(transport, { maxConcurrent: 1, intervalMs: 100 });
    const active = collect(provider);
    const queuedInput: TranslationInput = { text: 'Bonjour', pageSegments: ['Bonjour', 'Le deuxième paragraphe.'], kind: 'text',
      sourceLanguage: 'fr', targetLanguage: 'de' };
    const queued = collect(provider, queuedInput);
    queuedInput.sourceLanguage = 'ko'; queuedInput.targetLanguage = 'ja'; queuedInput.pageSegments![0] = 'CHANGED';
    first.resolve(reply(transport.mock.calls[0]![0]));
    await active; await vi.advanceTimersByTimeAsync(100); await queued;
    expect(JSON.parse(transport.mock.calls[1]![0])).toEqual({ text: ['Bonjour', 'Le deuxième paragraphe.'],
      target_lang: 'de', source_lang: 'fr' });
  });

  it('restores a persisted deadline without any translation, preparation or reservation request', async () => {
    fakeTime();
    const restore = deferred<number>();
    const loadCooldownUntil = vi.fn(() => restore.promise);
    const transport = vi.fn<DeepLWebTransport>();
    const prepareTransport = vi.fn(async () => new Response(null, { status: 204 }));
    const reservePreparation = vi.fn(async () => true);
    const provider = new DeepLWebProvider(transport, { loadCooldownUntil, prepareTransport, reservePreparation });
    const status = provider.getServiceStatus(); const again = provider.getServiceStatus();
    await Promise.resolve();
    expect(loadCooldownUntil).toHaveBeenCalledOnce();
    const deadline = Date.now() + 120_000;
    restore.resolve(deadline);
    expect(await status).toEqual({ cooldownUntil: deadline });
    expect(await again).toEqual({ cooldownUntil: deadline });
    await expect(collect(provider)).rejects.toMatchObject({ code: 'RATE_LIMIT', retryAt: deadline });
    expect(transport).not.toHaveBeenCalled(); expect(prepareTransport).not.toHaveBeenCalled();
    expect(reservePreparation).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it('exposes the same 429 retry deadline to errors, status and a restarted provider', async () => {
    fakeTime();
    let persisted = 0;
    const now = Date.now();
    const transport = vi.fn<DeepLWebTransport>().mockResolvedValue(new Response('{}', { status: 429, headers: { 'retry-after': '120' } }));
    const provider = new DeepLWebProvider(transport, { persistCooldownUntil: async value => { persisted = value; } });
    const error = await collect(provider).catch(error => error);
    expect(toTranslationError(error)).toMatchObject({ code: 'RATE_LIMIT', retryable: true, retryAt: now + 120_000 });
    expect(await provider.getServiceStatus()).toEqual({ cooldownUntil: now + 120_000 });
    const restartedTransport = vi.fn<DeepLWebTransport>();
    const restarted = new DeepLWebProvider(restartedTransport, { loadCooldownUntil: async () => persisted });
    expect(await restarted.getServiceStatus()).toEqual({ cooldownUntil: now + 120_000 });
    await expect(collect(restarted)).rejects.toMatchObject({ code: 'RATE_LIMIT', retryAt: now + 120_000 });
    expect(transport).toHaveBeenCalledOnce(); expect(restartedTransport).not.toHaveBeenCalled();
  });

  it('attaches one shared deadline to the 429 job and its flushed queued peer without retrying either', async () => {
    fakeTime();
    const response = deferred<Response>();
    const transport = vi.fn<DeepLWebTransport>().mockImplementation(() => response.promise);
    const provider = new DeepLWebProvider(transport, { maxConcurrent: 1, intervalMs: 100 });
    const active = collect(provider).catch(error => error);
    const queued = collect(provider, { kind: 'text', text: 'Queued source.' }).catch(error => error);
    const deadline = Date.now() + 90_000;
    response.resolve(new Response('{}', { status: 429, headers: { 'retry-after': '90' } }));
    expect(toTranslationError(await active)).toMatchObject({ code: 'RATE_LIMIT', retryAt: deadline });
    expect(toTranslationError(await queued)).toMatchObject({ code: 'RATE_LIMIT', retryAt: deadline });
    await vi.advanceTimersByTimeAsync(90_000);
    expect(transport).toHaveBeenCalledOnce();
    expect(await provider.getServiceStatus()).toEqual({ cooldownUntil: deadline });
  });

  it('reports failed cooldown restoration safely instead of pretending the service is ready', async () => {
    const transport = vi.fn<DeepLWebTransport>();
    const provider = new DeepLWebProvider(transport, { loadCooldownUntil: async () => { throw new Error('private storage detail'); } });
    const error = await provider.getServiceStatus().catch(error => error);
    expect(toTranslationError(error)).toMatchObject({ code: 'CONFIG' });
    expect(toTranslationError(error).message).not.toContain('private');
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('DeepL metadata preparation lifecycle', () => {
  it('is a no-op without an injected metadata transport', async () => {
    const transport = vi.fn<DeepLWebTransport>();
    const reservePreparation = vi.fn(async () => true);
    const provider = new DeepLWebProvider(transport, { reservePreparation });
    provider.cancelPreparation();
    await provider.prepareNetwork();
    expect(reservePreparation).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it('deduplicates an in-flight preparation and shares the normal request interval', async () => {
    fakeTime();
    const pending = deferred<Response>();
    const prepareTransport = vi.fn(() => pending.promise);
    const reservePreparation = vi.fn(async () => true);
    const transport = vi.fn<DeepLWebTransport>().mockImplementation(async body => reply(body));
    const provider = new DeepLWebProvider(transport, { prepareTransport, reservePreparation, intervalMs: 100 });
    const preparation = provider.prepareNetwork();
    expect(provider.prepareNetwork()).toBe(preparation);
    await vi.advanceTimersByTimeAsync(0);
    expect(prepareTransport).toHaveBeenCalledOnce(); expect(reservePreparation).toHaveBeenCalledOnce();
    const translated = collect(provider);
    pending.resolve(new Response(null, { status: 204 }));
    await preparation;
    await vi.advanceTimersByTimeAsync(99); expect(transport).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect((await translated).at(-1)).toMatchObject({ type: 'result' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([200, 204, 400, 403, 500])('never parses a metadata response or emits translation for HTTP %s', async status => {
    fakeTime();
    const canceled = vi.fn();
    const response = status === 204 ? new Response(null, { status })
      : new Response(new ReadableStream({ cancel: canceled }), { status });
    const json = vi.spyOn(response, 'json'); const text = vi.spyOn(response, 'text');
    const prepareTransport = vi.fn(async () => response);
    const transport = vi.fn<DeepLWebTransport>().mockImplementation(async body => reply(body));
    const provider = new DeepLWebProvider(transport, { prepareTransport, intervalMs: 100 });
    await provider.prepareNetwork();
    expect(prepareTransport).toHaveBeenCalledOnce(); expect(transport).not.toHaveBeenCalled();
    if (status !== 204) expect(canceled).toHaveBeenCalledOnce();
    expect(json).not.toHaveBeenCalled(); expect(text).not.toHaveBeenCalled();
    const translated = collect(provider);
    await vi.advanceTimersByTimeAsync(100);
    expect((await translated).at(-1)).toMatchObject({ type: 'result' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['denied', 'save-error'] as const)('keeps %s reservation out of both network and rolling-start admission', async outcome => {
    fakeTime();
    const reservePreparation = vi.fn(async () => {
      if (outcome === 'save-error') throw new Error('private storage failure');
      return false;
    });
    const prepareTransport = vi.fn(async () => new Response(null, { status: 204 }));
    const transport = vi.fn<DeepLWebTransport>().mockImplementation(async body => reply(body));
    const provider = new DeepLWebProvider(transport, { prepareTransport, reservePreparation, intervalMs: 100,
      startWindow: { maxStarts: 1, durationMs: 12_000 } });
    await Promise.all(Array.from({ length: 10 }, () => provider.prepareNetwork()));
    expect(reservePreparation).toHaveBeenCalledOnce(); expect(prepareTransport).not.toHaveBeenCalled();
    expect((await collect(provider)).at(-1)).toMatchObject({ type: 'result' });
    expect(transport).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it('counts an admitted preparation in the same rolling window as translation', async () => {
    fakeTime();
    const transport = vi.fn<DeepLWebTransport>().mockImplementation(async body => reply(body));
    const provider = new DeepLWebProvider(transport, { intervalMs: 100,
      prepareTransport: async () => new Response(null, { status: 204 }),
      startWindow: { maxStarts: 1, durationMs: 12_000 } });
    await provider.prepareNetwork();
    const translated = collect(provider);
    await vi.advanceTimersByTimeAsync(11_999); expect(transport).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect((await translated).at(-1)).toMatchObject({ type: 'result' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('loads cooldown through the scheduler and never prepares or retries during it', async () => {
    fakeTime();
    const loadCooldownUntil = vi.fn(async () => Date.now() + 60_000);
    const reservePreparation = vi.fn(async () => true);
    const prepareTransport = vi.fn(async () => new Response(null, { status: 204 }));
    const transport = vi.fn<DeepLWebTransport>();
    const provider = new DeepLWebProvider(transport, { prepareTransport, reservePreparation, loadCooldownUntil });
    await provider.prepareNetwork();
    await provider.prepareNetwork();
    await expect(collect(provider)).rejects.toMatchObject({ code: 'RATE_LIMIT' });
    expect(loadCooldownUntil).toHaveBeenCalledOnce(); expect(prepareTransport).not.toHaveBeenCalled();
    expect(reservePreparation).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(prepareTransport).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    await provider.prepareNetwork(); expect(prepareTransport).toHaveBeenCalledOnce();
  });

  it('times out a pending reservation without sending late network work or releasing its owner early', async () => {
    fakeTime();
    const reserved = deferred<boolean>();
    const reservePreparation = vi.fn(() => reserved.promise);
    const prepareTransport = vi.fn(async () => new Response(null, { status: 204 }));
    const transport = vi.fn<DeepLWebTransport>().mockImplementation(async body => reply(body));
    const provider = new DeepLWebProvider(transport, { prepareTransport, reservePreparation });
    const preparation = provider.prepareNetwork();
    await vi.advanceTimersByTimeAsync(5_000); await preparation;
    expect(provider.prepareNetwork()).toBe(preparation);
    expect(reservePreparation).toHaveBeenCalledOnce(); expect(prepareTransport).not.toHaveBeenCalled();
    expect((await collect(provider)).at(-1)).toMatchObject({ type: 'result' });
    reserved.resolve(true); await vi.advanceTimersByTimeAsync(0);
    expect(prepareTransport).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    const next = provider.prepareNetwork(); await vi.advanceTimersByTimeAsync(1_050); await next;
    expect(prepareTransport).toHaveBeenCalledOnce();
  });

  it('includes queue waiting in the five-second deadline without blocking subsequent POSTs', async () => {
    fakeTime();
    const activeResponse = deferred<Response>();
    const transport = vi.fn<DeepLWebTransport>().mockImplementationOnce(() => activeResponse.promise)
      .mockImplementation(async body => reply(body));
    const prepareTransport = vi.fn(async () => new Response(null, { status: 204 }));
    const provider = new DeepLWebProvider(transport, { prepareTransport, intervalMs: 100 });
    const first = collect(provider);
    const preparation = provider.prepareNetwork();
    await vi.advanceTimersByTimeAsync(5_000); await preparation;
    expect(prepareTransport).not.toHaveBeenCalled();
    activeResponse.resolve(reply(transport.mock.calls[0]![0])); await first;
    expect((await collect(provider)).at(-1)).toMatchObject({ type: 'result' });
    expect(transport).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
    const next = provider.prepareNetwork(); expect(next).not.toBe(preparation);
    await vi.advanceTimersByTimeAsync(100); await next;
    expect(prepareTransport).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['cancel', 'deadline'] as const)('retains preparation ownership and scheduler slots after %s until late response cleanup finishes', async action => {
    fakeTime();
    const network = deferred<Response>(); const cleanup = deferred<void>();
    const canceled = vi.fn(() => cleanup.promise);
    const prepareTransport = vi.fn<(signal: AbortSignal) => Promise<Response>>(() => network.promise);
    const transport = vi.fn<DeepLWebTransport>().mockImplementation(async body => reply(body));
    const provider = new DeepLWebProvider(transport, { prepareTransport, intervalMs: 100 });
    const preparation = provider.prepareNetwork();
    await vi.advanceTimersByTimeAsync(0);
    if (action === 'cancel') provider.cancelPreparation();
    else await vi.advanceTimersByTimeAsync(5_000);
    await preparation;
    expect(prepareTransport.mock.calls[0]![0].aborted).toBe(true);
    expect(provider.prepareNetwork()).toBe(preparation);
    const translated = collect(provider);
    network.resolve(new Response(new ReadableStream({ cancel: canceled })));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(canceled).toHaveBeenCalledOnce(); expect(transport).not.toHaveBeenCalled();
    expect(provider.prepareNetwork()).toBe(preparation); expect(prepareTransport).toHaveBeenCalledOnce();
    cleanup.resolve(undefined); await vi.advanceTimersByTimeAsync(0);
    expect((await translated).at(-1)).toMatchObject({ type: 'result' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains the owner during successful response cancellation even if a public cancel arrives', async () => {
    fakeTime();
    const cleanup = deferred<void>(); const canceled = vi.fn(() => cleanup.promise);
    const response = new Response(new ReadableStream({ cancel: canceled }));
    const prepareTransport = vi.fn(async () => response);
    const transport = vi.fn<DeepLWebTransport>().mockImplementation(async body => reply(body));
    const provider = new DeepLWebProvider(transport, { prepareTransport, intervalMs: 100 });
    const preparation = provider.prepareNetwork();
    await vi.advanceTimersByTimeAsync(0); expect(canceled).toHaveBeenCalledOnce();
    provider.cancelPreparation(); await preparation;
    expect(provider.prepareNetwork()).toBe(preparation);
    const translated = collect(provider);
    await vi.advanceTimersByTimeAsync(100); expect(transport).not.toHaveBeenCalled();
    cleanup.resolve(undefined); await vi.advanceTimersByTimeAsync(0);
    expect((await translated).at(-1)).toMatchObject({ type: 'result' });
    expect(canceled).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it('isolates metadata transport and response-cleanup errors from later translation', async () => {
    fakeTime();
    const prepareTransport = vi.fn<(signal: AbortSignal) => Promise<Response>>()
      .mockRejectedValueOnce(new TypeError('private network error'))
      .mockResolvedValueOnce(new Response(new ReadableStream({ cancel() { throw new Error('private cleanup error'); } })))
      .mockResolvedValue(new Response(null, { status: 204 }));
    const transport = vi.fn<DeepLWebTransport>().mockImplementation(async body => reply(body));
    const provider = new DeepLWebProvider(transport, { prepareTransport, intervalMs: 100 });
    await provider.prepareNetwork();
    const second = provider.prepareNetwork(); await vi.advanceTimersByTimeAsync(100); await second;
    const translated = collect(provider); await vi.advanceTimersByTimeAsync(100);
    expect((await translated).at(-1)).toMatchObject({ type: 'result' });
    expect(prepareTransport).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });

  it('uses preparation 429 to flush queued work, cancel peers, persist cooldown and retain bounded diagnostics', async () => {
    fakeTime();
    const preparationResponse = deferred<Response>(); const peerResponse = deferred<Response>();
    const saved = deferred<void>(); const persistCooldownUntil = vi.fn(() => saved.promise); const onDiagnostic = vi.fn();
    const prepareTransport = vi.fn(() => preparationResponse.promise);
    const transport = vi.fn<DeepLWebTransport>().mockImplementationOnce(() => peerResponse.promise)
      .mockImplementation(async body => reply(body));
    const provider = new DeepLWebProvider(transport, { prepareTransport, intervalMs: 100, maxConcurrent: 2,
      persistCooldownUntil, onDiagnostic });
    const preparation = provider.prepareNetwork(); await vi.advanceTimersByTimeAsync(0);
    const active = collect(provider).catch(error => error); await vi.advanceTimersByTimeAsync(100);
    const queued = collect(provider).catch(error => error);
    preparationResponse.resolve(new Response('{"error":{"code":1042911}}', { status: 429, headers: { 'Retry-After': '90' } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await active).toMatchObject({ code: 'RATE_LIMIT' }); expect(await queued).toMatchObject({ code: 'RATE_LIMIT' });
    expect(transport.mock.calls[0]![1].aborted).toBe(true); expect(transport).toHaveBeenCalledOnce();
    expect(persistCooldownUntil).toHaveBeenCalledExactlyOnceWith(1_700_000_090_100);
    expect(onDiagnostic).toHaveBeenCalledExactlyOnceWith({ at: 1_700_000_000_100, httpStatus: 429,
      rpcErrorCode: 1042911, retryAfterMs: 90_000, bodyOutcome: 'json', bodyCompletedAt: 1_700_000_000_100 });
    expect(provider.prepareNetwork()).toBe(preparation);
    saved.resolve(undefined); await preparation;
    const canceled = vi.fn(); peerResponse.resolve(new Response(new ReadableStream({ cancel: canceled })));
    await vi.advanceTimersByTimeAsync(0); expect(canceled).toHaveBeenCalledOnce();
    await provider.prepareNetwork(); await expect(collect(provider)).rejects.toMatchObject({ code: 'RATE_LIMIT' });
    expect(prepareTransport).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(prepareTransport).toHaveBeenCalledOnce(); expect(transport).toHaveBeenCalledOnce();
    expect((await collect(provider)).at(-1)).toMatchObject({ type: 'result' });
  });

  it('keeps preparation quiet but retains fail-closed cooldown storage errors for translation', async () => {
    fakeTime();
    const transport = vi.fn<DeepLWebTransport>();
    const prepareTransport = vi.fn(async () => new Response(null, { status: 204 }));
    const loadCooldownUntil = vi.fn(async () => { throw new Error('private read failure'); });
    const loadFailure = new DeepLWebProvider(transport, { prepareTransport, loadCooldownUntil });
    await loadFailure.prepareNetwork(); await loadFailure.prepareNetwork();
    await expect(collect(loadFailure)).rejects.toMatchObject({ code: 'CONFIG' });
    expect(loadCooldownUntil).toHaveBeenCalledOnce(); expect(prepareTransport).not.toHaveBeenCalled();

    const onDiagnostic = vi.fn();
    const persistCooldownUntil = vi.fn(async () => { throw new Error('private write failure'); });
    const saveFailure = new DeepLWebProvider(transport, { onDiagnostic, persistCooldownUntil,
      prepareTransport: async () => new Response('{"error":{"code":1042911}}', { status: 429 }) });
    await saveFailure.prepareNetwork(); await saveFailure.prepareNetwork();
    await expect(collect(saveFailure)).rejects.toMatchObject({ code: 'CONFIG' });
    expect(persistCooldownUntil).toHaveBeenCalledOnce(); expect(onDiagnostic).toHaveBeenCalledOnce();
    expect(transport).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it('publishes bounded 429 diagnostics but retains preparation until underlying cancellation actually finishes', async () => {
    fakeTime();
    const cleanup = deferred<void>(); const canceled = vi.fn(() => cleanup.promise); const onDiagnostic = vi.fn();
    const response = new Response(new ReadableStream({
      start(stream) { stream.enqueue(new TextEncoder().encode('{')); }, cancel: canceled,
    }), { status: 429 });
    const prepareTransport = vi.fn(async () => response);
    const transport = vi.fn<DeepLWebTransport>().mockImplementation(async body => reply(body));
    const provider = new DeepLWebProvider(transport, { prepareTransport, onDiagnostic });
    const preparation = provider.prepareNetwork();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onDiagnostic).toHaveBeenCalledExactlyOnceWith({ at: 1_700_000_000_000, httpStatus: 429,
      bodyOutcome: 'timeout', bodyCompletedAt: 1_700_000_001_000 });
    expect(canceled).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(4_000); await preparation;
    expect(provider.prepareNetwork()).toBe(preparation);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(provider.prepareNetwork()).toBe(preparation); expect(prepareTransport).toHaveBeenCalledOnce();
    const translated = collect(provider);
    await vi.advanceTimersByTimeAsync(0); expect(transport).not.toHaveBeenCalled();
    cleanup.resolve(undefined); await vi.advanceTimersByTimeAsync(0);
    expect((await translated).at(-1)).toMatchObject({ type: 'result' });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('DeepL complete-segment Chinese target normalization', () => {
  it('normalizes an unchanged Traditional Chinese MDN source returned for a Simplified Chinese target', async () => {
    const source = '此頁面由社群從英文翻譯而來。了解更多並加入 MDN Web Docs 社群。';
    const translation = '此页面由社群从英文翻译而来。了解更多并加入 MDN Web Docs 社群。';
    const transport = vi.fn<DeepLWebTransport>().mockImplementation(async body => reply(body, source));
    expect(await collect(new DeepLWebProvider(transport), {
      kind: 'text', text: source, sourceLanguage: 'zh-Hant', targetLanguage: 'zh-Hans',
    })).toEqual([{ type: 'result', result: { kind: 'text', translation } }]);
    expect(JSON.parse(transport.mock.calls[0]![0])).toEqual({ text: [source], source_lang: 'zh', target_lang: 'zh-Hans' });
    expect(transport).toHaveBeenCalledOnce();
  });

  it.each([
    { targetLanguage: 'zh-Hans' as const, returned: ['軟件與數據庫。', '頭髮與發展。'], expected: ['软件与数据库。', '头发与发展。'] },
    { targetLanguage: 'zh-Hant' as const, returned: ['软件与数据库。', '头发与发展。'], expected: ['軟件與數據庫。', '頭髮與發展。'] },
  ])('publishes matching normalized segment and final results for $targetLanguage', async ({ targetLanguage, returned, expected }) => {
    const transport = vi.fn<DeepLWebTransport>().mockImplementation(async body => reply(body, returned));
    expect(await collect(new DeepLWebProvider(transport), {
      kind: 'text', text: 'ignored', pageSegments: ['First paragraph.', 'Second paragraph.'], targetLanguage,
    })).toEqual([
      ...expected.map((text, index) => ({ type: 'segment', index, text })),
      { type: 'result', result: { kind: 'text', translation: expected.join('\n\n'), segments: expected } },
    ]);
    expect(transport).toHaveBeenCalledOnce();
  });

  it('leaves non-Chinese target results unchanged even when they include Chinese quotation', async () => {
    const translation = 'The label is 「头发與頭髮」.\n日本語 😀 e\u0301';
    const transport = vi.fn<DeepLWebTransport>().mockImplementation(async body => reply(body, translation));
    expect(await collect(new DeepLWebProvider(transport), { kind: 'text', text: 'Source.', targetLanguage: 'en' }))
      .toEqual([{ type: 'result', result: { kind: 'text', translation } }]);
    expect(transport).toHaveBeenCalledOnce();
  });

  it('joins parts before phrase conversion, preserves Unicode, and uses the captured target for both event forms', async () => {
    fakeTime();
    const transport = vi.fn<DeepLWebTransport>().mockImplementationOnce(async body => reply(body, '😀 e\u0301 𠮷 头'))
      .mockImplementation(async body => reply(body, ['发', '软件与数据库。']));
    const value: TranslationInput = { kind: 'text', text: 'ignored',
      pageSegments: ['a'.repeat(1500) + 'b', 'Next.'], targetLanguage: 'zh-Hant' };
    const pending = collect(new DeepLWebProvider(transport), value);
    value.targetLanguage = 'zh-Hans';
    await vi.runAllTimersAsync();
    const expected = ['😀 e\u0301 𠮷 頭髮', '軟件與數據庫。'];
    expect(await pending).toEqual([
      ...expected.map((text, index) => ({ type: 'segment', index, text })),
      { type: 'result', result: { kind: 'text', translation: expected.join('\n\n'), segments: expected } },
    ]);
    expect(transport.mock.calls.map(([body]) => requestTexts(body))).toEqual([['a'.repeat(1500)], ['b', 'Next.']]);
    expect(transport.mock.calls.map(([body]) => JSON.parse(body).target_lang)).toEqual(['zh-Hant', 'zh-Hant']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps phrase context confined to each original source segment', async () => {
    const transport = vi.fn<DeepLWebTransport>().mockImplementation(async body => reply(body, ['头', '发']));
    expect(await collect(new DeepLWebProvider(transport), {
      kind: 'text', text: 'ignored', pageSegments: ['Heading.', 'Paragraph.'], targetLanguage: 'zh-Hant',
    })).toEqual([
      { type: 'segment', index: 0, text: '頭' },
      { type: 'segment', index: 1, text: '發' },
      { type: 'result', result: { kind: 'text', translation: '頭\n\n發', segments: ['頭', '發'] } },
    ]);
  });
});

describe('DeepL anonymous oneshot wire format and plain translation', () => {
  it.each([
    { kind: 'word' as const, text: 'bank', context: 'They sat by the river.' },
    { kind: 'text' as const, text: 'This is fine.' },
  ])('sends only text[] and zh-Hans with automatic source detection ($kind)', async source => {
    const transport = vi.fn<DeepLWebTransport>().mockImplementation(async body => reply(body));
    expect(await collect(new DeepLWebProvider(transport), source))
      .toEqual([{ type: 'result', result: { kind: 'text', translation: '公开测试译文' } }]);
    expect(JSON.parse(transport.mock.calls[0]![0])).toEqual({ text: [source.text], target_lang: 'zh-Hans' });
    expect(transport.mock.calls[0]![0]).not.toMatch(/jsonrpc|timestamp|method|source_lang|context|app_information|instance|alternatives/i);
  });

  it('rejects sentence analysis before queueing or sending a request', async () => {
    const transport = vi.fn<DeepLWebTransport>();
    await expect(collect(new DeepLWebProvider(transport), { ...input, task: 'sentence-analysis' }))
      .rejects.toMatchObject({ code: 'CONFIG', retryable: false });
    expect(transport).not.toHaveBeenCalled();
  });

  it('returns indexed page segments in order and a matching final result without fake deltas', async () => {
    const translations = ['第一段。', '第二段。'];
    const transport = vi.fn<DeepLWebTransport>().mockImplementation(async body => reply(body, translations));
    expect(await collect(new DeepLWebProvider(transport), { kind: 'text', text: 'ignored', pageSegments: ['First.', 'Second.'] }))
      .toEqual([
        ...translations.map((text, index) => ({ type: 'segment', index, text })),
        { type: 'result', result: { kind: 'text', translation: translations.join('\n\n'), segments: translations } },
      ]);
    expect(requestTexts(transport.mock.calls[0]![0])).toEqual(['First.', 'Second.']);
    expect(transport).toHaveBeenCalledOnce();
  });

  it('splits long selections losslessly below 1500 UTF-16 units without dividing a surrogate pair', async () => {
    fakeTime();
    const source = 'x'.repeat(1499) + '😀' + 'y'.repeat(1501);
    const transport = vi.fn<DeepLWebTransport>().mockImplementation(async body => echo(body));
    const pending = collect(new DeepLWebProvider(transport), { kind: 'text', text: source });
    await vi.runAllTimersAsync();
    expect((await pending).at(-1)).toEqual({ type: 'result', result: { kind: 'text', translation: source } });
    const parts = transport.mock.calls.flatMap(([body]) => requestTexts(body));
    expect(parts.join('')).toBe(source);
    expect(parts.every(part => part.length <= 1500 && !/[\ud800-\udbff]$/.test(part) && !/^[\udc00-\udfff]/.test(part))).toBe(true);
  });

  it('preserves whitespace between split sentences when the service trims it', async () => {
    fakeTime();
    const source = 'a'.repeat(900) + '.\n\n' + 'b'.repeat(900);
    const transport = vi.fn<DeepLWebTransport>().mockImplementation(async body => reply(body, requestTexts(body).map(text => text.trim())));
    const pending = collect(new DeepLWebProvider(transport), { kind: 'text', text: source });
    await vi.runAllTimersAsync();
    expect((await pending).at(-1)).toEqual({ type: 'result', result: { kind: 'text', translation: source } });
  });

  it('keeps whitespace-only internal parts locally instead of dropping or sending them', async () => {
    fakeTime();
    const source = 'a'.repeat(1500) + ' '.repeat(1500) + 'b';
    const transport = vi.fn<DeepLWebTransport>().mockImplementation(async body => echo(body));
    const pending = collect(new DeepLWebProvider(transport), { kind: 'text', text: source });
    await vi.runAllTimersAsync();
    expect((await pending).at(-1)).toMatchObject({ type: 'result', result: { translation: source } });
    expect(transport.mock.calls.flatMap(([body]) => requestTexts(body))).toEqual(['a'.repeat(1500), 'b']);
  });

  it('accepts the shared 12000-character selection limit without truncation', async () => {
    fakeTime();
    const source = 'x'.repeat(12000);
    const transport = vi.fn<DeepLWebTransport>().mockImplementation(async body => echo(body));
    const pending = collect(new DeepLWebProvider(transport), { kind: 'text', text: source });
    await vi.runAllTimersAsync();
    expect((await pending).at(-1)).toMatchObject({ type: 'result', result: { translation: source } });
    expect(transport).toHaveBeenCalledTimes(8);
    expect(transport.mock.calls.flatMap(([body]) => requestTexts(body)).join('')).toBe(source);
  });

  it.each([
    { kind: 'text' as const, text: 'x'.repeat(12001) },
    { kind: 'text' as const, text: 'ignored', pageSegments: Array.from({ length: 33 }, () => 'a') },
    { kind: 'text' as const, text: 'ignored', pageSegments: ['a'.repeat(6000), 'b'.repeat(6000)] },
  ])('keeps shared untrusted input limits before network activity (%#)', async source => {
    const transport = vi.fn<DeepLWebTransport>();
    await expect(collect(new DeepLWebProvider(transport), source)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('DeepL oneshot bounded text-array batches', () => {
  it('sends 32 distinct short page items in one array without markers or packed separators', async () => {
    const sources = Array.from({ length: 32 }, (_, index) => 'Public item ' + index + '.');
    const translations = sources.map((_, index) => '第 ' + index + ' 项译文。');
    const transport = vi.fn<DeepLWebTransport>().mockImplementation(async body => reply(body, translations));
    expect(await collect(new DeepLWebProvider(transport), { kind: 'text', text: 'ignored', pageSegments: sources })).toEqual([
      ...translations.map((text, index) => ({ type: 'segment', index, text })),
      { type: 'result', result: { kind: 'text', translation: translations.join('\n\n'), segments: translations } },
    ]);
    expect(JSON.parse(transport.mock.calls[0]![0])).toEqual({ text: sources, target_lang: 'zh-Hans' });
    expect(transport).toHaveBeenCalledOnce();
  });

  it.each([0, 1])('uses the sum of text lengths for the 1500-unit budget (overflow %s)', async overflow => {
    fakeTime();
    const sources = ['a'.repeat(750), 'b'.repeat(750 + overflow), 'Tail.'];
    const transport = vi.fn<DeepLWebTransport>().mockImplementation(async body => echo(body));
    const pending = collect(new DeepLWebProvider(transport), { kind: 'text', text: 'ignored', pageSegments: sources });
    await vi.runAllTimersAsync();
    expect((await pending).at(-1)).toMatchObject({ type: 'result', result: { segments: sources } });
    const batches = transport.mock.calls.map(([body]) => requestTexts(body));
    expect(batches).toEqual(overflow ? [sources.slice(0, 1), sources.slice(1)] : [sources.slice(0, 2), sources.slice(2)]);
    expect(batches.every(batch => batch.length <= 32 && batch.join('').length <= 1500)).toBe(true);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('counts astral Unicode as two units while grouping and splitting', async () => {
    fakeTime();
    const sources = ['😀'.repeat(750), '😀'];
    const transport = vi.fn<DeepLWebTransport>().mockImplementation(async body => echo(body));
    const pending = collect(new DeepLWebProvider(transport), { kind: 'text', text: 'ignored', pageSegments: sources });
    await vi.runAllTimersAsync();
    expect((await pending).at(-1)).toMatchObject({ type: 'result', result: { segments: sources } });
    expect(transport.mock.calls.map(([body]) => requestTexts(body))).toEqual([[sources[0]], [sources[1]]]);
  });

  it('maps long paragraph parts across batches without dropping whitespace or dividing Unicode', async () => {
    fakeTime();
    const sources = ['Heading.', 'a'.repeat(1499) + '😀' + 'b'.repeat(19), 'Tail.'];
    const transport = vi.fn<DeepLWebTransport>().mockImplementation(async body => echo(body));
    const pending = collect(new DeepLWebProvider(transport), { kind: 'text', text: 'ignored', pageSegments: sources });
    await vi.runAllTimersAsync();
    expect(await pending).toEqual([
      ...sources.map((text, index) => ({ type: 'segment', index, text })),
      { type: 'result', result: { kind: 'text', translation: sources.join('\n\n'), segments: sources } },
    ]);
    const batches = transport.mock.calls.map(([body]) => requestTexts(body));
    expect(batches).toHaveLength(3);
    expect(batches[2]).toEqual(['😀' + 'b'.repeat(19), 'Tail.']);
    expect(batches.flat().join('')).toBe(sources.join(''));
    expect(batches.flat().every(text => !/[\ud800-\udbff]$/.test(text) && !/^[\udc00-\udfff]/.test(text))).toBe(true);
  });

  it('keeps serialized UTF-8 bodies below 64 KiB including JSON escaping', async () => {
    fakeTime();
    const sources = ['漢'.repeat(1500), '"\\\u0000'.repeat(500)];
    const transport = vi.fn<DeepLWebTransport>().mockImplementation(async body => echo(body));
    const pending = collect(new DeepLWebProvider(transport), { kind: 'text', text: 'ignored', pageSegments: sources });
    await vi.runAllTimersAsync();
    expect((await pending).at(-1)).toMatchObject({ type: 'result', result: { segments: ['汉'.repeat(1500), sources[1]] } });
    expect(transport).toHaveBeenCalledTimes(2);
    for (const [body] of transport.mock.calls) {
      expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(64 * 1024);
      expect(requestTexts(body).join('').length).toBeLessThanOrEqual(1500);
    }
  });

  it.each(['\n', '\r\n', '\r'])('preserves internal source and translation newlines per array item (%j)', async newline => {
    const sources = ['First.' + newline + 'Inside.\n\nStill first.', 'Second.', 'Third.'];
    const translations = ['第一行。\r\n\r\n仍在第一段。', '第二段。\n内部行。', '第三段。'];
    const transport = vi.fn<DeepLWebTransport>().mockImplementation(async body => reply(body, translations));
    expect((await collect(new DeepLWebProvider(transport), { kind: 'text', text: 'ignored', pageSegments: sources })).at(-1))
      .toMatchObject({ type: 'result', result: { segments: translations } });
    expect(requestTexts(transport.mock.calls[0]![0])).toEqual(['First.\nInside.\n\nStill first.', 'Second.', 'Third.']);
    expect(transport).toHaveBeenCalledOnce();
  });

  it.each(['missing', 'extra', 'empty', 'not-text', 'null', 'not-array'] as const)(
    'rejects a %s response atomically without publishing siblings or retrying', async mode => {
      let translations: unknown = [{ text: '第一段。' }, { text: '第二段。' }, { text: '第三段。' }];
      if (Array.isArray(translations)) {
        if (mode === 'missing') translations.pop();
        if (mode === 'extra') translations.push({ text: '额外段落。' });
        if (mode === 'empty') translations[1] = { text: ' \t\n' };
        if (mode === 'not-text') translations[1] = { text: 42 };
        if (mode === 'null') translations[1] = null;
      }
      if (mode === 'not-array') translations = { text: '错误结构。' };
      const transport = vi.fn<DeepLWebTransport>().mockResolvedValue(new Response(JSON.stringify({ translations })));
      const events: TranslationEvent[] = [];
      const failed = (async () => {
        for await (const event of new DeepLWebProvider(transport).translate({
          kind: 'text', text: 'ignored', pageSegments: ['First.', 'Second.', 'Third.'],
        }, new AbortController().signal)) events.push(event);
      })();
      await expect(failed).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
      expect(events).toEqual([]);
      expect(transport).toHaveBeenCalledOnce();
    },
  );

  it('does not publish an unfinished long paragraph when a later batch has missing translations', async () => {
    fakeTime();
    const events: TranslationEvent[] = [];
    const sources = ['Heading.', 'x'.repeat(1700), 'Tail.'];
    const transport = vi.fn<DeepLWebTransport>().mockImplementation(async body => {
      const texts = requestTexts(body);
      return reply(body, texts.length === 2 ? texts.slice(0, 1) : texts);
    });
    const pending = (async () => {
      for await (const event of new DeepLWebProvider(transport).translate({
        kind: 'text', text: 'ignored', pageSegments: sources,
      }, new AbortController().signal)) events.push(event);
    })().catch(error => error);
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(events).toEqual([{ type: 'segment', index: 0, text: 'Heading.' }]);
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it('cancels an active batch immediately and ignores the late complete response', async () => {
    fakeTime();
    const response = deferred<Response>();
    const transport = vi.fn<DeepLWebTransport>().mockImplementation(() => response.promise);
    const events: TranslationEvent[] = [];
    const controller = new AbortController();
    const pending = (async () => {
      for await (const event of new DeepLWebProvider(transport).translate({
        kind: 'text', text: 'ignored', pageSegments: ['First.', 'Second.'],
      }, controller.signal)) events.push(event);
    })().catch(error => error);
    expect(requestTexts(transport.mock.calls[0]![0])).toEqual(['First.', 'Second.']);
    controller.abort();
    expect(await pending).toMatchObject({ name: 'AbortError' });
    response.resolve(reply(transport.mock.calls[0]![0], ['第一段。', '第二段。']));
    await vi.runAllTimersAsync();
    expect(events).toEqual([]);
    expect(transport).toHaveBeenCalledOnce();
  });

  it('checks cancellation between already validated segment publications', async () => {
    const transport = vi.fn<DeepLWebTransport>().mockImplementation(async body => reply(body, ['第一段。', '第二段。']));
    const controller = new AbortController();
    const iterator = new DeepLWebProvider(transport).translate({
      kind: 'text', text: 'ignored', pageSegments: ['First.', 'Second.'],
    }, controller.signal)[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ done: false, value: { type: 'segment', index: 0, text: '第一段。' } });
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
    expect(transport).toHaveBeenCalledOnce();
  });

  it('keeps separate callers in separate upstream arrays, including sources with internal newlines', async () => {
    fakeTime();
    const response = deferred<Response>();
    const transport = vi.fn<DeepLWebTransport>().mockImplementationOnce(() => response.promise)
      .mockImplementation(async body => echo(body));
    const provider = new DeepLWebProvider(transport);
    const first = collect(provider, { kind: 'text', text: 'ignored', pageSegments: ['First A.', 'Second A.'] });
    const secondSources = ['First B.\nInside.', 'Second B.'];
    const second = collect(provider, { kind: 'text', text: 'ignored', pageSegments: secondSources });
    expect(transport).toHaveBeenCalledOnce();
    response.resolve(reply(transport.mock.calls[0]![0], ['第一段。', '第二段。']));
    expect((await first).at(-1)).toMatchObject({ type: 'result', result: { segments: ['第一段。', '第二段。'] } });
    await vi.runAllTimersAsync();
    expect((await second).at(-1)).toMatchObject({ type: 'result', result: { segments: secondSources } });
    expect(transport.mock.calls.map(([body]) => requestTexts(body))).toEqual([['First A.', 'Second A.'], secondSources]);
  });
});

describe('DeepL web shared cancellable queue', () => {
  it.each([{ intervalMs: undefined, gap: 1050 }, { intervalMs: 1, gap: 100 }])(
    'serializes callers with a $gap ms start interval (configured $intervalMs)', async ({ intervalMs, gap }) => {
    fakeTime();
    const firstResponse = deferred<Response>();
    const starts: number[] = [];
    const transport = vi.fn<DeepLWebTransport>().mockImplementationOnce(() => { starts.push(Date.now()); return firstResponse.promise; })
      .mockImplementation(async body => { starts.push(Date.now()); return reply(body); });
    const provider = new DeepLWebProvider(transport, { intervalMs });
    const first = collect(provider);
    const second = collect(provider);
    expect(transport).toHaveBeenCalledTimes(1);
    const elapsed = gap / 2;
    await vi.advanceTimersByTimeAsync(elapsed);
    expect(transport).toHaveBeenCalledTimes(1);
    firstResponse.resolve(reply(transport.mock.calls[0]![0]));
    await first;
    await vi.advanceTimersByTimeAsync(gap - elapsed - 1);
    expect(transport).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(transport).toHaveBeenCalledTimes(2);
    expect(starts[1]! - starts[0]!).toBe(gap);
  });

  it('starts queued work as soon as a slow request finishes without an additional completion delay', async () => {
    fakeTime();
    const response = deferred<Response>();
    const starts: number[] = [];
    const transport = vi.fn<DeepLWebTransport>().mockImplementationOnce(() => { starts.push(Date.now()); return response.promise; })
      .mockImplementation(async body => { starts.push(Date.now()); return reply(body); });
    const provider = new DeepLWebProvider(transport);
    const first = collect(provider);
    const second = collect(provider);
    await vi.advanceTimersByTimeAsync(5000);
    expect(transport).toHaveBeenCalledOnce();
    response.resolve(reply(transport.mock.calls[0]![0]));
    await first;
    await second;
    expect(starts).toEqual([1_700_000_000_000, 1_700_000_005_000]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a queued cancellation immediately while another request is active', async () => {
    fakeTime();
    const firstResponse = deferred<Response>();
    const transport = vi.fn<DeepLWebTransport>().mockImplementationOnce(() => firstResponse.promise)
      .mockImplementation(async body => reply(body));
    const provider = new DeepLWebProvider(transport);
    const first = collect(provider);
    const controller = new AbortController();
    const second = collect(provider, input, controller.signal).catch(error => error);
    const third = collect(provider);
    controller.abort();
    expect(await second).toMatchObject({ name: 'AbortError' });
    expect(transport).toHaveBeenCalledTimes(1);
    firstResponse.resolve(reply(transport.mock.calls[0]![0]));
    await first;
    await vi.runAllTimersAsync();
    await third;
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it.each([250, 5000])('does not overlap an ignored active abort or reset its start tick (settled after %s ms)', async elapsed => {
    fakeTime();
    const firstResponse = deferred<Response>();
    const transport = vi.fn<DeepLWebTransport>().mockImplementationOnce(() => firstResponse.promise)
      .mockImplementation(async body => reply(body));
    const provider = new DeepLWebProvider(transport);
    const controller = new AbortController();
    const first = collect(provider, input, controller.signal).catch(error => error);
    const second = collect(provider);
    controller.abort();
    expect(await first).toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(elapsed);
    expect(transport).toHaveBeenCalledTimes(1);
    firstResponse.resolve(reply(transport.mock.calls[0]![0]));
    await vi.advanceTimersByTimeAsync(0);
    if (elapsed < 1050) {
      expect(transport).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1050 - elapsed - 1);
      expect(transport).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
    }
    await second;
    expect(transport).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the original start tick after queued cancellation and a new caller', async () => {
    fakeTime();
    const starts: number[] = [];
    const transport = vi.fn<DeepLWebTransport>().mockImplementation(async body => { starts.push(Date.now()); return reply(body); });
    const provider = new DeepLWebProvider(transport);
    await collect(provider);
    const controller = new AbortController();
    const waiting = collect(provider, input, controller.signal).catch(error => error);
    await vi.advanceTimersByTimeAsync(500);
    controller.abort();
    expect(await waiting).toMatchObject({ name: 'AbortError' });
    expect(vi.getTimerCount()).toBe(0);
    const next = collect(provider);
    await vi.advanceTimersByTimeAsync(549);
    expect(transport).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await next;
    expect(starts).toEqual([1_700_000_000_000, 1_700_000_001_050]);
  });

  it('bounds its waiting queue and rejects already cancelled input without sending it', async () => {
    fakeTime();
    const firstResponse = deferred<Response>();
    const transport = vi.fn<DeepLWebTransport>().mockImplementationOnce(() => firstResponse.promise)
      .mockImplementation(async body => reply(body));
    const provider = new DeepLWebProvider(transport, { maxQueuedRequests: 1 });
    const first = collect(provider);
    const second = collect(provider);
    await expect(collect(provider)).rejects.toMatchObject({ code: 'RATE_LIMIT' });
    const controller = new AbortController(); controller.abort();
    await expect(collect(provider, input, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    firstResponse.resolve(reply(transport.mock.calls[0]![0])); await first;
    await vi.runAllTimersAsync(); await second;
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it.each([
    { response: () => new Response('limited', { status: 429 }), wait: 60_000 },
    { response: () => new Response('limited', { status: 429, headers: { 'retry-after': '120' } }), wait: 120_000 },
    { response: () => new Response('limited', { status: 429, headers: { 'retry-after': new Date(1_700_000_090_000).toUTCString() } }), wait: 90_000 },
    { response: () => new Response(JSON.stringify({ error: { message: 'Too many requests' } })), wait: 60_000 },
  ])('flushes pending work and blocks new requests throughout cooldown ($wait ms)', async ({ response, wait }) => {
    fakeTime();
    const firstResponse = deferred<Response>();
    const transport = vi.fn<DeepLWebTransport>().mockImplementationOnce(() => firstResponse.promise)
      .mockImplementation(async body => reply(body));
    const provider = new DeepLWebProvider(transport);
    const first = collect(provider).catch(error => error);
    const waiting = collect(provider).catch(error => error);
    firstResponse.resolve(response());
    expect(await first).toMatchObject({ code: 'RATE_LIMIT' });
    expect(await waiting).toMatchObject({ code: 'RATE_LIMIT' });
    await vi.advanceTimersByTimeAsync(wait - 1);
    await expect(collect(provider)).rejects.toMatchObject({ code: 'RATE_LIMIT' });
    expect(transport).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(transport).toHaveBeenCalledTimes(1); // No automatic retry of flushed requests.
    expect((await collect(provider)).at(-1)).toMatchObject({ type: 'result' });
    expect(transport).toHaveBeenCalledTimes(2);
  });
});

describe('DeepL oneshot bounded global pipeline', () => {
  it('shares the optional start-window budget across independent translation callers', async () => {
    fakeTime();
    const starts: number[] = [];
    const transport = vi.fn<DeepLWebTransport>().mockImplementation(async body => {
      starts.push(Date.now()); return reply(body);
    });
    const provider = new DeepLWebProvider(transport, { maxConcurrent: 4, intervalMs: 100,
      startWindow: { maxStarts: 2, durationMs: 1_000 } });
    const pending = Array.from({ length: 3 }, (_, index) => collect(provider,
      { kind: 'text', text: `Independent public request ${index}.` }));
    await vi.advanceTimersByTimeAsync(999);
    expect(starts).toEqual([1_700_000_000_000, 1_700_000_000_100]);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all(pending);
    expect(starts).toEqual([1_700_000_000_000, 1_700_000_000_100, 1_700_000_001_000]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { maxConcurrent: 2, cap: 2, intervalMs: undefined, gap: 1050 },
    { maxConcurrent: 4, cap: 4, intervalMs: 500, gap: 500 },
    { ...DEEPL_WEB_SCHEDULING, cap: DEEPL_WEB_SCHEDULING.maxConcurrent, gap: DEEPL_WEB_SCHEDULING.intervalMs },
    { maxConcurrent: 99, cap: 16, intervalMs: 500, gap: 500 },
    { maxConcurrent: Infinity, cap: 16, intervalMs: 500, gap: 500 },
  ])('keeps $cap slots and FIFO starts at $gap ms while callers finish out of order', async ({ maxConcurrent, cap, intervalMs, gap }) => {
    fakeTime();
    const responses = Array.from({ length: cap + 1 }, () => deferred<Response>());
    const starts: number[] = [];
    const transport = vi.fn<DeepLWebTransport>().mockImplementation(() => {
      const index = starts.length;
      starts.push(Date.now());
      return responses[index]!.promise;
    });
    const provider = new DeepLWebProvider(transport, { maxConcurrent, intervalMs });
    const sources = responses.map((_, index) => 'Public request ' + index + '.');
    const pending = sources.map(text => collect(provider, { kind: 'text', text }));
    expect(transport).toHaveBeenCalledOnce();
    for (let count = 2; count <= cap; count++) {
      await vi.advanceTimersByTimeAsync(gap - 1);
      expect(transport).toHaveBeenCalledTimes(count - 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(transport).toHaveBeenCalledTimes(count);
    }
    await vi.advanceTimersByTimeAsync(5000);
    expect(transport).toHaveBeenCalledTimes(cap); // No extra slot, even after several ticks.
    responses[1]!.resolve(reply(transport.mock.calls[1]![0], '独立结果 1。'));
    expect((await pending[1]!).at(-1)).toMatchObject({ type: 'result', result: { translation: '独立结果 1。' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(transport).toHaveBeenCalledTimes(cap + 1);
    expect(starts.slice(0, cap)).toEqual(Array.from({ length: cap }, (_, index) => 1_700_000_000_000 + index * gap));
    expect(starts[cap]).toBe(1_700_000_000_000 + (cap - 1) * gap + 5000);
    expect(transport.mock.calls.map(([body]) => requestTexts(body))).toEqual(sources.map(text => [text]));
    for (let index = responses.length - 1; index >= 0; index--) {
      if (index !== 1) responses[index]!.resolve(reply(transport.mock.calls[index]![0], '独立结果 ' + index + '。'));
    }
    const events = await Promise.all(pending);
    events.forEach((items, index) => expect(items.at(-1)).toMatchObject({ type: 'result', result: { translation: '独立结果 ' + index + '。' } }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([undefined, -Infinity, -1, 0, 1.9, NaN])('defaults or clamps maxConcurrent=%s to one slot', async maxConcurrent => {
    fakeTime();
    const response = deferred<Response>();
    const transport = vi.fn<DeepLWebTransport>().mockImplementationOnce(() => response.promise)
      .mockImplementation(async body => reply(body));
    const provider = new DeepLWebProvider(transport, { maxConcurrent });
    const first = collect(provider);
    const second = collect(provider);
    await vi.advanceTimersByTimeAsync(5000);
    expect(transport).toHaveBeenCalledOnce();
    response.resolve(reply(transport.mock.calls[0]![0]));
    await first; await second;
    expect(transport).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { intervalMs: undefined, gap: 1050 },
    { intervalMs: NaN, gap: 100 },
    { intervalMs: -Infinity, gap: 100 },
    { intervalMs: -1, gap: 100 },
    { intervalMs: 0, gap: 100 },
    { intervalMs: 99, gap: 100 },
    { intervalMs: Infinity, gap: 60000 },
  ])('keeps a bounded $gap ms global tick for interval $intervalMs', async ({ intervalMs, gap }) => {
    fakeTime();
    const starts: number[] = [];
    const transport = vi.fn<DeepLWebTransport>().mockImplementation(async body => { starts.push(Date.now()); return reply(body); });
    const provider = new DeepLWebProvider(transport, { maxConcurrent: 4, intervalMs });
    await collect(provider);
    const next = collect(provider);
    await vi.advanceTimersByTimeAsync(gap - 1);
    expect(transport).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await next;
    expect(starts).toEqual([1_700_000_000_000, 1_700_000_000_000 + gap]);
  });

  it('holds an aborted but unsettled transport slot without cancelling another caller', async () => {
    fakeTime();
    const responses = [deferred<Response>(), deferred<Response>(), deferred<Response>()];
    const transport = vi.fn<DeepLWebTransport>().mockImplementation(() => responses[transport.mock.calls.length - 1]!.promise);
    const provider = new DeepLWebProvider(transport, { maxConcurrent: 2, intervalMs: 500 });
    const controller = new AbortController();
    const first = collect(provider, input, controller.signal).catch(error => error);
    const second = collect(provider);
    const third = collect(provider);
    await vi.advanceTimersByTimeAsync(500);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls[0]![1]).not.toBe(controller.signal);
    controller.abort();
    expect(await first).toMatchObject({ name: 'AbortError' });
    expect(transport.mock.calls[0]![1].aborted).toBe(true);
    expect(transport.mock.calls[1]![1].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(transport).toHaveBeenCalledTimes(2);
    responses[0]!.resolve(reply(transport.mock.calls[0]![0], '不得回填的迟到译文。'));
    await vi.advanceTimersByTimeAsync(0);
    expect(transport).toHaveBeenCalledTimes(3);
    responses[1]!.resolve(reply(transport.mock.calls[1]![0]));
    responses[2]!.resolve(reply(transport.mock.calls[2]![0]));
    await second; await third;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('holds the slot until a late response body cancellation settles after transport ignored abort', async () => {
    fakeTime();
    const response = deferred<Response>();
    const cancellation = deferred<void>();
    const cancelled = vi.fn(() => cancellation.promise);
    const starts: number[] = [];
    const transport = vi.fn<DeepLWebTransport>().mockImplementationOnce(() => { starts.push(Date.now()); return response.promise; })
      .mockImplementation(async body => { starts.push(Date.now()); return reply(body); });
    const provider = new DeepLWebProvider(transport);
    const controller = new AbortController();
    const first = collect(provider, input, controller.signal).catch(error => error);
    const next = collect(provider);
    controller.abort();
    expect(await first).toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(1050);
    response.resolve(new Response(new ReadableStream({
      start(stream) { stream.enqueue(new TextEncoder().encode('late response')); }, cancel: cancelled,
    })));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancelled).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5000);
    expect(transport).toHaveBeenCalledOnce();
    cancellation.resolve(undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect((await next).at(-1)).toMatchObject({ type: 'result' });
    expect(starts).toEqual([1_700_000_000_000, 1_700_000_006_050]);
    expect(cancelled).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a slot through an aborted response body until its cancellation actually settles', async () => {
    fakeTime();
    const cancellation = deferred<void>();
    const cancelled = vi.fn(() => cancellation.promise);
    const responses = [deferred<Response>(), deferred<Response>()];
    const transport = vi.fn<DeepLWebTransport>().mockImplementationOnce(async () => new Response(new ReadableStream({
      start(stream) { stream.enqueue(new TextEncoder().encode('{')); }, cancel: cancelled,
    }))).mockImplementation(() => responses[transport.mock.calls.length - 2]!.promise);
    const provider = new DeepLWebProvider(transport, { maxConcurrent: 2, intervalMs: 500 });
    const controller = new AbortController();
    const first = collect(provider, input, controller.signal).catch(error => error);
    const second = collect(provider);
    const third = collect(provider);
    await vi.advanceTimersByTimeAsync(500);
    controller.abort();
    expect(await first).toMatchObject({ name: 'AbortError' });
    expect(cancelled).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5000);
    expect(transport).toHaveBeenCalledTimes(2);
    cancellation.resolve(undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(transport).toHaveBeenCalledTimes(3);
    responses[0]!.resolve(reply(transport.mock.calls[1]![0]));
    responses[1]!.resolve(reply(transport.mock.calls[2]![0]));
    await second; await third;
  });

  it('does not reset the global tick when queued work is cancelled and replaced', async () => {
    fakeTime();
    const response = deferred<Response>();
    const starts: number[] = [];
    const transport = vi.fn<DeepLWebTransport>().mockImplementationOnce(() => { starts.push(Date.now()); return response.promise; })
      .mockImplementation(async body => { starts.push(Date.now()); return reply(body); });
    const provider = new DeepLWebProvider(transport, { maxConcurrent: 2, intervalMs: 500 });
    const first = collect(provider);
    const controller = new AbortController();
    const cancelled = collect(provider, input, controller.signal).catch(error => error);
    await vi.advanceTimersByTimeAsync(250);
    controller.abort();
    expect(await cancelled).toMatchObject({ name: 'AbortError' });
    const next = collect(provider);
    await vi.advanceTimersByTimeAsync(249);
    expect(transport).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await next;
    expect(starts).toEqual([1_700_000_000_000, 1_700_000_000_500]);
    response.resolve(reply(transport.mock.calls[0]![0])); await first;
  });

  it('flushes queued work and aborts active peers before waiting for 429 diagnostics or persistence', async () => {
    fakeTime();
    const peerResponse = deferred<Response>();
    const rateResponse = deferred<Response>();
    const saved = deferred<void>();
    const onDiagnostic = vi.fn();
    const persist = vi.fn(() => saved.promise);
    const canceledBody = vi.fn();
    const transport = vi.fn<DeepLWebTransport>().mockImplementationOnce(() => peerResponse.promise)
      .mockImplementationOnce(() => rateResponse.promise);
    const provider = new DeepLWebProvider(transport, { maxConcurrent: 4, intervalMs: 500,
      onDiagnostic, persistCooldownUntil: persist });
    const events: TranslationEvent[] = [];
    const caller = new AbortController();
    const peer = (async () => {
      for await (const event of provider.translate({ kind: 'text', text: 'ignored', pageSegments: ['First.', 'Second.'] }, caller.signal)) events.push(event);
    })().catch(error => error);
    let rateFinished = false;
    const rate = collect(provider).catch(error => { rateFinished = true; return error; });
    const waiting = collect(provider).catch(error => error);
    const alsoWaiting = collect(provider).catch(error => error);
    await vi.advanceTimersByTimeAsync(500);
    expect(transport).toHaveBeenCalledTimes(2);
    rateResponse.resolve(new Response(new ReadableStream({
      start(stream) { stream.enqueue(new TextEncoder().encode('{')); }, cancel: canceledBody,
    }), { status: 429 }));
    await vi.advanceTimersByTimeAsync(0);
    for (const failure of [await peer, await waiting, await alsoWaiting]) expect(failure).toMatchObject({ code: 'RATE_LIMIT' });
    expect(caller.signal.aborted).toBe(false); // Only provider-owned child transports are aborted.
    expect(transport.mock.calls[0]![1].aborted).toBe(true);
    expect(transport.mock.calls[1]![1].aborted).toBe(false);
    expect(persist).toHaveBeenCalledWith(1_700_000_060_500);
    expect(rateFinished).toBe(false);
    expect(onDiagnostic).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(999);
    expect(transport).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(onDiagnostic.mock.calls[0]![0]).toMatchObject({ httpStatus: 429, bodyOutcome: 'timeout' });
    expect(canceledBody).toHaveBeenCalledOnce();
    expect(rateFinished).toBe(false);
    const lateCancel = vi.fn();
    peerResponse.resolve(new Response(new ReadableStream({
      start(stream) { stream.enqueue(new TextEncoder().encode(JSON.stringify({ translations: [{ text: '迟到一。' }, { text: '迟到二。' }] }))); },
      cancel: lateCancel,
    })));
    await vi.advanceTimersByTimeAsync(0);
    expect(lateCancel).toHaveBeenCalledOnce();
    expect(events).toEqual([]);
    saved.resolve(undefined);
    expect(await rate).toMatchObject({ code: 'RATE_LIMIT' });
    await vi.advanceTimersByTimeAsync(60000);
    expect(transport).toHaveBeenCalledTimes(2); // Neither a free slot nor cooldown expiry retries old work.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('also aborts peers for a JSON Too many requests error without retrying', async () => {
    fakeTime();
    const peerResponse = deferred<Response>();
    const transport = vi.fn<DeepLWebTransport>().mockImplementationOnce(() => peerResponse.promise)
      .mockImplementation(async () => new Response(JSON.stringify({ error: { message: 'Too many requests' } })));
    const provider = new DeepLWebProvider(transport, { maxConcurrent: 2, intervalMs: 500 });
    const peer = collect(provider).catch(error => error);
    const rate = collect(provider).catch(error => error);
    const waiting = collect(provider).catch(error => error);
    await vi.advanceTimersByTimeAsync(500);
    for (const failure of [await peer, await rate, await waiting]) expect(failure).toMatchObject({ code: 'RATE_LIMIT' });
    expect(transport.mock.calls[0]![1].aborted).toBe(true);
    peerResponse.resolve(reply(transport.mock.calls[0]![0]));
    await vi.advanceTimersByTimeAsync(60000);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('DeepL web response and failure boundaries', () => {
  it.each([
    '<html>verification page</html>',
    '{}',
    JSON.stringify({ jsonrpc: '2.0', result: { texts: [{ text: 'old protocol' }] } }),
    JSON.stringify({ translations: [{ text: '  ' }] }),
    JSON.stringify({ translations: [{ text: 'one' }, { text: 'two' }] }),
    JSON.stringify({ error: { message: 'private upstream diagnostic' } }),
    JSON.stringify({ translations: null }),
  ])('rejects invalid/empty/error results without displaying their raw contents', async raw => {
    const transport = vi.fn<DeepLWebTransport>().mockResolvedValue(new Response(raw));
    const failure = await collect(new DeepLWebProvider(transport)).catch(error => error);
    expect(failure).toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(failure.message).not.toContain('private upstream diagnostic');
    expect(failure.message).not.toContain('<html>');
  });

  it.each([401, 403])('describes HTTP %s without asking for an API key', async status => {
    const failure = await collect(new DeepLWebProvider(async () => new Response('denied', { status }))).catch(error => error);
    expect(failure).toMatchObject({ code: 'AUTH', retryable: false });
    expect(failure.message).not.toMatch(/api|key/i);
  });

  it('preserves the platform transport safe-error identity without importing the platform', async () => {
    const error = new Error('请授予 DeepL 网页翻译的网络权限。'); error.name = 'DeepLWebTransportError';
    const failure = await collect(new DeepLWebProvider(async () => { throw error; })).catch(value => value);
    expect(failure).toBe(error);
  });

  it('cancels and unlocks a response reader when the caller aborts', async () => {
    const cancelled = vi.fn();
    const controller = new AbortController();
    const transport: DeepLWebTransport = async () => new Response(new ReadableStream({
      start(stream) { stream.enqueue(new TextEncoder().encode('{')); }, cancel: cancelled,
    }));
    const result = collect(new DeepLWebProvider(transport), input, controller.signal).catch(error => error);
    await Promise.resolve(); await Promise.resolve();
    controller.abort();
    expect(await result).toMatchObject({ name: 'AbortError' });
    expect(cancelled).toHaveBeenCalledOnce();
  });
});

describe('DeepL web cooldown across worker/provider lifetimes', () => {
  it('persists a rate limit and blocks a new instance until the stored deadline expires', async () => {
    fakeTime();
    let stored = 0;
    const load = vi.fn(async () => stored);
    const persist = vi.fn(async (until: number) => { stored = Math.max(stored, until); });
    const limitedTransport = vi.fn<DeepLWebTransport>().mockResolvedValue(new Response('limited', { status: 429 }));
    const first = new DeepLWebProvider(limitedTransport, { loadCooldownUntil: load, persistCooldownUntil: persist });
    await expect(collect(first)).rejects.toMatchObject({ code: 'RATE_LIMIT' });
    expect(stored).toBe(1_700_000_060_000);
    expect(persist).toHaveBeenCalledWith(stored);

    const transport = vi.fn<DeepLWebTransport>().mockImplementation(async body => reply(body));
    const restarted = new DeepLWebProvider(transport, { loadCooldownUntil: load, persistCooldownUntil: persist });
    await expect(collect(restarted)).rejects.toMatchObject({ code: 'RATE_LIMIT' });
    expect(transport).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await collect(restarted)).at(-1)).toMatchObject({ type: 'result' });
    expect(load).toHaveBeenCalledTimes(2); // Each instance loads once, not once per request.
    const afterExpiry = new DeepLWebProvider(transport, { loadCooldownUntil: load });
    expect((await collect(afterExpiry)).at(-1)).toMatchObject({ type: 'result' });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('shares one pending load and lets a caller cancel immediately before storage resolves', async () => {
    fakeTime();
    const loaded = deferred<number>();
    const load = vi.fn(() => loaded.promise);
    const transport = vi.fn<DeepLWebTransport>().mockImplementation(async body => reply(body));
    const provider = new DeepLWebProvider(transport, { loadCooldownUntil: load });
    const controller = new AbortController();
    const cancelled = collect(provider, input, controller.signal).catch(error => error);
    const waiting = collect(provider);
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledOnce();
    expect(transport).not.toHaveBeenCalled();
    controller.abort();
    expect(await cancelled).toMatchObject({ name: 'AbortError' });
    expect(transport).not.toHaveBeenCalled();
    loaded.resolve(0);
    expect((await waiting).at(-1)).toMatchObject({ type: 'result' });
    expect(load).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledOnce();
  });

  it.each(['rejected', 'invalid'] as const)('fails closed after a %s storage load without rereading or sending', async mode => {
    const load = vi.fn(async () => {
      if (mode === 'rejected') throw new Error('private storage exception');
      return Number.NaN;
    });
    const transport = vi.fn<DeepLWebTransport>();
    const provider = new DeepLWebProvider(transport, { loadCooldownUntil: load });
    const first = collect(provider).catch(error => error);
    const second = collect(provider).catch(error => error);
    for (const failure of [await first, await second, await collect(provider).catch(error => error)]) {
      expect(failure).toMatchObject({ code: 'CONFIG', retryable: false });
      expect(failure.message).not.toContain('private storage exception');
    }
    expect(load).toHaveBeenCalledOnce();
    expect(transport).not.toHaveBeenCalled();
  });

  it('flushes queued work first but holds the active request until its deadline is persisted', async () => {
    fakeTime();
    const saved = deferred<void>();
    const persist = vi.fn(() => saved.promise);
    const transport = vi.fn<DeepLWebTransport>().mockResolvedValue(new Response('limited', {
      status: 429, headers: { 'retry-after': '120' },
    }));
    const provider = new DeepLWebProvider(transport, { loadCooldownUntil: async () => 0, persistCooldownUntil: persist });
    let completed = false;
    const active = collect(provider).catch(error => { completed = true; return error; });
    const waiting = collect(provider).catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(await waiting).toMatchObject({ code: 'RATE_LIMIT' });
    expect(persist).toHaveBeenCalledWith(1_700_000_120_000);
    expect(completed).toBe(false);
    await expect(collect(provider)).rejects.toMatchObject({ code: 'RATE_LIMIT' });
    expect(transport).toHaveBeenCalledOnce();
    saved.resolve(undefined);
    expect(await active).toMatchObject({ code: 'RATE_LIMIT' });
    expect(completed).toBe(true);
  });

  it('persists the same protection for a JSON Too many requests error', async () => {
    fakeTime();
    const persist = vi.fn(async () => {});
    const transport = vi.fn<DeepLWebTransport>().mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'Too many requests' },
    })));
    await expect(collect(new DeepLWebProvider(transport, {
      loadCooldownUntil: async () => 0, persistCooldownUntil: persist,
    }))).rejects.toMatchObject({ code: 'RATE_LIMIT' });
    expect(persist).toHaveBeenCalledWith(1_700_000_060_000);
  });

  it('keeps the instance closed if persistence fails, even after its in-memory deadline', async () => {
    fakeTime();
    const load = vi.fn(async () => 0);
    const persist = vi.fn(async () => { throw new Error('private write failure'); });
    const transport = vi.fn<DeepLWebTransport>().mockResolvedValue(new Response('limited', { status: 429 }));
    const provider = new DeepLWebProvider(transport, { loadCooldownUntil: load, persistCooldownUntil: persist });
    const failure = await collect(provider).catch(error => error);
    expect(failure).toMatchObject({ code: 'CONFIG', retryable: false });
    expect(failure.message).not.toContain('private write failure');
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(collect(provider)).rejects.toMatchObject({ code: 'CONFIG' });
    expect(load).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledOnce();
  });
});

describe('DeepL web bounded rate-limit diagnostics', () => {
  it('keeps oneshot rate-limit diagnostics and cooldown without retrying or dispatching queued work', async () => {
    fakeTime();
    const response = deferred<Response>();
    const onDiagnostic = vi.fn();
    const transport = vi.fn<DeepLWebTransport>().mockImplementation(() => response.promise);
    const provider = new DeepLWebProvider(transport, { onDiagnostic });
    const active = collect(provider, { kind: 'text', text: 'ignored', pageSegments: ['First.', 'Second.'] }).catch(error => error);
    const waiting = collect(provider).catch(error => error);
    response.resolve(new Response('{"error":{"code":1042911,"message":"private body"}}', { status: 429 }));
    expect(await active).toMatchObject({ code: 'RATE_LIMIT' });
    expect(await waiting).toMatchObject({ code: 'RATE_LIMIT' });
    expect(requestTexts(transport.mock.calls[0]![0])).toEqual(['First.', 'Second.']);
    expect(onDiagnostic).toHaveBeenCalledExactlyOnceWith({ at: 1_700_000_000_000, httpStatus: 429,
      rpcErrorCode: 1042911, bodyOutcome: 'json', bodyCompletedAt: 1_700_000_000_000 });
    await vi.advanceTimersByTimeAsync(59_999);
    await expect(collect(provider)).rejects.toMatchObject({ code: 'RATE_LIMIT' });
    await vi.advanceTimersByTimeAsync(1);
    expect(transport).toHaveBeenCalledOnce();
    expect(JSON.stringify(onDiagnostic.mock.calls)).not.toContain('private');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports only safe numeric JSON fields and still preserves the original rate limit', async () => {
    fakeTime();
    const onDiagnostic = vi.fn();
    const persist = vi.fn(async () => {});
    const transport = vi.fn<DeepLWebTransport>().mockResolvedValue(new Response(JSON.stringify({
      error: { code: 1042911, message: 'private upstream text', data: { token: 'private-value' } },
    }), { status: 429, headers: { 'retry-after': '120', 'set-cookie': 'private-cookie' } }));
    const provider = new DeepLWebProvider(transport, { onDiagnostic, persistCooldownUntil: persist });
    await expect(collect(provider)).rejects.toMatchObject({ code: 'RATE_LIMIT' });
    expect(onDiagnostic).toHaveBeenCalledExactlyOnceWith({
      at: 1_700_000_000_000, httpStatus: 429, rpcErrorCode: 1042911, retryAfterMs: 120_000,
      bodyOutcome: 'json', bodyCompletedAt: 1_700_000_000_000,
    });
    expect(persist).toHaveBeenCalledWith(1_700_000_120_000);
    expect(JSON.stringify(onDiagnostic.mock.calls)).not.toMatch(/private|message|token|cookie/);
    expect(transport).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { payload: { code: 77 }, expected: 77 },
    { payload: { error: { code: 88 } }, expected: 88 },
    { payload: { code: 77, error: { code: 88 } }, expected: 88 },
    { payload: { code: 77, error: { code: '88' } }, expected: 77 },
    { payload: { code: 0, error: 'private error' }, expected: 0 },
    { payload: { code: -32600 }, expected: -32600 },
  ])('retains a safe numeric code across known layouts: $expected', async ({ payload, expected }) => {
    const onDiagnostic = vi.fn();
    await expect(collect(new DeepLWebProvider(async () => new Response(JSON.stringify(payload), { status: 429 }),
      { onDiagnostic }))).rejects.toMatchObject({ code: 'RATE_LIMIT' });
    expect(onDiagnostic.mock.calls[0]![0]).toMatchObject({ bodyOutcome: 'json', rpcErrorCode: expected });
    expect(JSON.stringify(onDiagnostic.mock.calls)).not.toContain('private');
  });

  it.each([
    { payload: { message: 'Too many requests for private-user' }, reason: 'rate-limit' },
    { payload: { detail: 'Quota exhausted for private-account' }, reason: 'quota' },
    { payload: { message: 'Too many requests', error: { type: 'quota_exceeded', id: 'private-id' } }, reason: 'quota' },
    { payload: { error: { detail: 'Concurrency limit reached for private-device' } }, reason: 'concurrency' },
    { payload: { error: 'Too many concurrent requests for private-user' }, reason: 'concurrency' },
    { payload: { type: 'payload_too_large', message: 'private-source' }, reason: 'payload-limit' },
    { payload: { error: { message: 'Invalid access token private-token' } }, reason: 'authentication' },
    { payload: { error: { error: 'authentication_required', detail: 'private-user' } }, reason: 'authentication' },
  ])('publishes only the fixed $reason hint from known error fields', async ({ payload, reason }) => {
    const onDiagnostic = vi.fn();
    await expect(collect(new DeepLWebProvider(async () => new Response(JSON.stringify(payload), { status: 429 }),
      { onDiagnostic }))).rejects.toMatchObject({ code: 'RATE_LIMIT' });
    expect(onDiagnostic.mock.calls[0]![0]).toMatchObject({ bodyOutcome: 'json', responseReason: reason });
    expect(JSON.stringify(onDiagnostic.mock.calls)).not.toMatch(/private|message|detail|device|token|account/);
  });

  it('does not classify arbitrary fields, recursively scan data, or expose unknown error text', async () => {
    const onDiagnostic = vi.fn();
    const payload = { message: 'A private message about concurrent programming and quota planning.',
      code: 'private-code', text: 'quota exceeded', body: 'invalid credentials',
      error: { data: { message: 'concurrency limit reached', token: 'private-value' } } };
    await expect(collect(new DeepLWebProvider(async () => new Response(JSON.stringify(payload), { status: 429 }),
      { onDiagnostic }))).rejects.toMatchObject({ code: 'RATE_LIMIT' });
    const diagnostic = onDiagnostic.mock.calls[0]![0];
    expect(diagnostic).not.toHaveProperty('responseReason');
    expect(diagnostic).not.toHaveProperty('rpcErrorCode');
    expect(JSON.stringify(diagnostic)).not.toMatch(/private|message|credential|token|planning/);
  });

  it('keeps only literal numeric rate-limit headers, without interpreting units or reading identity headers', async () => {
    const onDiagnostic = vi.fn();
    const response = new Response(null, { status: 429, headers: {
      'RateLimit-Limit': '30', 'RateLimit-Remaining': '0', 'RateLimit-Reset': '1700000012',
      'Set-Cookie': 'private-cookie', 'X-Trace-ID': 'private-trace', 'X-Account-ID': 'private-account',
    } });
    const get = vi.spyOn(response.headers, 'get');
    const transport = vi.fn<DeepLWebTransport>().mockResolvedValue(response);
    await expect(collect(new DeepLWebProvider(transport, { onDiagnostic }))).rejects.toMatchObject({ code: 'RATE_LIMIT' });
    const diagnostic = onDiagnostic.mock.calls[0]![0];
    expect(diagnostic).toMatchObject({ rateLimitLimit: 30, rateLimitRemaining: 0, rateLimitReset: 1700000012, bodyOutcome: 'empty' });
    expect(Object.keys(diagnostic).sort()).toEqual(['at', 'httpStatus', 'rateLimitLimit', 'rateLimitRemaining',
      'rateLimitReset', 'bodyOutcome', 'bodyCompletedAt'].sort());
    expect(get.mock.calls.map(([header]) => header)).toEqual(['retry-after', 'ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset']);
    expect(JSON.stringify(diagnostic)).not.toMatch(/private|cookie|trace|account/);
    expect(transport).toHaveBeenCalledOnce();
  });

  it.each(['', '-1', '1.5', '1e3', 'Infinity', '9007199254740992', '30;w=12', '30, 60']) (
    'omits malformed or unsupported rate-limit header values (%s)', async value => {
      const onDiagnostic = vi.fn();
      await expect(collect(new DeepLWebProvider(async () => new Response(null, { status: 429,
        headers: { 'RateLimit-Limit': value, 'RateLimit-Remaining': value, 'RateLimit-Reset': value } }),
      { onDiagnostic }))).rejects.toMatchObject({ code: 'RATE_LIMIT' });
      const diagnostic = onDiagnostic.mock.calls[0]![0];
      expect(diagnostic).not.toHaveProperty('rateLimitLimit');
      expect(diagnostic).not.toHaveProperty('rateLimitRemaining');
      expect(diagnostic).not.toHaveProperty('rateLimitReset');
      expect(diagnostic).toMatchObject({ bodyOutcome: 'empty' });
    },
  );

  it.each([
    { body: '<html>private verification message</html>', outcome: 'non-json' },
    { body: '', outcome: 'empty' },
    { body: '   \n', outcome: 'empty' },
    { body: null, outcome: 'empty' },
  ])('classifies $outcome bodies without publishing their text', async ({ body, outcome }) => {
    fakeTime(); const onDiagnostic = vi.fn();
    const failure = await collect(new DeepLWebProvider(async () => new Response(body, { status: 429 }), { onDiagnostic })).catch(error => error);
    expect(failure).toMatchObject({ code: 'RATE_LIMIT' });
    expect(onDiagnostic).toHaveBeenCalledExactlyOnceWith({ at: 1_700_000_000_000, httpStatus: 429,
      bodyOutcome: outcome, bodyCompletedAt: 1_700_000_000_000 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['1042911', 1.5, 1e100, null])('omits non-integer or unsafe upstream error codes (%s)', async code => {
    const onDiagnostic = vi.fn();
    await expect(collect(new DeepLWebProvider(async () => new Response(JSON.stringify({ error: { code } }), { status: 429 }),
      { onDiagnostic }))).rejects.toMatchObject({ code: 'RATE_LIMIT' });
    expect(onDiagnostic.mock.calls[0]![0]).toMatchObject({ bodyOutcome: 'json' });
    expect(onDiagnostic.mock.calls[0]![0]).not.toHaveProperty('rpcErrorCode');
  });

  it('parses HTTP-date Retry-After without exposing the response headers', async () => {
    fakeTime(); const onDiagnostic = vi.fn();
    await expect(collect(new DeepLWebProvider(async () => new Response(null, { status: 429,
      headers: { 'retry-after': new Date(1_700_000_090_000).toUTCString() } }), { onDiagnostic })))
      .rejects.toMatchObject({ code: 'RATE_LIMIT' });
    expect(onDiagnostic.mock.calls[0]![0]).toMatchObject({ retryAfterMs: 90_000, bodyOutcome: 'empty' });
  });

  it('accepts an exact 8 KiB JSON body and cancels oversized UTF-8 bodies without parsing a prefix', async () => {
    fakeTime(); const onDiagnostic = vi.fn();
    const exact = JSON.stringify({ error: { code: 1042911 } }).padEnd(8 * 1024, ' ');
    await expect(collect(new DeepLWebProvider(async () => new Response(exact, { status: 429 }), { onDiagnostic })))
      .rejects.toMatchObject({ code: 'RATE_LIMIT' });
    expect(onDiagnostic.mock.calls[0]![0]).toMatchObject({ bodyOutcome: 'json', rpcErrorCode: 1042911 });
    onDiagnostic.mockClear();
    const canceled = vi.fn();
    const response = new Response(new ReadableStream({
      start(stream) { stream.enqueue(new TextEncoder().encode('中'.repeat(3_000))); }, cancel: canceled,
    }), { status: 429 });
    await expect(collect(new DeepLWebProvider(async () => response, { onDiagnostic }))).rejects.toMatchObject({ code: 'RATE_LIMIT' });
    expect(onDiagnostic.mock.calls[0]![0]).toMatchObject({ bodyOutcome: 'truncated' });
    expect(onDiagnostic.mock.calls[0]![0]).not.toHaveProperty('rpcErrorCode');
    expect(canceled).toHaveBeenCalledOnce(); expect(response.body!.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('flushes queued work and starts persistence before a hanging error body reaches its deadline', async () => {
    fakeTime(); const onDiagnostic = vi.fn(); const saved = deferred<void>();
    const persist = vi.fn(() => saved.promise);
    const canceled = vi.fn(() => new Promise<void>(() => {}));
    const response = new Response(new ReadableStream({
      start(stream) { stream.enqueue(new TextEncoder().encode('{')); }, cancel: canceled,
    }), { status: 429 });
    const transport = vi.fn<DeepLWebTransport>().mockResolvedValue(response);
    const provider = new DeepLWebProvider(transport, { onDiagnostic, persistCooldownUntil: persist });
    let finished = false;
    const active = collect(provider).catch(error => { finished = true; return error; });
    const waiting = collect(provider).catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(await waiting).toMatchObject({ code: 'RATE_LIMIT' });
    expect(persist).toHaveBeenCalledWith(1_700_000_060_000);
    expect(finished).toBe(false); expect(onDiagnostic).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(999); expect(onDiagnostic).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onDiagnostic).toHaveBeenCalledExactlyOnceWith({ at: 1_700_000_000_000, httpStatus: 429,
      bodyOutcome: 'timeout', bodyCompletedAt: 1_700_000_001_000 });
    expect(finished).toBe(false); expect(canceled).toHaveBeenCalledOnce();
    expect(response.body!.locked).toBe(false); expect(vi.getTimerCount()).toBe(0);
    saved.resolve(undefined); expect(await active).toMatchObject({ code: 'RATE_LIMIT' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(transport).toHaveBeenCalledOnce(); // A timeout or expired cooldown never retries queued work.
  });

  it('classifies stream read errors without replacing the rate limit or leaking exception text', async () => {
    fakeTime(); const onDiagnostic = vi.fn();
    const response = new Response(new ReadableStream({ start(stream) { stream.error(new Error('private read failure')); } }), { status: 429 });
    const failure = await collect(new DeepLWebProvider(async () => response, { onDiagnostic })).catch(error => error);
    expect(failure).toMatchObject({ code: 'RATE_LIMIT' }); expect(failure.message).not.toContain('private');
    expect(onDiagnostic.mock.calls[0]![0]).toMatchObject({ bodyOutcome: 'read-error' });
    expect(response.body!.locked).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts error-body diagnostics immediately without clearing the already established cooldown', async () => {
    fakeTime(); const onDiagnostic = vi.fn(); const canceled = vi.fn(); const controller = new AbortController();
    const response = new Response(new ReadableStream({ start(stream) { stream.enqueue(new Uint8Array([123])); }, cancel: canceled }), { status: 429 });
    const transport = vi.fn<DeepLWebTransport>().mockResolvedValue(response);
    const provider = new DeepLWebProvider(transport, { onDiagnostic });
    const active = collect(provider, input, controller.signal).catch(error => error);
    await vi.advanceTimersByTimeAsync(0); controller.abort();
    expect(await active).toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0);
    expect(onDiagnostic.mock.calls[0]![0]).toMatchObject({ bodyOutcome: 'aborted' });
    expect(canceled).toHaveBeenCalledOnce(); expect(response.body!.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await expect(collect(provider)).rejects.toMatchObject({ code: 'RATE_LIMIT' });
    expect(transport).toHaveBeenCalledOnce();
  });

  it('isolates diagnostic callback failures and leaves successful parsing unchanged', async () => {
    const onDiagnostic = vi.fn(() => { throw new Error('private observer failure'); });
    const limitedResponse = new Response('{"error":{"code":1042911}}', { status: 429 });
    const failure = await collect(new DeepLWebProvider(async () => limitedResponse, { onDiagnostic })).catch(error => error);
    expect(failure).toMatchObject({ code: 'RATE_LIMIT' }); expect(failure.message).not.toContain('private');
    expect(onDiagnostic).toHaveBeenCalledOnce(); onDiagnostic.mockClear();
    expect((await collect(new DeepLWebProvider(async body => reply(body), { onDiagnostic }))).at(-1))
      .toMatchObject({ type: 'result' });
    expect(onDiagnostic).not.toHaveBeenCalled();
  });
});
