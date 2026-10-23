import { describe, expect, it, vi } from 'vitest';
import type { ConnectionSettings } from '../../src/shared/contracts';
import { enableFreeTranslation, FreeSetupError, readFreeTranslationStatus, remainingCooldownSeconds, testFreeTranslation } from '../../src/ui/free-setup/client';

const settings = { translationEngine: 'deepl-web', profiles: {}, enabled: true, webAccess: true } as ConnectionSettings;

describe('free setup click actions', () => {
  it('requests permissions synchronously before messaging the background and never sends form fields or a Key', async () => {
    let grant!: (value: boolean) => void;
    const permissions = new Promise<boolean>(resolve => { grant = resolve; });
    const client = { requestPermissions: vi.fn(() => permissions), sendMessage: vi.fn(async () => ({ ok: true, settings })) };
    const action = enableFreeTranslation(client);
    expect(client.requestPermissions).toHaveBeenCalledOnce();
    expect(client.sendMessage).not.toHaveBeenCalled();
    grant(true);
    expect(await action).toBe(settings);
    expect(client.sendMessage).toHaveBeenCalledExactlyOnceWith({ type: 'enable-free-translation' });
  });

  it('keeps settings untouched when the user rejects permission', async () => {
    const client = { requestPermissions: vi.fn(async () => false), sendMessage: vi.fn() };
    await expect(enableFreeTranslation(client)).rejects.toThrow('设置没有更改');
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it('only requests the background-owned public sample and preserves retry timing on failure', async () => {
    const error = { code: 'RATE_LIMIT', message: '服务正在冷却', retryable: true, retryAt: 123_456 };
    const client = { requestPermissions: vi.fn(async () => true), sendMessage: vi.fn(async () => ({ ok: false, error })) };
    let failure: unknown;
    try { await testFreeTranslation(client); } catch (reason) { failure = reason; }
    expect(failure).toBeInstanceOf(FreeSetupError);
    expect((failure as FreeSetupError).translationError).toEqual(error);
    expect(client.requestPermissions).not.toHaveBeenCalled();
    expect(client.sendMessage).toHaveBeenCalledExactlyOnceWith({ type: 'test-free-translation' });
  });

  it('validates complete test responses without interpreting returned HTML', async () => {
    const client = { requestPermissions: vi.fn(async () => true), sendMessage: vi.fn(async () => ({ ok: true, translation: '<b>公开示例</b>', elapsedMs: 850 })) };
    expect(await testFreeTranslation(client)).toEqual({ translation: '<b>公开示例</b>', elapsedMs: 850 });
    client.sendMessage.mockResolvedValueOnce({ ok: true, translation: '', elapsedMs: 850 });
    await expect(testFreeTranslation(client)).rejects.toThrow('完整译文');
  });

  it('reads cooldown separately and rounds up its remaining seconds without sending a test', async () => {
    const status = { engine: 'deepl-web', cooldownUntil: 15_001, checkedAt: 10_000 };
    const client = { requestPermissions: vi.fn(async () => true), sendMessage: vi.fn(async () => ({ ok: true, status })) };
    expect(await readFreeTranslationStatus(client)).toEqual(status);
    expect(client.sendMessage).toHaveBeenCalledExactlyOnceWith({ type: 'get-translation-status' });
    expect(remainingCooldownSeconds(status.cooldownUntil, 10_000)).toBe(6);
    expect(remainingCooldownSeconds(status.cooldownUntil, 16_000)).toBe(0);
    expect(remainingCooldownSeconds(NaN, 10_000)).toBe(0);
  });
});
