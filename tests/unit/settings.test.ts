import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EncryptedKeyVault } from '../../src/shared/key-vault';
import { KEY_VAULT_STORAGE_KEY } from '../../src/shared/key-vault';
import { createEncryptedKeyVault } from '../../src/platform/key-vault';

const fixture = vi.hoisted(() => {
  const data = new Map<string, unknown>();
  return { data, browser: {
    storage: { local: {
      get: vi.fn(async (query: string | string[]) => Object.fromEntries((Array.isArray(query) ? query : [query])
        .filter(key => data.has(key)).map(key => [key, structuredClone(data.get(key))]))),
      set: vi.fn(async (values: Record<string, unknown>) => { for (const [key, value] of Object.entries(values)) data.set(key, structuredClone(value)); }),
      remove: vi.fn(async (key: string) => { data.delete(key); }),
      setAccessLevel: vi.fn(async () => {}),
    }, session: { setAccessLevel: vi.fn(async () => {}) } },
    permissions: { contains: vi.fn(async (query: { permissions?: string[] }) => !query.permissions?.length) },
  } };
});
vi.mock('wxt/browser', () => ({ browser: fixture.browser }));
const LEGACY = 'settings:v1';
const KEY = 'fixture-only-saved-api-key';
const REPLACEMENT = 'fixture-only-replacement-api-key';
const PASS = 'fixture-only previous vault passphrase';
const legacyConfig = {
  schemaVersion: 3, translationEngine: 'model', enabled: true, includeContext: false, sentenceAnalysisEnabled: true,
  provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', jsonMode: true, connectionRevision: 3,
  profiles: { deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', jsonMode: true },
    openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-fixture', jsonMode: true } },
};
const modelInput = { translationEngine: 'model', enabled: true, includeContext: false, sentenceAnalysisEnabled: true,
  provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: KEY, jsonMode: true };
let vault: EncryptedKeyVault;
let rotatedVault: EncryptedKeyVault;
let store: typeof import('../../src/platform/connection-settings');
beforeAll(async () => {
  const credentials = { deepseek: { baseUrl: 'https://api.deepseek.com', apiKey: 'fixture-only-encrypted-old-key' },
    openai: { baseUrl: 'https://api.openai.com/v1', apiKey: 'fixture-only-encrypted-openai-key' } };
  vault = (await createEncryptedKeyVault(PASS, credentials)).vault;
  rotatedVault = (await createEncryptedKeyVault(PASS, credentials)).vault;
});
beforeEach(async () => {
  fixture.data.clear();
  vi.clearAllMocks();
  vi.resetModules();
  store = await import('../../src/platform/connection-settings');
});
function legacy() {
  fixture.data.set(LEGACY, structuredClone(legacyConfig));
  fixture.data.set(KEY_VAULT_STORAGE_KEY, structuredClone(vault));
}
async function settle() { for (let index = 0; index < 30; index++) await Promise.resolve(); }

describe('private connection settings without unlock sessions', () => {
  it('starts with free translation and restricts extension storage to trusted contexts', async () => {
    expect(await store.publicSettings()).toMatchObject({ enabled: true, translationEngine: 'deepl-web', hasApiKey: false,
      keyVaultLocked: false, apiKeyMigrationRequired: false });
    expect(fixture.browser.storage.local.setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
    expect(fixture.browser.storage.session.setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
    expect(fixture.browser.storage.local.set).not.toHaveBeenCalled();
  });

  it('saves once without a passphrase and a fresh document can use the Key immediately', async () => {
    await store.saveSettings(modelInput, true);
    expect(fixture.browser.storage.local.set).toHaveBeenCalledTimes(1);
    expect(Object.keys(fixture.browser.storage.local.set.mock.calls[0]![0])).toEqual([store.CONNECTION_SETTINGS_KEY]);
    expect(fixture.data.has(KEY_VAULT_STORAGE_KEY)).toBe(false);
    expect(await store.readSettings()).toMatchObject({ apiKey: KEY, keyVaultLocked: false });
    vi.resetModules();
    const fresh = await import('../../src/platform/connection-settings');
    expect(await fresh.readSettings()).toMatchObject({ apiKey: KEY, keyVaultLocked: false });
    expect(await fresh.publicSettings()).toMatchObject({ hasApiKey: true, apiKeyMigrationRequired: false });
  });

  it('returns capability markers instead of secrets or old encrypted data', async () => {
    legacy();
    await store.saveSettings(modelInput, true);
    const snapshots = [await store.publicSettings(), await store.connectionSettings()];
    expect(JSON.stringify(snapshots)).not.toContain(KEY);
    expect(JSON.stringify(snapshots)).not.toContain(vault.ciphertext);
    expect(JSON.stringify(snapshots)).not.toContain('apiKey"');
    expect(snapshots[1]).toMatchObject({ profiles: { deepseek: { hasApiKey: true } }, legacyKeyProviders: ['openai'] });
  });

  it('keeps provider keys separate and does not send a saved Key to a changed endpoint', async () => {
    await store.saveSettings(modelInput, true);
    await store.saveSettings({ ...modelInput, provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-fixture', apiKey: 'fixture-only-openai-key' }, true);
    await store.saveSettings({ ...modelInput, apiKey: '' }, true);
    expect((await store.readSettings()).apiKey).toBe(KEY);
    await store.saveSettings({ ...modelInput, baseUrl: 'https://other.example/v1', apiKey: '' }, true);
    expect(await store.readSettings()).toMatchObject({ baseUrl: 'https://other.example/v1', apiKey: '' });
    expect((await store.connectionSettings()).profiles.openai?.hasApiKey).toBe(true);
  });

  it('enabling free translation preserves stored model profiles and keys', async () => {
    await store.saveSettings(modelInput, true);
    await store.enableFreeTranslation();
    expect(await store.publicSettings()).toMatchObject({ translationEngine: 'deepl-web', requiresApiKey: false });
    await store.saveSettings({ ...modelInput, apiKey: '' }, true);
    expect((await store.readSettings()).apiKey).toBe(KEY);
  });

  it('recognises old encrypted keys without pretending they are unlocked or usable', async () => {
    legacy();
    expect(await store.connectionSettings()).toMatchObject({ model: 'deepseek-chat', keyVaultLocked: false,
      hasApiKey: false, apiKeyMigrationRequired: true, legacyKeyMigrationAvailable: true,
      legacyKeyProviders: ['deepseek', 'openai'], profiles: { deepseek: { hasApiKey: false } } });
    expect(await store.readSettings()).toMatchObject({ apiKey: '', apiKeyMigrationRequired: true });
    expect(fixture.browser.storage.local.set).not.toHaveBeenCalled();
  });

  it('imports with the old passphrase once and never changes the old recovery records', async () => {
    legacy();
    const original = structuredClone([...fixture.data]);
    const snapshot = await store.importLegacyKeys(PASS);
    expect(snapshot).toMatchObject({ hasApiKey: true, keyVaultLocked: false, apiKeyMigrationRequired: false,
      legacyKeyMigrationAvailable: false, legacyKeyProviders: [] });
    expect((await store.readSettings()).apiKey).toBe('fixture-only-encrypted-old-key');
    for (const [key, value] of original) expect(fixture.data.get(key)).toEqual(value);
    expect(fixture.browser.storage.local.remove).not.toHaveBeenCalled();
    expect(JSON.stringify(fixture.data.get(store.CONNECTION_SETTINGS_KEY))).not.toContain(PASS);
  });

  it('rejects a wrong old passphrase without writing or removing any saved data', async () => {
    legacy();
    const original = structuredClone([...fixture.data]);
    await expect(store.importLegacyKeys('fixture-only deliberately wrong passphrase')).rejects.toThrow(/口令/);
    expect([...fixture.data]).toEqual(original);
    expect(fixture.browser.storage.local.set).not.toHaveBeenCalled();
    expect(fixture.browser.storage.local.remove).not.toHaveBeenCalled();
  });

  it('old import cannot overwrite a newly entered key or resurrect an explicitly deleted key', async () => {
    legacy();
    await store.saveSettings({ ...modelInput, apiKey: REPLACEMENT }, true);
    await store.importLegacyKeys(PASS);
    expect((await store.readSettings()).apiKey).toBe(REPLACEMENT);
    await store.saveSettings({ ...modelInput, apiKey: '' }, false);
    await store.importLegacyKeys(PASS);
    expect((await store.readSettings()).apiKey).toBe('');
    expect((await store.connectionSettings()).legacyKeyProviders).not.toContain('deepseek');
  });

  it('a concurrent page key replacement during old-key derivation remains authoritative', async () => {
    legacy();
    const importing = store.importLegacyKeys(PASS);
    await settle();
    vi.resetModules();
    const otherPage = await import('../../src/platform/connection-settings');
    await otherPage.saveSettings({ ...modelInput, apiKey: REPLACEMENT }, true);
    await importing;
    expect((await otherPage.readSettings()).apiKey).toBe(REPLACEMENT);
  });

  it('a concurrently changed old vault invalidates an import instead of overwriting it', async () => {
    legacy();
    const importing = store.importLegacyKeys(PASS);
    await settle();
    fixture.data.set(KEY_VAULT_STORAGE_KEY, structuredClone(rotatedVault));
    await expect(importing).rejects.toThrow(/另一页面更改/);
    expect(fixture.data.has(store.CONNECTION_SETTINGS_KEY)).toBe(false);
    expect(fixture.data.get(KEY_VAULT_STORAGE_KEY)).toEqual(rotatedVault);
  });

  it('imports plaintext legacy records without inventing a new password', async () => {
    fixture.data.set(LEGACY, { ...legacyConfig, apiKey: KEY });
    await store.importLegacyKeys('');
    expect((await store.readSettings()).apiKey).toBe(KEY);
    expect(fixture.data.get(LEGACY)).toMatchObject({ apiKey: KEY });
  });

  it('uses validated plaintext legacy keys immediately without writes and copies them on save', async () => {
    fixture.data.set(LEGACY, { ...legacyConfig, apiKey: KEY });
    expect(await store.readSettings()).toMatchObject({ apiKey: KEY, apiKeyMigrationRequired: false });
    expect(await store.connectionSettings()).toMatchObject({ hasApiKey: true, legacyKeyMigrationAvailable: false });
    expect(fixture.browser.storage.local.set).not.toHaveBeenCalled();
    await store.saveSettings({ ...modelInput, apiKey: '' }, true);
    expect(fixture.data.get(store.CONNECTION_SETTINGS_KEY)).toMatchObject({ credentials: { deepseek: { apiKey: KEY } } });
    await store.saveSettings({ ...modelInput, apiKey: '' }, false);
    expect((await store.readSettings()).apiKey).toBe('');
    expect(fixture.data.get(LEGACY)).toMatchObject({ apiKey: KEY });
  });

  it('keeps malformed or conflicting plaintext recoverable while allowing a replacement Key', async () => {
    fixture.data.set(LEGACY, { ...legacyConfig, apiKey: KEY, profiles: { deepseek: { ...legacyConfig.profiles.deepseek, apiKey: REPLACEMENT } } });
    expect((await store.readSettings()).apiKey).toBe('');
    const original = structuredClone(fixture.data.get(LEGACY));
    await store.saveSettings({ ...modelInput, apiKey: 'fixture-only-new-key' }, true);
    expect((await store.readSettings()).apiKey).toBe('fixture-only-new-key');
    expect(fixture.data.get(LEGACY)).toEqual(original);
  });

  it('requires import for an old authenticated optional local provider instead of dropping its credential', async () => {
    const optionalVault = (await createEncryptedKeyVault(PASS, {
      ollama: { baseUrl: 'http://localhost:11434/v1', apiKey: KEY },
    })).vault;
    fixture.data.set(LEGACY, { ...legacyConfig, provider: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'local-fixture',
      profiles: { ollama: { baseUrl: 'http://localhost:11434/v1', model: 'local-fixture', jsonMode: true } } });
    fixture.data.set(KEY_VAULT_STORAGE_KEY, optionalVault);
    expect(await store.readSettings()).toMatchObject({ provider: 'ollama', apiKey: '', apiKeyMigrationRequired: true });
    expect(await store.publicSettings()).toMatchObject({ requiresApiKey: false, apiKeyMigrationRequired: true });
  });

  it('rejects old-key import when the current provider endpoint was changed', async () => {
    legacy();
    await store.saveSettings({ ...modelInput, provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-fixture', apiKey: '' }, true);
    const saved = fixture.data.get(store.CONNECTION_SETTINGS_KEY) as { settings: { profiles: { deepseek: { baseUrl: string } } } };
    saved.settings.profiles.deepseek.baseUrl = 'https://new.example/v1';
    fixture.data.set(store.CONNECTION_SETTINGS_KEY, saved);
    await expect(store.importLegacyKeys(PASS)).rejects.toThrow(/服务地址/);
    expect(fixture.data.get(KEY_VAULT_STORAGE_KEY)).toEqual(vault);
  });

  it.each(['http://remote.example/v1', 'https://api.example/v1?api_key=bad', 'https://user:pass@api.example/v1'])('rejects unsafe or credential-bearing service URL %s', async baseUrl => {
    await expect(store.saveSettings({ ...modelInput, baseUrl }, true)).rejects.toThrow(/HTTPS/);
    expect(fixture.browser.storage.local.set).not.toHaveBeenCalled();
  });

  it('retains model choices when a stale hidden model form switches to free translation', async () => {
    await store.saveSettings(modelInput, true);
    const before = await store.readSettings();
    await store.saveSettings({ ...modelInput, translationEngine: 'deepl-web', provider: 'custom', baseUrl: '', model: '', apiKey: '',
      includeContext: true, sentenceAnalysisEnabled: false }, false);
    expect((await store.readSettings()).profiles).toEqual(before.profiles);
    expect(await store.publicSettings()).toMatchObject({ requiresApiKey: false, includeContext: false, sentenceAnalysisEnabled: false });
    expect(await store.connectionSettings()).toMatchObject({ includeContext: true, sentenceAnalysisEnabled: false });
    await store.saveSettings({ ...modelInput, apiKey: '' }, true);
    expect((await store.readSettings()).apiKey).toBe(KEY);
  });

  it('serializes simultaneous provider saves without dropping either credential', async () => {
    await store.saveSettings(modelInput, true);
    await Promise.all([
      store.saveSettings({ ...modelInput, provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-fixture', apiKey: 'fixture-only-openai-key' }, true),
      store.saveSettings({ ...modelInput, provider: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-fixture', apiKey: 'fixture-only-gemini-key' }, true),
    ]);
    expect(await store.readSettings()).toMatchObject({ provider: 'gemini', profiles: {
      deepseek: { apiKey: KEY }, openai: { apiKey: 'fixture-only-openai-key' }, gemini: { apiKey: 'fixture-only-gemini-key' },
    } });
  });

  it('normalizes equivalent endpoints and keeps older callers compatible', async () => {
    await store.saveSettings({ ...modelInput, baseUrl: 'https://api.deepseek.com/chat/completions/' }, true);
    const before = await store.readSettings();
    expect(before.baseUrl).toBe('https://api.deepseek.com');
    await store.saveSettings({ enabled: true, includeContext: true, sentenceAnalysisEnabled: false, model: before.model, apiKey: '' }, true);
    expect(await store.readSettings()).toMatchObject({ apiKey: KEY, provider: 'deepseek', baseUrl: before.baseUrl, connectionRevision: before.connectionRevision });
    await store.saveSettings({ enabled: true, includeContext: true, sentenceAnalysisEnabled: false, model: 'changed-model', apiKey: '' }, true);
    expect((await store.readSettings()).connectionRevision).toBe(before.connectionRevision + 1);
  });

  it('hides private storage exception details and recovers its save queue after failure', async () => {
    legacy();
    const original = structuredClone([...fixture.data]);
    fixture.browser.storage.local.set.mockRejectedValueOnce(new Error('private-storage-detail-' + KEY));
    const error = await store.saveSettings(modelInput, true).catch(reason => reason as Error) as Error;
    expect(error.message).not.toContain(KEY);
    expect(error.message).not.toContain('private-storage-detail');
    expect([...fixture.data]).toEqual(original);
    await store.saveSettings(modelInput, true);
    expect((await store.readSettings()).apiKey).toBe(KEY);
  });

  it('requires read-back confirmation of a new record without changing the old records', async () => {
    legacy();
    fixture.browser.storage.local.set.mockResolvedValueOnce(undefined);
    await expect(store.saveSettings(modelInput, true)).rejects.toThrow(/保存尚未确认/);
    expect(fixture.data.get(LEGACY)).toEqual(legacyConfig);
    expect(fixture.data.get(KEY_VAULT_STORAGE_KEY)).toEqual(vault);
  });

  it('does not erase or overwrite conflicting plaintext legacy records', async () => {
    fixture.data.set(LEGACY, { ...legacyConfig, apiKey: KEY, profiles: { deepseek: { ...legacyConfig.profiles.deepseek, apiKey: REPLACEMENT } } });
    const before = structuredClone([...fixture.data]);
    await expect(store.importLegacyKeys('')).rejects.toThrow(/不一致/);
    expect([...fixture.data]).toEqual(before);
  });

  it.each([
    { sentenceAnalysisEnabled: 'yes' }, { translationEngine: null }, { provider: 'unknown' }, { jsonMode: 'yes' },
    { model: 'bad\nmodel' }, { apiKey: 'bad\nkey' }, { apiKey: 'x'.repeat(4097) }, { baseUrl: 'http://remote.example' },
    { sourceLanguage: null }, { targetLanguage: 'unknown' },
  ])('rejects invalid configuration %# without modifying saved keys', async invalid => {
    await store.saveSettings(modelInput, true);
    const before = structuredClone([...fixture.data]);
    await expect(store.saveSettings({ ...modelInput, ...invalid }, true)).rejects.toThrow();
    expect([...fixture.data]).toEqual(before);
    await store.saveSettings({ ...modelInput, apiKey: '' }, true);
    expect((await store.readSettings()).apiKey).toBe(KEY);
  });

  it('preserves unrelated preferences and projects away unknown fields from messages', async () => {
    fixture.data.set('reading-preferences:v1', { theme: 'paper' });
    await store.saveSettings({ ...modelInput, injectedSecret: 'fixture-ignored-secret', profiles: { unknown: { apiKey: 'fixture-ignored-key' } } }, true);
    expect(fixture.data.get('reading-preferences:v1')).toEqual({ theme: 'paper' });
    expect(JSON.stringify([...fixture.data])).not.toContain('fixture-ignored-secret');
    expect(JSON.stringify([...fixture.data])).not.toContain('fixture-ignored-key');
    expect(fixture.browser.storage.local.remove).not.toHaveBeenCalled();
  });
});
