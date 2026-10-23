import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  settings: vi.fn(), query: vi.fn(), runtimeSend: vi.fn(), tabSend: vi.fn(),
  contains: vi.fn(), registered: vi.fn(), register: vi.fn(), update: vi.fn(), unregister: vi.fn(),
}));
vi.mock('wxt/browser', () => ({ browser: {
  runtime: { sendMessage: state.runtimeSend },
  tabs: { query: state.query, sendMessage: state.tabSend },
  permissions: { contains: state.contains },
  scripting: { getRegisteredContentScripts: state.registered, registerContentScripts: state.register,
    updateContentScripts: state.update, unregisterContentScripts: state.unregister },
} }));
vi.mock('../../src/platform/settings', () => ({
  publicSettings: state.settings, WEB_ORIGINS: ['http://*/*', 'https://*/*'],
}));
import { broadcastPublicSettings, broadcastTranslationStatus, synchronizeContentRegistration } from '../../src/platform/web-access';

const settings = { enabled: true, webAccess: true, hasApiKey: false, requiresApiKey: false,
  translationEngine: 'deepl-web', model: 'deepseek-flash', includeContext: false, sentenceAnalysisEnabled: false };
const message = { type: 'settings-changed', settings };

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  state.settings.mockResolvedValue(settings);
  state.query.mockResolvedValue([{ id: 1 }, { id: 2 }, {}]);
  state.runtimeSend.mockResolvedValue(undefined);
  state.tabSend.mockResolvedValue(undefined);
  state.contains.mockResolvedValue(false); state.registered.mockResolvedValue([]);
  state.register.mockResolvedValue(undefined); state.update.mockResolvedValue(undefined); state.unregister.mockResolvedValue(undefined);
});

describe('optional metadata preparation registration', () => {
  it('registers only the top-frame document_start script when every capability is enabled', async () => {
    state.settings.mockResolvedValue({ ...settings, apiAccess: true });
    state.contains.mockResolvedValue(true);
    await synchronizeContentRegistration();
    expect(state.register.mock.calls.map(([entries]) => entries[0])).toEqual([
      expect.objectContaining({ id: 'near-translate-network-prepare', js: ['content-scripts/network-prepare.js'],
        runAt: 'document_start', allFrames: false }),
      expect.objectContaining({ id: 'near-translate-selection', runAt: 'document_idle' }),
    ]);
  });

  it.each([{ enabled: false }, { webAccess: false }, { apiAccess: false }, { translationEngine: 'model' }])(
    'removes preparation when a required capability changes: %j', async change => {
      state.settings.mockResolvedValue({ ...settings, apiAccess: true, ...change });
      state.contains.mockResolvedValue(true);
      state.registered.mockImplementation(async ({ ids }) => ids[0] === 'near-translate-network-prepare' ? [{ id: ids[0] }] : []);
      await synchronizeContentRegistration();
      expect(state.unregister).toHaveBeenCalledWith({ ids: ['near-translate-network-prepare'] });
      expect(state.register.mock.calls.flatMap(([entries]) => entries).some(entry => entry.id === 'near-translate-network-prepare')).toBe(false);
    },
  );

  it('keeps ordinary UI registration when the optional permission is absent or fails', async () => {
    state.settings.mockResolvedValue({ ...settings, apiAccess: true });
    state.contains.mockRejectedValue(new Error('Optional capability unavailable'));
    await synchronizeContentRegistration();
    expect(state.register).toHaveBeenCalledExactlyOnceWith([expect.objectContaining({ id: 'near-translate-selection' })]);
  });
});
afterEach(() => { vi.useRealTimers(); });

