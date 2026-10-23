import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranslationServiceStatus } from '../../src/shared/contracts';

type StatusSender = { id?: string; url?: string; tab?: unknown };
const mocks = vi.hoisted(() => {
  const listeners = new Set<(message: unknown, sender: StatusSender) => void>();
  return { sendMessage: vi.fn(), connect: vi.fn(), listeners,
    addListener: vi.fn(listener => { listeners.add(listener); }),
    removeListener: vi.fn(listener => { listeners.delete(listener); }) };
});
vi.mock('wxt/browser', () => ({ browser: { runtime: { id: 'test-extension', getURL: (path: string) => `chrome-extension://test-extension/${path}`,
  sendMessage: mocks.sendMessage, connect: mocks.connect,
  onMessage: { addListener: mocks.addListener, removeListener: mocks.removeListener } } } }));
import { TranslationServiceStatusClient } from '../../src/platform/service-status';

class PageDocument extends EventTarget {
  visibilityState: 'visible' | 'hidden' = 'visible';
  visibility(value: 'visible' | 'hidden') { this.visibilityState = value; this.dispatchEvent(new Event('visibilitychange')); }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const current = (cooldownUntil = 0, checkedAt = 1_000): TranslationServiceStatus => ({ engine: 'deepl-web', cooldownUntil, checkedAt });
const response = (cooldownUntil = 0, checkedAt = 1_000) => ({ ok: true, status: current(cooldownUntil, checkedAt) });
const broadcast = (status: unknown, sender: StatusSender = { id: 'test-extension' }, type = 'translation-status-changed') => {
  for (const listener of mocks.listeners) listener({ type, status }, sender);
};
const flush = async () => { for (let turn = 0; turn < 6; turn++) await Promise.resolve(); };
let page: PageDocument;
let client: TranslationServiceStatusClient;
let fetcher: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(1_000);
  page = new PageDocument(); vi.stubGlobal('document', page);
  mocks.sendMessage.mockReset().mockResolvedValue(response()); mocks.connect.mockReset();
  mocks.listeners.clear(); mocks.addListener.mockClear(); mocks.removeListener.mockClear();
  fetcher = vi.fn(() => { throw new Error('Status observation must not access a translation endpoint.'); });
  vi.stubGlobal('fetch', fetcher);
  client = new TranslationServiceStatusClient();
});
afterEach(() => {
  client.dispose(); expect(vi.getTimerCount()).toBe(0);
  expect(mocks.listeners.size).toBe(0);
  expect(fetcher).not.toHaveBeenCalled(); expect(mocks.connect).not.toHaveBeenCalled();
  for (const call of mocks.sendMessage.mock.calls) expect(call).toEqual([{ type: 'get-translation-status' }]);
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('document-owned translation service status observation', () => {
  it('shares one initial IPC and event listeners between two subscribers without idle polling', async () => {
    const add = vi.spyOn(page, 'addEventListener'); const first = vi.fn(); const second = vi.fn();
    const stopFirst = client.subscribe(first); const stopSecond = client.subscribe(second);
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0); expect(add).toHaveBeenCalledTimes(1);
    expect(mocks.addListener).toHaveBeenCalledTimes(1);
    await flush(); expect(first).toHaveBeenCalledExactlyOnceWith(current()); expect(second).toHaveBeenCalledExactlyOnceWith(current());
    await vi.advanceTimersByTimeAsync(60_000); expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledTimes(1); expect(second).toHaveBeenCalledTimes(1);
    stopFirst(); expect(mocks.listeners.size).toBe(1);
    broadcast(current(80_000, 61_000));
    expect(first).toHaveBeenCalledTimes(1); expect(second).toHaveBeenCalledTimes(2);
    stopSecond(); expect(vi.getTimerCount()).toBe(0); expect(mocks.listeners.size).toBe(0);
  });

  it('does not poll while hidden and checks once when the document becomes visible', async () => {
    page.visibilityState = 'hidden'; const receive = vi.fn(); client.subscribe(receive);
    client.refresh(); await vi.advanceTimersByTimeAsync(5_000);
    expect(mocks.sendMessage).not.toHaveBeenCalled(); expect(receive).not.toHaveBeenCalled();
    page.visibility('visible'); await flush(); expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    page.visibility('hidden'); await vi.advanceTimersByTimeAsync(5_000); expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('keeps a single IPC in flight across explicit refreshes and visibility changes', async () => {
    const pending = deferred<unknown>(); mocks.sendMessage.mockReturnValueOnce(pending.promise);
    client.subscribe(vi.fn()); client.subscribe(vi.fn()); client.refresh(); page.visibility('visible');
    await vi.advanceTimersByTimeAsync(5_000); expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    pending.resolve(response()); await flush(); client.refresh(); await flush();
    expect(mocks.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('removes both event listeners and pending ownership after the last unsubscribe', async () => {
    const remove = vi.spyOn(page, 'removeEventListener'); const receive = vi.fn(); const stop = client.subscribe(receive);
    await flush(); const calls = mocks.sendMessage.mock.calls.length; stop();
    expect(vi.getTimerCount()).toBe(0); expect(remove).toHaveBeenCalledWith('visibilitychange', client.refresh);
    expect(mocks.removeListener).toHaveBeenCalledTimes(1);
    page.visibility('visible'); client.refresh(); await vi.advanceTimersByTimeAsync(5_000);
    expect(mocks.sendMessage).toHaveBeenCalledTimes(calls);
  });

  it('does not notify a late result after disposal and cannot restart a disposed observer', async () => {
    const pending = deferred<unknown>(); mocks.sendMessage.mockReturnValueOnce(pending.promise);
    const receive = vi.fn(); client.subscribe(receive); client.dispose();
    pending.resolve(response(10_000)); await flush();
    expect(receive).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    client.subscribe(receive)(); page.visibility('visible'); client.refresh();
    await vi.advanceTimersByTimeAsync(5_000); expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('isolates a later subscription from an unsubscribed pending response and its finally callback', async () => {
    const old = deferred<unknown>(); const fresh = deferred<unknown>();
    mocks.sendMessage.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const first = vi.fn(); const second = vi.fn(); const stop = client.subscribe(first); stop(); client.subscribe(second);
    old.resolve(response(99_000)); await flush();
    expect(first).not.toHaveBeenCalled(); expect(second).not.toHaveBeenCalled();
    client.refresh(); await vi.advanceTimersByTimeAsync(2_000); expect(mocks.sendMessage).toHaveBeenCalledTimes(2);
    fresh.resolve(response(5_000)); await flush(); expect(second).toHaveBeenCalledExactlyOnceWith(current(5_000));
  });

  it('takes a trusted broadcast immediately and ignores an older in-flight status response', async () => {
    const pending = deferred<unknown>(); mocks.sendMessage.mockReturnValueOnce(pending.promise);
    const receive = vi.fn(); client.subscribe(receive);
    broadcast(current(65_000, 5_000), { id: 'test-extension', url: 'chrome-extension://test-extension/background.js' });
    expect(receive).toHaveBeenCalledExactlyOnceWith(current(65_000, 5_000));
    pending.resolve(response()); await flush();
    expect(receive).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
    const newcomer = vi.fn(); client.subscribe(newcomer);
    expect(newcomer).toHaveBeenCalledExactlyOnceWith(current(65_000, 5_000));
  });

  it('prevents a superseded fetch finally callback from releasing a later refresh', async () => {
    const old = deferred<unknown>(); const fresh = deferred<unknown>();
    mocks.sendMessage.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const receive = vi.fn(); client.subscribe(receive);
    broadcast(current(65_000)); client.refresh();
    old.resolve(response()); await flush(); client.refresh();
    expect(mocks.sendMessage).toHaveBeenCalledTimes(2);
    fresh.resolve(response(90_000, 2_000)); await flush();
    expect(receive).toHaveBeenLastCalledWith(current(90_000, 2_000));
  });

  it.each([
    { name: 'missing extension identity', sender: {} },
    { name: 'foreign extension', sender: { id: 'other-extension' } },
    { name: 'web content script', sender: { id: 'test-extension', url: 'https://example.com/', tab: { id: 7 } } },
    { name: 'web URL without tab metadata', sender: { id: 'test-extension', url: 'https://example.com/' } },
    { name: 'another extension URL', sender: { id: 'test-extension', url: 'chrome-extension://other-extension/background.js' } },
  ])('rejects a broadcast with $name', async ({ sender }) => {
    const pending = deferred<unknown>(); mocks.sendMessage.mockReturnValueOnce(pending.promise);
    const receive = vi.fn(); client.subscribe(receive); broadcast(current(99_000), sender);
    expect(receive).not.toHaveBeenCalled();
    pending.resolve(response()); await flush(); expect(receive).toHaveBeenCalledExactlyOnceWith(current());
  });

  it('ignores unrelated and malformed broadcasts and retains only public fields', async () => {
    const receive = vi.fn(); client.subscribe(receive); await flush();
    broadcast(current(99_000), undefined, 'settings-changed');
    broadcast(null); broadcast({ ...current(), cooldownUntil: Infinity });
    expect(receive).toHaveBeenCalledTimes(1);
    broadcast({ ...current(60_000, 2_000), unrelated: { retained: false } });
    expect(receive).toHaveBeenLastCalledWith(current(60_000, 2_000));
    page.visibility('hidden'); broadcast(current(90_000, 3_000));
    expect(receive).toHaveBeenLastCalledWith(current(90_000, 3_000));
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: 'unsuccessful', value: { ok: false, status: current() } },
    { name: 'missing', value: { ok: true } },
    { name: 'unknown engine', value: { ok: true, status: { ...current(), engine: 'untrusted' } } },
    { name: 'negative deadline', value: { ok: true, status: { ...current(), cooldownUntil: -1 } } },
    { name: 'fractional deadline', value: { ok: true, status: { ...current(), cooldownUntil: 1.5 } } },
    { name: 'infinite deadline', value: { ok: true, status: { ...current(), cooldownUntil: Infinity } } },
    { name: 'unsafe deadline', value: { ok: true, status: { ...current(), cooldownUntil: Number.MAX_SAFE_INTEGER + 1 } } },
    { name: 'negative checked time', value: { ok: true, status: { ...current(), checkedAt: -1 } } },
    { name: 'non-number checked time', value: { ok: true, status: { ...current(), checkedAt: '1000' } } },
    { name: 'NaN checked time', value: { ok: true, status: { ...current(), checkedAt: NaN } } },
  ])('rejects a $name status without notifying subscribers or poisoning later refreshes', async ({ value }) => {
    mocks.sendMessage.mockResolvedValueOnce(value); const receive = vi.fn(); client.subscribe(receive); await flush();
    expect(receive).not.toHaveBeenCalled(); client.refresh(); await flush();
    expect(receive).toHaveBeenCalledExactlyOnceWith(current());
  });

  it('keeps valid state across IPC rejection and only notifies meaningful status changes', async () => {
    const receive = vi.fn(); client.subscribe(receive); await flush();
    mocks.sendMessage.mockRejectedValueOnce(new Error('IPC unavailable')); client.refresh(); await flush();
    expect(receive).toHaveBeenCalledTimes(1);
    mocks.sendMessage.mockResolvedValueOnce(response(0, 9_000)); client.refresh(); await flush();
    expect(receive).toHaveBeenCalledTimes(1);
    const newcomer = vi.fn(); client.subscribe(newcomer);
    expect(newcomer).toHaveBeenCalledExactlyOnceWith(current(0, 9_000));
    mocks.sendMessage.mockResolvedValueOnce({ ok: true, status: { ...current(0, 10_000), engine: 'model' } }); client.refresh(); await flush();
    expect(receive).toHaveBeenCalledTimes(2);
    expect(receive).toHaveBeenLastCalledWith({ engine: 'model', cooldownUntil: 0, checkedAt: 10_000 });
  });
});
