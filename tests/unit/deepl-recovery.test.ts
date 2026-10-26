import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeepLWebProvider, type DeepLWebTransport } from '../../src/providers/deepl-web';
import { PageTranslationSession } from '../../src/page/session';
import { toTranslationError, TranslationFailure } from '../../src/core/errors';
import type { TranslationEvent, TranslationInput } from '../../src/shared/contracts';
import type { PageSegment } from '../../src/page/segments';
import { DEEPL_WEB_SCHEDULING } from '../../src/shared/translation-policy';

vi.mock('../../src/platform/translation-client', () => ({ TranslationClient: class {} }));
const input: TranslationInput = { kind: 'text', text: 'Public recovery passage.' };
const signal = () => new AbortController().signal;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function reply(body: string) { return new Response(JSON.stringify({ translations: JSON.parse(body).text.map(() => ({ text: '完整公开译文' })) })); }
async function collect(provider: DeepLWebProvider, controllerSignal = signal(), value = input): Promise<TranslationEvent[]> {
  const events: TranslationEvent[] = [];
  for await (const event of provider.translate(value, controllerSignal)) events.push(event);
  return events;
}
function fakeTime() { vi.useFakeTimers(); vi.setSystemTime(1_700_000_000_000); }
afterEach(() => { vi.useRealTimers(); });