describe('best-effort settings broadcasts', () => {
  it('returns at the shared deadline when one tab never settles while notifying every receiver in parallel', async () => {
    state.tabSend.mockImplementation((id: number) => id === 2 ? new Promise(() => {}) : Promise.resolve());
    let completed = false;
    const pending = broadcastPublicSettings().then(() => { completed = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(state.runtimeSend).toHaveBeenCalledWith(message);
    expect(state.tabSend.mock.calls).toEqual([[1, message], [2, message]]);
    expect(vi.getTimerCount()).toBe(1); // Successful receivers already cleaned their timers.
    await vi.advanceTimersByTimeAsync(1499);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(completed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    // A later save/broadcast can complete rather than queuing forever behind this one.
    state.tabSend.mockResolvedValue(undefined);
    await broadcastPublicSettings();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not wait for the deadline on the normal path and leaves no timers', async () => {
    const before = Date.now();
    await broadcastPublicSettings();
    expect(Date.now()).toBe(before);
    expect(state.tabSend).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('handles promise rejections without delaying successful receivers and clears every timer', async () => {
    state.runtimeSend.mockRejectedValue(new Error('No receiving extension page'));
    state.tabSend.mockImplementation((id: number) => id === 1
      ? Promise.reject(new Error('Outdated content script')) : Promise.resolve());
    const before = Date.now();
    await expect(broadcastPublicSettings()).resolves.toBeUndefined();
    expect(Date.now()).toBe(before);
    expect(state.tabSend).toHaveBeenCalledWith(2, message);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('handles synchronous runtime/tab throws without skipping the other notifications or retaining timers', async () => {
    state.runtimeSend.mockImplementation(() => { throw new Error('Invalid runtime context'); });
    state.tabSend.mockImplementation((id: number) => {
      if (id === 1) throw new Error('Invalid tab');
      return Promise.resolve();
    });
    const before = Date.now();
    await expect(broadcastPublicSettings()).resolves.toBeUndefined();
    expect(Date.now()).toBe(before);
    expect(state.tabSend).toHaveBeenCalledWith(2, message);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('also bounds a nonresponding extension page and safely consumes a rejection after timeout', async () => {
    let reject!: (error: Error) => void;
    state.runtimeSend.mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
    const pending = broadcastPublicSettings();
    await vi.advanceTimersByTimeAsync(1500);
    await pending;
    expect(vi.getTimerCount()).toBe(0);
    reject(new Error('Receiver eventually closed'));
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('event-driven translation status broadcasts', () => {
  const status = { engine: 'deepl-web' as const, cooldownUntil: 65_000, checkedAt: 5_000 };
  const notification = { type: 'translation-status-changed', status };

  it('sends only public status fields to every tab and extension page without reading settings or retaining a timer', async () => {
    await broadcastTranslationStatus({ ...status, unexpected: { text: 'must not forward' } } as typeof status);
    expect(state.runtimeSend).toHaveBeenCalledExactlyOnceWith(notification);
    expect(state.tabSend.mock.calls).toEqual([[1, notification], [2, notification]]);
    expect(state.query).toHaveBeenCalledExactlyOnceWith({});
    expect(state.settings).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.runtimeSend).toHaveBeenCalledTimes(1); expect(state.tabSend).toHaveBeenCalledTimes(2);
  });

  it.each(['rejection', 'synchronous throw'] as const)('isolates a receiver %s and continues notifying other tabs', async failure => {
    const fail = () => { if (failure === 'synchronous throw') throw new Error('Receiver unavailable'); return Promise.reject(new Error('Receiver closed')); };
    state.runtimeSend.mockImplementation(fail);
    state.tabSend.mockImplementation((id: number) => id === 1 ? fail() : Promise.resolve());
    await expect(broadcastTranslationStatus(status)).resolves.toBeUndefined();
    expect(state.tabSend).toHaveBeenCalledWith(2, notification); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['rejection', 'synchronous throw'] as const)('still notifies extension pages if tab enumeration fails with a %s', async failure => {
    state.query.mockImplementation(() => { if (failure === 'synchronous throw') throw new Error('Query failed'); return Promise.reject(new Error('Query failed')); });
    await expect(broadcastTranslationStatus(status)).resolves.toBeUndefined();
    expect(state.runtimeSend).toHaveBeenCalledExactlyOnceWith(notification);
    expect(state.tabSend).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds frozen receivers and consumes their late failures without scheduling future polls', async () => {
    let reject!: (reason: Error) => void;
    state.tabSend.mockImplementation((id: number) => id === 2 ? new Promise((_, fail) => { reject = fail; }) : Promise.resolve());
    let finished = false; const pending = broadcastTranslationStatus(status).then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(1_499); expect(finished).toBe(false); expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1); await pending; expect(finished).toBe(true); expect(vi.getTimerCount()).toBe(0);
    reject(new Error('The frozen receiver eventually closed')); await vi.advanceTimersByTimeAsync(60_000);
    expect(state.runtimeSend).toHaveBeenCalledTimes(1); expect(state.tabSend).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });
});
