import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ stored: undefined as Record<string, unknown> | undefined, access: vi.fn(), contains: vi.fn() }));
vi.mock('wxt/browser', () => ({ browser: {
  storage: { local: {
    setAccessLevel: state.access,
    get: vi.fn(async () => ({ 'settings:v1': state.stored })),
    set: vi.fn(async (value: Record<string, Record<string, unknown>>) => { state.stored = value['settings:v1']; }),
  } },
  permissions: { contains: state.contains },
} }));
import { connectionSettings, publicSettings, readSettings, saveSettings } from '../../src/platform/settings';
import { getProvider } from '../../src/shared/api-config';
import type { ProviderId } from '../../src/shared/contracts';

const existing = () => ({ schemaVersion: 1, enabled: true, includeContext: false, model: 'deepseek-flash', apiKey: 'unit-test-secret' });
const editable = () => ({ enabled: true, includeContext: false, model: 'deepseek-flash', apiKey: '' });

describe('sentence analysis setting compatibility', () => {
  beforeEach(() => { state.stored = existing(); state.access.mockResolvedValue(undefined); state.contains.mockResolvedValue(true); });

  it('defaults the new option on while preserving existing credentials and settings', async () => {
    expect(await readSettings()).toMatchObject({ ...existing(), schemaVersion: 2, provider: 'deepseek', sentenceAnalysisEnabled: true });
  });

  it('persists disabling the option and never exposes a key in public settings', async () => {
    await saveSettings({ ...editable(), sentenceAnalysisEnabled: false }, true);
    const stored = await readSettings();
    expect(stored.sentenceAnalysisEnabled).toBe(false);
    expect(stored.apiKey).toBe('unit-test-secret');
    const publicValue = await publicSettings();
    expect(publicValue).toMatchObject({ sentenceAnalysisEnabled: false, hasApiKey: true });
    expect(publicValue).not.toHaveProperty('apiKey');
    expect(JSON.stringify(publicValue)).not.toContain('unit-test-secret');
  });

  it('preserves the option when an older settings client omits it', async () => {
    state.stored = { ...existing(), sentenceAnalysisEnabled: false };
    await saveSettings(editable(), true);
    expect((await readSettings()).sentenceAnalysisEnabled).toBe(false);
  });

  it('rejects malformed option values without changing saved settings', async () => {
    await expect(saveSettings({ ...editable(), sentenceAnalysisEnabled: 'yes' }, true)).rejects.toThrow('设置');
    expect(state.stored).toEqual(existing());
  });
});

const connection = (provider: ProviderId, apiKey = '') => ({
  ...editable(), provider, apiKey, model: getProvider(provider).model || 'test-model',
  baseUrl: getProvider(provider).baseUrl, jsonMode: getProvider(provider).jsonMode,
});