describe('DeepL recovery after confirmed upstream limiting', () => {
  it('leaves the initial eight-slot admission and 100ms spacing unchanged', async () => {
    fakeTime();
    const responses = Array.from({ length: 8 }, () => deferred<Response>()); const starts: number[] = [];
    const transport = vi.fn<DeepLWebTransport>().mockImplementation(() => {
      const index = starts.length; starts.push(Date.now()); return responses[index]!.promise;
    });
    const recovered = vi.fn(async () => {});
    const provider = new DeepLWebProvider(transport, { ...DEEPL_WEB_SCHEDULING, onRecoverySucceeded: recovered });
    const jobs = Array.from({ length: 8 }, () => collect(provider));
    await vi.advanceTimersByTimeAsync(700);
    expect(starts.map(at => at - starts[0]!)).toEqual([0, 100, 200, 300, 400, 500, 600, 700]);
    responses.forEach((response, index) => response.resolve(reply(transport.mock.calls[index]![0])));
    await Promise.all(jobs); expect(recovered).not.toHaveBeenCalled();
  });

  it('holds recovery peers until one real translation body is complete and valid, then resumes with spacing', async () => {
    fakeTime(); let body!: ReadableStreamDefaultController<Uint8Array>;
    const recovered = vi.fn(async () => {}); const starts: number[] = [];
    const transport = vi.fn<DeepLWebTransport>().mockImplementation(async value => {
      starts.push(Date.now());
      if (starts.length === 1) return new Response('{}', { status: 429 });
      if (starts.length === 2) return new Response(new ReadableStream({ start(controller) { body = controller; } }));
      return reply(value);
    });
    const provider = new DeepLWebProvider(transport, { ...DEEPL_WEB_SCHEDULING, onRecoverySucceeded: recovered });
    await expect(collect(provider)).rejects.toMatchObject({ code: 'RATE_LIMIT' });
    const until = (await provider.getServiceStatus()).cooldownUntil;
    await vi.advanceTimersByTimeAsync(30_000); expect(starts).toHaveLength(1);
    const jobs = Array.from({ length: 8 }, () => collect(provider));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(starts).toHaveLength(2); expect(recovered).not.toHaveBeenCalled();
    body.enqueue(new TextEncoder().encode('{"translations":[{"text":"完整译文"}]}')); body.close();
    await vi.advanceTimersByTimeAsync(1_000); await Promise.all(jobs);
    expect(recovered).toHaveBeenCalledExactlyOnceWith(until, expect.any(Function));
    expect(starts.slice(2).every((at, index) => index === 0 || at - starts[index + 1]! >= 100)).toBe(true);
    expect(starts).toHaveLength(9);
  });

  it.each(['network', 'invalid', 'auth'] as const)('propagates a %s probe failure to all existing waiters without further probes', async mode => {
    fakeTime();
    let phase = 0;
    const transport = vi.fn<DeepLWebTransport>().mockImplementation(async body => {
      if (phase === 0) return new Response('{}', { status: 429 });
      if (phase === 1) {
        if (mode === 'network') throw new TypeError('private exception');
        return new Response(mode === 'invalid' ? '{"translations":[]}' : '{}', { status: mode === 'auth' ? 403 : 200 });
      }
      return reply(body);
    });
    const provider = new DeepLWebProvider(transport, DEEPL_WEB_SCHEDULING);
    await collect(provider).catch(() => {}); phase = 1;
    await vi.advanceTimersByTimeAsync(30_000);
    const jobs = Array.from({ length: 8 }, () => collect(provider).catch(error => error));
    await vi.advanceTimersByTimeAsync(0);
    const errors = await Promise.all(jobs);
    expect(errors.every(error => error.code === ({ network: 'NETWORK', invalid: 'INVALID_RESPONSE', auth: 'AUTH' }[mode]))).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000); expect(transport).toHaveBeenCalledTimes(2);
    phase = 2; expect((await collect(provider)).at(-1)).toMatchObject({ type: 'result' });
  });

  it('does not let cancellation or a stale valid response recover the service', async () => {
    fakeTime(); const old = deferred<Response>(); let phase = 0;
    const transport = vi.fn<DeepLWebTransport>().mockImplementation(async body => {
      if (phase === 0) return new Response('{}', { status: 429 });
      if (phase === 1) return old.promise;
      return reply(body);
    });
    const recovered = vi.fn(async () => {});
    const provider = new DeepLWebProvider(transport, { ...DEEPL_WEB_SCHEDULING, onRecoverySucceeded: recovered });
    await collect(provider).catch(() => {}); phase = 1; await vi.advanceTimersByTimeAsync(30_000);
    const controller = new AbortController();
    const probe = collect(provider, controller.signal).catch(error => error);
    const waiting = collect(provider).catch(error => error);
    await vi.advanceTimersByTimeAsync(0); controller.abort();
    expect(await probe).toMatchObject({ name: 'AbortError' }); expect(await waiting).toMatchObject({ name: 'AbortError' });
    old.resolve(reply(transport.mock.calls[1]![0])); await vi.advanceTimersByTimeAsync(0);
    expect(recovered).not.toHaveBeenCalled(); expect(transport).toHaveBeenCalledTimes(2);
    phase = 2; const retry = collect(provider); await vi.advanceTimersByTimeAsync(100); await retry;
    expect(recovered).toHaveBeenCalledOnce();
  });

  it('backs off only consecutive real upstream limits, caps the local delay and honours a longer Retry-After', async () => {
    fakeTime(); const diagnostic = vi.fn();
    let success = false; let retryAfter: string | undefined;
    const transport = vi.fn<DeepLWebTransport>().mockImplementation(async body => success ? reply(body)
      : new Response('{}', { status: 429, headers: retryAfter ? { 'Retry-After': retryAfter } : {} }));
    const provider = new DeepLWebProvider(transport, { ...DEEPL_WEB_SCHEDULING, onDiagnostic: diagnostic });
    for (const wait of [30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000]) {
      const at = Date.now(); await expect(collect(provider)).rejects.toMatchObject({ code: 'RATE_LIMIT', retryAt: at + wait });
      const calls = transport.mock.calls.length;
      for (let local = 0; local < 3; local++) await collect(provider).catch(() => {});
      expect(transport).toHaveBeenCalledTimes(calls);
      await vi.advanceTimersByTimeAsync(wait); expect(transport).toHaveBeenCalledTimes(calls);
    }
    retryAfter = '1800'; const at = Date.now();
    await expect(collect(provider)).rejects.toMatchObject({ retryAt: at + 1_800_000 });
    await vi.advanceTimersByTimeAsync(1_800_000);
    success = true;
    for (let count = 0; count < 8; count++) {
      const healthy = collect(provider); await vi.advanceTimersByTimeAsync(100); await healthy;
    }
    success = false; retryAfter = undefined;
    await vi.advanceTimersByTimeAsync(100);
    await expect(collect(provider)).rejects.toMatchObject({ retryAt: Date.now() + 30_000 });
    expect(diagnostic).toHaveBeenCalledTimes(9);
    expect(diagnostic.mock.calls.every(([item]) => item.origin === 'upstream' && item.source === 'http-429')).toBe(true);
  });

  it('keeps the failure episode after a single successful probe and clears it only after a healthy eight-response window', async () => {
    fakeTime(); let limited = true;
    const transport = vi.fn<DeepLWebTransport>().mockImplementation(async body => limited ? new Response('{}', { status: 429 }) : reply(body));
    const provider = new DeepLWebProvider(transport, DEEPL_WEB_SCHEDULING);
    await expect(collect(provider)).rejects.toMatchObject({ retryAt: Date.now() + 30_000 });
    await vi.advanceTimersByTimeAsync(30_000); limited = false; await collect(provider);
    limited = true; await vi.advanceTimersByTimeAsync(100);
    await expect(collect(provider)).rejects.toMatchObject({ retryAt: Date.now() + 60_000 });
    await vi.advanceTimersByTimeAsync(60_000); limited = false;
    for (let count = 0; count < 7; count++) {
      const valid = collect(provider); await vi.advanceTimersByTimeAsync(100); await valid;
    }
    // Seven successful responses, including the probe, still retain the episode.
    limited = true;
    await expect(collect(provider)).rejects.toMatchObject({ retryAt: Date.now() + 120_000 });
    await vi.advanceTimersByTimeAsync(120_000); limited = false;
    for (let count = 0; count < 8; count++) {
      const valid = collect(provider); await vi.advanceTimersByTimeAsync(100); await valid;
    }
    limited = true;
    await expect(collect(provider)).rejects.toMatchObject({ retryAt: Date.now() + 30_000 });
  });

  it('does not count a local queue rejection or a restored cooldown as an upstream limit episode', async () => {
    fakeTime(); const response = deferred<Response>(); const diagnostic = vi.fn();
    const transport = vi.fn<DeepLWebTransport>().mockImplementation(() => response.promise);
    const provider = new DeepLWebProvider(transport, { maxConcurrent: 1, maxQueuedRequests: 1, onDiagnostic: diagnostic,
      loadCooldownUntil: async () => Date.now() - 1 });
    await provider.getServiceStatus();
    const first = collect(provider).catch(error => error); const peer = collect(provider).catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    await expect(collect(provider)).rejects.toMatchObject({ code: 'RATE_LIMIT' });
    response.resolve(new Response('{}', { status: 429 }));
    expect(await first).toMatchObject({ retryAt: Date.now() + 30_000 }); expect(await peer).toMatchObject({ code: 'RATE_LIMIT' });
    expect(diagnostic).toHaveBeenCalledOnce();
  });

  it('publishes sanitized JSON limiting diagnostics with the actual HTTP status', async () => {
    fakeTime(); const onDiagnostic = vi.fn();
    const provider = new DeepLWebProvider(async () => new Response(JSON.stringify({ error: {
      message: 'Too many requests for private-user', code: 123, token: 'private-token', data: { value: 'private-article' },
    } }), { headers: { 'Retry-After': '120', 'Set-Cookie': 'private-cookie' } }), { onDiagnostic });
    await expect(collect(provider)).rejects.toMatchObject({ code: 'RATE_LIMIT', retryAt: Date.now() + 120_000 });
    expect(onDiagnostic).toHaveBeenCalledExactlyOnceWith({ at: Date.now(), httpStatus: 200, origin: 'upstream', source: 'json-too-many-requests',
      rpcErrorCode: 123, responseReason: 'rate-limit', retryAfterMs: 120_000, bodyOutcome: 'json', bodyCompletedAt: Date.now() });
    expect(JSON.stringify(onDiagnostic.mock.calls[0]![0])).not.toMatch(/private|cookie|token|article|user/);
  });

  it('arms recovery for a later shared cooldown without counting it as an upstream episode', async () => {
    fakeTime(); const recovered = vi.fn(async () => {}); const response = deferred<Response>();
    let limit = false; let held = false;
    const transport = vi.fn<DeepLWebTransport>().mockImplementation(async body => {
      if (held) return response.promise;
      return limit ? new Response('{}', { status: 429 }) : reply(body);
    });
    const provider = new DeepLWebProvider(transport, { ...DEEPL_WEB_SCHEDULING, onRecoverySucceeded: recovered });
    await collect(provider);
    const until = Date.now() + 60_000; provider.observeCooldownUntil(until);
    await expect(collect(provider)).rejects.toMatchObject({ code: 'RATE_LIMIT', retryAt: until });
    await vi.advanceTimersByTimeAsync(60_000); held = true;
    const first = collect(provider); const waiting = collect(provider);
    await vi.advanceTimersByTimeAsync(1000); expect(transport).toHaveBeenCalledTimes(2);
    provider.observeCooldownUntil(0); provider.observeCooldownUntil(until);
    expect(recovered).not.toHaveBeenCalled();
    held = false; response.resolve(reply(transport.mock.calls[1]![0])); await vi.advanceTimersByTimeAsync(100); await Promise.all([first, waiting]);
    expect(recovered).toHaveBeenCalledExactlyOnceWith(until, expect.any(Function));
    limit = true; await vi.advanceTimersByTimeAsync(100);
    await expect(collect(provider)).rejects.toMatchObject({ retryAt: Date.now() + 30_000 });
  });

  it('copies service-wide stopping only from a trusted local translation failure', () => {
    const original = new TranslationFailure('INVALID_RESPONSE', '恢复验证未完成。', true, undefined, true);
    expect(toTranslationError(original)).toEqual({ code: 'INVALID_RESPONSE', message: '恢复验证未完成。', retryable: true, serviceWide: true });
    expect(toTranslationError(Object.assign(new Error('private'), { serviceWide: true, code: 'INVALID_RESPONSE' })))
      .toEqual({ code: 'SERVER', message: '翻译暂时失败，请稍后重试。', retryable: true });
  });

  it.each(['shared', 'cancelled', 'invalid'] as const)('restarts the healthy-response window after %s without incrementing the upstream episode', async interruption => {
    fakeTime(); let limited = true; let invalid = false; let held: ReturnType<typeof deferred<Response>> | undefined;
    const transport = vi.fn<DeepLWebTransport>().mockImplementation(async body => {
      if (held) return held.promise;
      if (invalid) return new Response('{"translations":[]}');
      return limited ? new Response('{}', { status: 429 }) : reply(body);
    });
    const provider = new DeepLWebProvider(transport, DEEPL_WEB_SCHEDULING);
    await collect(provider).catch(() => {}); await vi.advanceTimersByTimeAsync(30_000); limited = false;
    for (let count = 0; count < 7; count++) {
      const valid = collect(provider); await vi.advanceTimersByTimeAsync(100); await valid;
    }
    if (interruption === 'shared') {
      provider.observeCooldownUntil(Date.now() + 60_000); await vi.advanceTimersByTimeAsync(60_000);
    } else if (interruption === 'cancelled') {
      held = deferred<Response>(); const controller = new AbortController();
      const cancelled = collect(provider, controller.signal).catch(error => error);
      await vi.advanceTimersByTimeAsync(0); controller.abort();
      expect(await cancelled).toMatchObject({ name: 'AbortError' });
      held.resolve(reply(transport.mock.calls.at(-1)![0])); held = undefined; await vi.advanceTimersByTimeAsync(100);
    } else {
      invalid = true; await expect(collect(provider)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
      invalid = false; await vi.advanceTimersByTimeAsync(100);
    }
    await collect(provider); limited = true; await vi.advanceTimersByTimeAsync(100);
    await expect(collect(provider)).rejects.toMatchObject({ retryAt: Date.now() + 60_000 });
  });

  it('does not use optional metadata preparation to reopen an expired restored cooldown', async () => {
    fakeTime(); const prepareTransport = vi.fn(async () => new Response(null, { status: 204 }));
    const provider = new DeepLWebProvider(async body => reply(body), { loadCooldownUntil: async () => Date.now() - 1, prepareTransport });
    await provider.prepareNetwork(); expect(prepareTransport).not.toHaveBeenCalled();
    expect((await collect(provider)).at(-1)).toMatchObject({ type: 'result' });
  });

  it.each(['valid', 'invalid-then-success', 'manual-stop'] as const)('keeps 193 successes and manually recovers only 58 pending sources (%s)', async mode => {
    fakeTime();
    const limited = deferred<Response>(); const probe = deferred<Response>(); const secondProbe = deferred<Response>();
    let holdSecondProbe = false;
    const transport = vi.fn<DeepLWebTransport>().mockImplementation(async body => {
      if (transport.mock.calls.length === 1) return limited.promise;
      if (transport.mock.calls.length === 2) return probe.promise;
      if (holdSecondProbe && transport.mock.calls.length === 3) return secondProbe.promise;
      return reply(body);
    });
    const provider = new DeepLWebProvider(transport, DEEPL_WEB_SCHEDULING);
    const sources: PageSegment[] = Array.from({ length: 251 }, (_, index) => {
      const node = {} as Text;
      return { text: `Public source ${index}.`.padEnd(200, 'x'), nodes: [node], anchor: node, container: {} as HTMLElement };
    });
    let serial = 0;
    const session = new PageTranslationSession({ onChange() {}, onSegment() {}, isCurrent: () => true }, receive => {
      let current: AbortController | undefined;
      return { start(value) {
        const requestId = `recovery-${++serial}`; const owner = new AbortController(); current = owner;
        queueMicrotask(() => { void (async () => {
          try { for await (const event of provider.translate(value, owner.signal)) if (current === owner) receive({ ...event, requestId }); }
          catch (error) { if (current === owner && !owner.signal.aborted) receive({ type: 'error', requestId, error: toTranslationError(error) }); }
        })(); });
        return requestId;
      }, cancel() { current?.abort(); current = undefined; }, dispose() { current?.abort(); current = undefined; } };
    });
    try {
      session.seedTranslations(new Map(sources.slice(0, 193).map(source => [source.text, '此前已完成译文'])));
      session.start(sources, { concurrency: 8, batchMaxItems: 32, batchTargetChars: 1500, batchSeparatorChars: 0, packing: 'fill' });
      await vi.advanceTimersByTimeAsync(0);
      if (mode === 'manual-stop') { session.cancel(); limited.resolve(reply(transport.mock.calls[0]![0])); }
      else limited.resolve(new Response('{}', { status: 429 }));
      await vi.advanceTimersByTimeAsync(0);
      expect(session.state).toMatchObject({ status: 'stopped', total: 251, completed: 193, pending: 58, failed: 0 });
      if (mode === 'manual-stop') {
        expect(session.state.error).toBeUndefined(); expect(await provider.getServiceStatus()).toEqual({ cooldownUntil: 0 });
        await vi.advanceTimersByTimeAsync(100);
      } else {
        expect(session.state.error).toMatchObject({ code: 'RATE_LIMIT' }); await vi.advanceTimersByTimeAsync(30_000);
      }
      expect(transport).toHaveBeenCalledOnce();
      session.retryFailed(); await vi.advanceTimersByTimeAsync(2_000); expect(transport).toHaveBeenCalledTimes(2);
      if (mode === 'invalid-then-success') {
        probe.resolve(new Response('{"translations":[]}')); await vi.advanceTimersByTimeAsync(5_000);
        expect(session.state).toMatchObject({ status: 'stopped', completed: 193, pending: 58, failed: 0,
          error: { code: 'INVALID_RESPONSE', serviceWide: true } });
        expect(transport).toHaveBeenCalledTimes(2);
        holdSecondProbe = true; session.retryFailed(); await vi.advanceTimersByTimeAsync(2_000);
        expect(transport).toHaveBeenCalledTimes(3);
        secondProbe.resolve(reply(transport.mock.calls[2]![0]));
      } else probe.resolve(reply(transport.mock.calls[1]![0]));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(session.state).toMatchObject({ status: 'done', completed: 251, pending: 0, failed: 0 });
      const retried: string[] = transport.mock.calls.slice(mode === 'invalid-then-success' ? 2 : 1).flatMap(([body]) => JSON.parse(body).text);
      expect(new Set(retried)).toEqual(new Set(sources.slice(193).map(source => source.text)));
      expect(retried).toHaveLength(58);
      expect(sources.slice(0, 193).every(source => !retried.includes(source.text))).toBe(true);
    } finally { session.dispose(); }
  });
});
