import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ values: {} as Record<string, unknown>, access: vi.fn(), get: vi.fn(), set: vi.fn() }));
vi.mock('wxt/browser', () => ({ browser: { storage: { session: {
  setAccessLevel: state.access, get: state.get, set: state.set,
} } } }));
import { createDeepLWebCooldownState, createDeepLWebPreparationState } from '../../src/platform/deepl-web-state';

describe('DeepL browser-session cooldown state', () => {
  beforeEach(() => {
    vi.resetAllMocks(); state.values = {};
    state.access.mockResolvedValue(undefined);
    state.get.mockImplementation(async () => ({ ...state.values }));
    state.set.mockImplementation(async (value: Record<string, unknown>) => { Object.assign(state.values, value); });
  });

  it('defaults to zero and restricts session storage to trusted contexts before reading', async () => {
    const cooldown = createDeepLWebCooldownState();
    expect(await cooldown.loadCooldownUntil()).toBe(0);
    expect(state.access).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
    expect(state.access.mock.invocationCallOrder[0]).toBeLessThan(state.get.mock.invocationCallOrder[0]!);
  });

  it('keeps the longest deadline across saves and a new service-worker owner', async () => {
    const first = createDeepLWebCooldownState();
    await Promise.all([first.persistCooldownUntil(9000), first.persistCooldownUntil(8000), first.persistCooldownUntil(10000)]);
    const restarted = createDeepLWebCooldownState();
    expect(await restarted.loadCooldownUntil()).toBe(10000);
    await restarted.persistCooldownUntil(5000);
    expect(await restarted.loadCooldownUntil()).toBe(10000);
    expect(Object.values(state.values)).toEqual([10000]);
  });

  it('ignores malformed saved values and rejects malformed new timestamps', async () => {
    state.values['deepl-web:cooldown-until:v1'] = 'invalid';
    const cooldown = createDeepLWebCooldownState();
    expect(await cooldown.loadCooldownUntil()).toBe(0);
    await expect(cooldown.persistCooldownUntil(Number.NaN)).rejects.toThrow();
    await expect(cooldown.persistCooldownUntil(-1)).rejects.toThrow();
    expect(state.set).not.toHaveBeenCalled();
  });

  it('propagates inaccessible storage instead of pretending the cooldown is empty', async () => {
    state.access.mockRejectedValue(new Error('storage unavailable'));
    await expect(createDeepLWebCooldownState().loadCooldownUntil()).rejects.toThrow('storage unavailable');
    expect(state.get).not.toHaveBeenCalled();
  });
});

describe('DeepL browser-session preparation admission', () => {
  const key = 'deepl-web:prepare-at:v1';
  beforeEach(() => {
    vi.resetAllMocks(); state.values = {};
    state.access.mockResolvedValue(undefined);
    state.get.mockImplementation(async () => ({ ...state.values }));
    state.set.mockImplementation(async (value: Record<string, unknown>) => { Object.assign(state.values, value); });
  });

  it('restricts storage and persists only the attempt timestamp before admitting preparation', async () => {
    state.values['deepl-web:cooldown-until:v1'] = 999_999;
    state.values['private-api-key'] = 'unrelated';
    expect(await createDeepLWebPreparationState(() => 10_000).reservePreparation()).toBe(true);
    expect(state.access).toHaveBeenCalledExactlyOnceWith({ accessLevel: 'TRUSTED_CONTEXTS' });
    expect(state.get).toHaveBeenCalledExactlyOnceWith(key);
    expect(state.set).toHaveBeenCalledExactlyOnceWith({ [key]: 10_000 });
    expect(state.access.mock.invocationCallOrder[0]).toBeLessThan(state.get.mock.invocationCallOrder[0]!);
    expect(state.values['deepl-web:cooldown-until:v1']).toBe(999_999);
    expect(state.values['private-api-key']).toBe('unrelated');
  });

  it('serializes simultaneous reservations and admits again only at the full 30-second boundary', async () => {
    let now = 0;
    const preparation = createDeepLWebPreparationState(() => now);
    expect(await Promise.all(Array.from({ length: 5 }, () => preparation.reservePreparation())))
      .toEqual([true, false, false, false, false]);
    now = 29_999; expect(await preparation.reservePreparation()).toBe(false);
    now = 30_000; expect(await preparation.reservePreparation()).toBe(true);
    expect(state.set).toHaveBeenCalledTimes(2);
    expect(state.values[key]).toBe(30_000);
    expect(state.access).toHaveBeenCalledOnce();
  });

  it('preserves the reservation across a new service-worker owner and clock rollback', async () => {
    expect(await createDeepLWebPreparationState(() => 100_000).reservePreparation()).toBe(true);
    let now = 90_000;
    const restarted = createDeepLWebPreparationState(() => now);
    expect(await restarted.reservePreparation()).toBe(false);
    now = 129_999; expect(await restarted.reservePreparation()).toBe(false);
    now = 130_000; expect(await restarted.reservePreparation()).toBe(true);
    expect(state.values[key]).toBe(130_000);
  });

  it.each(['private', null, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'fails closed for malformed persisted admission state (%s)', async value => {
      state.values[key] = value;
      await expect(createDeepLWebPreparationState(() => 100_000).reservePreparation()).rejects.toThrow('Invalid preparation timestamp');
      expect(state.set).not.toHaveBeenCalled();
    },
  );

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('does not save an invalid clock value (%s)', async now => {
    await expect(createDeepLWebPreparationState(() => now).reservePreparation()).rejects.toThrow('Invalid preparation timestamp');
    expect(state.set).not.toHaveBeenCalled();
  });

  it('fails closed if access, read or save is unavailable and lets a later save recover', async () => {
    state.access.mockRejectedValueOnce(new Error('access unavailable'));
    await expect(createDeepLWebPreparationState().reservePreparation()).rejects.toThrow('access unavailable');
    expect(state.get).not.toHaveBeenCalled();
    state.get.mockRejectedValueOnce(new Error('read unavailable'));
    const preparation = createDeepLWebPreparationState(() => 50_000);
    await expect(preparation.reservePreparation()).rejects.toThrow('read unavailable');
    expect(state.set).not.toHaveBeenCalled();
    state.set.mockRejectedValueOnce(new Error('save unavailable'));
    await expect(preparation.reservePreparation()).rejects.toThrow('save unavailable');
    expect(state.values).not.toHaveProperty(key);
    expect(await preparation.reservePreparation()).toBe(true);
    expect(await createDeepLWebPreparationState(() => 50_001).reservePreparation()).toBe(false);
  });
});