describe('provider profile settings', () => {
  beforeEach(() => { state.stored = existing(); state.access.mockResolvedValue(undefined); state.contains.mockResolvedValue(true); });

  it('migrates the v1 snapshot in memory without a storage write', async () => {
    const before = structuredClone(state.stored);
    const settings = await readSettings();
    expect(settings).toMatchObject({ provider: 'deepseek', schemaVersion: 2, apiKey: 'unit-test-secret', connectionRevision: 0 });
    expect(settings.profiles.deepseek?.apiKey).toBe('unit-test-secret');
    expect(state.stored).toEqual(before);
  });

  it('switches providers without copying an unrelated credential and restores saved profiles', async () => {
    await saveSettings(connection('openai'), true);
    expect((await readSettings()).apiKey).toBe('');
    await saveSettings(connection('openai', 'openai-secret'), true);
    await saveSettings(connection('deepseek'), true);
    expect((await readSettings()).apiKey).toBe('unit-test-secret');
    await saveSettings(connection('openai'), true);
    const settings = await readSettings();
    expect(settings.apiKey).toBe('openai-secret');
    expect(settings.profiles.deepseek?.apiKey).toBe('unit-test-secret');
  });

  it('serializes simultaneous saves without losing either provider profile', async () => {
    await Promise.all([
      saveSettings(connection('openai', 'openai-secret'), true),
      saveSettings(connection('gemini', 'gemini-secret'), true),
    ]);
    const settings = await readSettings();
    expect(settings.provider).toBe('gemini');
    expect(settings.profiles.openai?.apiKey).toBe('openai-secret');
    expect(settings.profiles.gemini?.apiKey).toBe('gemini-secret');
    expect(settings.profiles.deepseek?.apiKey).toBe('unit-test-secret');
    expect(settings.connectionRevision).toBe(2);
  });

  it('continues the save queue after an invalid save fails', async () => {
    const failed = saveSettings({ ...connection('openai'), jsonMode: 'yes' }, true);
    const succeeded = saveSettings(connection('openai', 'openai-secret'), true);
    await expect(failed).rejects.toThrow('设置');
    await succeeded;
    expect((await readSettings()).apiKey).toBe('openai-secret');
  });

  it('does not retain a credential when its service address changes', async () => {
    await saveSettings({ ...connection('deepseek'), baseUrl: 'https://gateway.example/v1' }, true);
    const settings = await readSettings();
    expect(settings.baseUrl).toBe('https://gateway.example/v1');
    expect(settings.apiKey).toBe('');
    expect(settings.profiles.deepseek?.apiKey).toBe('');
  });

  it('retains credentials for equivalent normalized addresses', async () => {
    await saveSettings({ ...connection('deepseek'), baseUrl: 'https://api.deepseek.com/chat/completions/' }, true);
    expect((await readSettings()).apiKey).toBe('unit-test-secret');
  });

  it('deletes only the selected profile credential', async () => {
    await saveSettings(connection('openai', 'openai-secret'), true);
    await saveSettings(connection('openai'), false);
    const settings = await readSettings();
    expect(settings.apiKey).toBe('');
    expect(settings.profiles.deepseek?.apiKey).toBe('unit-test-secret');
  });

  it('lets older settings clients retain the current provider, address and JSON option', async () => {
    await saveSettings({ ...connection('custom', 'gateway-secret'), model: 'vendor/model:latest', baseUrl: 'https://gateway.example/v1', jsonMode: true }, true);
    await saveSettings({ ...editable(), model: 'vendor/model:latest', sentenceAnalysisEnabled: false }, true);
    expect(await readSettings()).toMatchObject({ provider: 'custom', baseUrl: 'https://gateway.example/v1', jsonMode: true, apiKey: 'gateway-secret', sentenceAnalysisEnabled: false });
  });

  it('only advances the connection revision when API connection values change', async () => {
    await saveSettings({ ...editable(), sentenceAnalysisEnabled: false }, true);
    expect((await readSettings()).connectionRevision).toBe(0);
    await saveSettings({ ...connection('deepseek'), model: 'another-model' }, true);
    expect((await readSettings()).connectionRevision).toBe(1);
    await saveSettings({ ...connection('deepseek'), model: 'another-model', includeContext: true }, true);
    expect((await readSettings()).connectionRevision).toBe(1);
    await saveSettings({ ...connection('deepseek'), model: 'another-model' }, false);
    expect((await readSettings()).connectionRevision).toBe(2);
  });

  it('keeps all credentials out of both public projections and hides connection addresses from pages', async () => {
    await saveSettings({ ...connection('custom', 'custom-secret'), model: 'private-model', baseUrl: 'https://private.example/v1' }, true);
    const publicValue = await publicSettings();
    const trustedValue = await connectionSettings();
    expect(publicValue).not.toHaveProperty('baseUrl');
    expect(publicValue).not.toHaveProperty('profiles');
    expect(trustedValue.profiles.deepseek?.hasApiKey).toBe(true);
    expect(trustedValue.profiles.custom?.baseUrl).toBe('https://private.example/v1');
    for (const result of [publicValue, trustedValue]) {
      expect(JSON.stringify(result)).not.toContain('unit-test-secret');
      expect(JSON.stringify(result)).not.toContain('custom-secret');
      expect(result).not.toHaveProperty('apiKey');
    }
  });

  it('checks API origin access separately from webpage access', async () => {
    state.contains.mockImplementation(async ({ origins }: { origins: string[] }) => origins.length === 2);
    expect(await publicSettings()).toMatchObject({ webAccess: true, apiAccess: false, requiresApiKey: true });
    await saveSettings({ ...connection('ollama'), model: 'local-model' }, true);
    expect(await publicSettings()).toMatchObject({ hasApiKey: false, requiresApiKey: false, apiAccess: false });
  });

  it.each([
    { provider: 'unknown' },
    { provider: null },
    { model: 'model\n' },
    { apiKey: 'secret\r\nInjected: header' },
    { apiKey: 'secret\u0000' },
    { baseUrl: 'https://user:password@gateway.example/v1' },
    { baseUrl: 'https://gateway.example/v1?key=secret' },
    { baseUrl: 'http://public.example/v1' },
    { baseUrl: null },
    { jsonMode: 'yes' },
  ])('rejects invalid settings without altering stored credentials: %j', async (invalid) => {
    const before = structuredClone(state.stored);
    await expect(saveSettings({ ...connection('deepseek'), ...invalid }, true)).rejects.toThrow();
    expect(state.stored).toEqual(before);
  });

  it('drops malformed stored credentials instead of moving them to a fallback host', async () => {
    state.stored = { ...existing(), baseUrl: 'https://gateway.example/?api_key=secret' };
    expect((await readSettings()).apiKey).toBe('');
    state.stored = { ...existing(), provider: 'unknown' };
    expect((await readSettings()).apiKey).toBe('');
  });

  it('ignores inherited and unrecognized profile keys', async () => {
    state.stored = { ...existing(), profiles: Object.assign(Object.create({ openai: { ...connection('openai', 'prototype-secret') } }), {
      unrecognized: { ...connection('openai', 'unknown-secret') },
    }) };
    const settings = await readSettings();
    expect(settings.profiles.openai).toBeUndefined();
    expect(Object.keys(settings.profiles)).toEqual(['deepseek']);
    expect(JSON.stringify(await connectionSettings())).not.toContain('prototype-secret');
  });
});
