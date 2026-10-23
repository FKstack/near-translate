import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FREE_TRANSLATION_SAMPLE, FreeTranslationCheck } from '../../src/platform/free-translation-check';
import type { TranslationError, TranslationEvent, TranslationProvider } from '../../src/shared/contracts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const result = (translation = '图书馆早上九点开门。'): TranslationEvent => ({ type: 'result', result: { kind: 'text', translation } });
const flush = async () => { for (let turn = 0; turn < 8; turn++) await Promise.resolve(); };
let fetcher: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(1_000);
  fetcher = vi.fn(() => { throw new Error('Service checks must use the injected provider.'); });
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => {
  expect(fetcher).not.toHaveBeenCalled();
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
});

function setup(translate: TranslationProvider['translate']) {
  const provider = { translate: vi.fn(translate) };
  const toError = vi.fn((_error: unknown): TranslationError => ({ code: 'SERVER', message: '注入的安全错误', retryable: true }));
  return { provider, toError, check: new FreeTranslationCheck(provider, toError) };
}

describe('explicit free translation service check', () => {
  it('sends only the fixed public English sample with an explicit Chinese target and measures elapsed time', async () => {
    const gate = deferred<void>();
    const { check, provider, toError } = setup(async function* (): AsyncGenerator<TranslationEvent> {
      await gate.promise; yield result();
    });
    const pending = check.run();
    expect(provider.translate).toHaveBeenCalledTimes(1);
    const [input, signal] = provider.translate.mock.calls[0]!;
    expect(input).toEqual({ text: 'The library opens at nine in the morning.', kind: 'text', sourceLanguage: 'en', targetLanguage: 'zh-Hans' });
    expect(input.text).toBe(FREE_TRANSLATION_SAMPLE); expect(signal).toBeInstanceOf(AbortSignal);
    vi.setSystemTime(1_234); gate.resolve(undefined);
    expect(await pending).toEqual({ ok: true, translation: '图书馆早上九点开门。', elapsedMs: 234 });
    expect(toError).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it('coalesces concurrent explicit runs into the same promise and one provider owner', async () => {
    const gate = deferred<void>();
    const { check, provider } = setup(async function* (): AsyncGenerator<TranslationEvent> { await gate.promise; yield result(); });
    const first = check.run(); const second = check.run(); const third = check.run();
    expect(second).toBe(first); expect(third).toBe(first); expect(provider.translate).toHaveBeenCalledTimes(1);
    gate.resolve(undefined); expect(await first).toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(60_000); expect(provider.translate).toHaveBeenCalledTimes(1);
  });

  it('times out at twenty seconds, aborts compliant work and does not retry automatically', async () => {
    const { check, provider, toError } = setup(async function* (_input, signal): AsyncGenerator<TranslationEvent> {
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
    });
    let settled = false; const pending = check.run(); void pending.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(19_999); expect(settled).toBe(false);
    expect(provider.translate.mock.calls[0]![1].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ ok: false, error: { code: 'TIMEOUT', retryable: true } });
    expect(provider.translate.mock.calls[0]![1].aborted).toBe(true); expect(toError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000); expect(provider.translate).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels an explicit check without treating the abort as a provider error', async () => {
    const { check, provider, toError } = setup(async function* (_input, signal): AsyncGenerator<TranslationEvent> {
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
    });
    check.cancel(); expect(provider.translate).not.toHaveBeenCalled();
    const pending = check.run(); check.cancel(); check.cancel();
    expect(await pending).toMatchObject({ ok: false, error: { code: 'DISCONNECTED', retryable: true } });
    await flush(); expect(provider.translate.mock.calls[0]![1].aborted).toBe(true);
    expect(toError).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['cancel', 'timeout'] as const)('retains the unique owner after %s until an abort-ignoring provider actually releases', async action => {
    const release = deferred<void>(); let released = 0;
    const { check, provider } = setup(async function* (): AsyncGenerator<TranslationEvent> {
      try { await release.promise; yield result('不应覆盖取消结果'); } finally { released++; }
    });
    const first = check.run(); await flush();
    if (action === 'cancel') check.cancel(); else await vi.advanceTimersByTimeAsync(20_000);
    expect(await first).toMatchObject({ ok: false, error: { code: action === 'cancel' ? 'DISCONNECTED' : 'TIMEOUT' } });
    expect(check.run()).toBe(first); expect(provider.translate).toHaveBeenCalledTimes(1); expect(released).toBe(0);
    release.resolve(undefined); await flush();
    expect(released).toBe(1); expect(await first).toMatchObject({ ok: false });
    const next = check.run(); expect(next).not.toBe(first); expect(provider.translate).toHaveBeenCalledTimes(2);
    expect(await next).toMatchObject({ ok: true, translation: '不应覆盖取消结果' }); expect(vi.getTimerCount()).toBe(0);
  });

  it('uses the injected error mapper and waits for another explicit run after a provider failure', async () => {
    const failure = new Error('provider-private-error');
    const { check, provider, toError } = setup(async function* (): AsyncGenerator<TranslationEvent> { throw failure; });
    expect(await check.run()).toEqual({ ok: false, error: { code: 'SERVER', message: '注入的安全错误', retryable: true } });
    expect(toError).toHaveBeenCalledExactlyOnceWith(failure);
    await vi.advanceTimersByTimeAsync(60_000); expect(provider.translate).toHaveBeenCalledTimes(1);
    expect(await check.run()).toMatchObject({ ok: false }); expect(provider.translate).toHaveBeenCalledTimes(2);
  });

  it.each([
    { name: 'empty', translation: '' }, { name: 'blank', translation: ' \n' }, { name: 'overlong', translation: '中'.repeat(2_001) },
  ])('rejects a $name terminal translation without retries', async ({ translation }) => {
    const { check, provider, toError } = setup(async function* (): AsyncGenerator<TranslationEvent> { yield result(translation); });
    expect(await check.run()).toMatchObject({ ok: false, error: { code: 'INVALID_RESPONSE', retryable: true } });
    await vi.advanceTimersByTimeAsync(60_000); expect(provider.translate).toHaveBeenCalledTimes(1); expect(toError).not.toHaveBeenCalled();
  });

  it('requires a complete text result rather than a partial delta', async () => {
    const { check } = setup(async function* (): AsyncGenerator<TranslationEvent> { yield { type: 'delta', text: '部分结果' }; });
    expect(await check.run()).toMatchObject({ ok: false, error: { code: 'INVALID_RESPONSE' } }); expect(vi.getTimerCount()).toBe(0);
  });
});
