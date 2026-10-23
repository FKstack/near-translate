import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderId } from '../../src/shared/contracts';
import { getProvider } from '../../src/shared/api-config';
import { KEY_VAULT_SESSION_KEY, KEY_VAULT_STORAGE_KEY } from '../../src/shared/key-vault';

const state = vi.hoisted(() => ({
  local: {} as Record<string, unknown>, session: {} as Record<string, unknown>,
  localGet: vi.fn(), localSet: vi.fn(), localRemove: vi.fn(), sessionGet: vi.fn(), sessionSet: vi.fn(), sessionRemove: vi.fn(),
  localAccess: vi.fn(), sessionAccess: vi.fn(), contains: vi.fn(), request: vi.fn(), fetch: vi.fn(),
}));
vi.mock('wxt/browser', () => ({ browser: {
  storage: {
    local: { get: state.localGet, set: state.localSet, remove: state.localRemove, setAccessLevel: state.localAccess },
    session: { get: state.sessionGet, set: state.sessionSet, remove: state.sessionRemove, setAccessLevel: state.sessionAccess },
  },
  permissions: { contains: state.contains, request: state.request },
} }));

const KEY = 'settings:v1';
const PASS = 'test-only vault passphrase 2026';
const NEW_PASS = 'test-only replacement passphrase 2026';
const DEEPSEEK_KEY = 'test-only-deepseek-key-fixture';
const OPENAI_KEY = 'test-only-openai-key-fixture';
let api: typeof import('../../src/platform/settings');
const profile = (provider: ProviderId, apiKey = '') => ({
  model: getProvider(provider).model || 'test-model', baseUrl: getProvider(provider).baseUrl,
  jsonMode: getProvider(provider).jsonMode, apiKey,
});
const existing = () => ({
  schemaVersion: 2, translationEngine: 'model', enabled: true, includeContext: false, sentenceAnalysisEnabled: true,
  sourceLanguage: 'en', targetLanguage: 'zh-Hans', provider: 'deepseek', connectionRevision: 7,
  ...profile('deepseek', DEEPSEEK_KEY),
  profiles: { deepseek: profile('deepseek', DEEPSEEK_KEY), openai: profile('openai', OPENAI_KEY) },
});
const form = (provider: ProviderId = 'deepseek', apiKey = '') => ({
  translationEngine: 'model', enabled: true, includeContext: false, sentenceAnalysisEnabled: true,
  provider, ...profile(provider, apiKey),
});
const readArea = (area: Record<string, unknown>, query: string | string[] | null) => structuredClone(query === null ? area
  : Object.fromEntries((Array.isArray(query) ? query : [query]).filter(key => Object.hasOwn(area, key)).map(key => [key, area[key]])));
function writeArea(area: Record<string, unknown>, value: Record<string, unknown>) { Object.assign(area, structuredClone(value)); }
const persisted = () => state.local[KEY] as Record<string, unknown>;
async function configured() { await api.createKeyVault(PASS); return api.readSettings(); }

beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks();
  state.local = { [KEY]: existing() }; state.session = {};
  state.localGet.mockImplementation(async query => readArea(state.local, query));
  state.localSet.mockImplementation(async value => writeArea(state.local, value));
  state.localRemove.mockImplementation(async key => { for (const name of Array.isArray(key) ? key : [key]) delete state.local[name]; });
  state.sessionGet.mockImplementation(async query => readArea(state.session, query));
  state.sessionSet.mockImplementation(async value => writeArea(state.session, value));
  state.sessionRemove.mockImplementation(async key => { for (const name of Array.isArray(key) ? key : [key]) delete state.session[name]; });
  state.localAccess.mockResolvedValue(undefined); state.sessionAccess.mockResolvedValue(undefined);
  state.contains.mockResolvedValue(true); state.request.mockResolvedValue(false);
  state.fetch.mockRejectedValue(new Error('Unexpected fetch in settings test'));
  vi.stubGlobal('fetch', state.fetch);
  api = await import('../../src/platform/settings');
});
afterEach(() => {
  expect(state.fetch).not.toHaveBeenCalled();
  expect(state.request).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe('vault migration and storage boundaries', () => {
  it('leaves legacy keys untouched but unavailable until a passphrase is supplied', async () => {
    const before = structuredClone(state.local);
    expect(await api.readSettings()).toMatchObject({ schemaVersion: 2, apiKey: '', keyVaultLocked: true });
    expect(await api.keyVaultStatus()).toEqual({ configured: false, locked: true, migrationRequired: true,
      savedProviders: ['deepseek', 'openai'] });
    expect(await api.publicSettings()).toMatchObject({ hasApiKey: false, keyVaultLocked: true });
    expect(await api.connectionSettings()).toMatchObject({ profiles: { deepseek: { hasApiKey: true }, openai: { hasApiKey: true } } });
    expect(state.local).toEqual(before);
    expect(state.localSet).not.toHaveBeenCalled();
    expect(state.localAccess).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
    expect(state.sessionAccess).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
  });

  it('migrates every provider, validates ciphertext, then removes all local plaintext copies', async () => {
    const result = await api.createKeyVault(PASS);
    expect(result).toEqual({ configured: true, locked: false, migrationRequired: false, savedProviders: ['deepseek', 'openai'] });
    expect(await api.readSettings()).toMatchObject({ apiKey: DEEPSEEK_KEY, connectionRevision: 8,
      profiles: { deepseek: { apiKey: DEEPSEEK_KEY }, openai: { apiKey: OPENAI_KEY } } });
    expect(persisted().schemaVersion).toBe(3);
    expect(persisted()).not.toHaveProperty('apiKey');
    expect(persisted()).not.toHaveProperty('keyVaultLocked');
    expect((persisted().profiles as Record<string, unknown>).deepseek).not.toHaveProperty('apiKey');
    const disk = JSON.stringify(state.local);
    expect(disk).not.toContain(DEEPSEEK_KEY); expect(disk).not.toContain(OPENAI_KEY); expect(disk).not.toContain(PASS);
    const unlocked = state.session[KEY_VAULT_SESSION_KEY] as { key: string };
    expect(disk).not.toContain(unlocked.key);
    expect(JSON.stringify(state.session)).not.toContain(DEEPSEEK_KEY);
    expect(state.localSet.mock.calls[0]![0]).toHaveProperty(KEY_VAULT_STORAGE_KEY);
    expect(state.localSet.mock.calls[1]![0]).toHaveProperty(KEY);
  });

  it('migrates an old flattened DeepSeek v1 setting without copying to a different host', async () => {
    state.local[KEY] = { schemaVersion: 1, enabled: true, includeContext: true, model: 'old-model', apiKey: DEEPSEEK_KEY };
    await configured();
    expect(await api.readSettings()).toMatchObject({ provider: 'deepseek', apiKey: DEEPSEEK_KEY, model: 'old-model' });
  });

  it('rejects conflicting flattened/profile credentials instead of silently losing one', async () => {
    (persisted().profiles as Record<string, unknown>).deepseek = profile('deepseek', 'test-only-conflicting-fixture');
    const before = structuredClone(state.local);
    await expect(api.createKeyVault(PASS)).rejects.toThrow(/不一致/);
    expect(state.local).toEqual(before);
    expect(state.localSet).not.toHaveBeenCalled();
  });

  it.each([
    () => { persisted().baseUrl = 'http://remote.example'; },
    () => { persisted().provider = 'unknown'; },
    () => { (persisted().profiles as Record<string, unknown>).unknown = { baseUrl: 'https://unknown.example', apiKey: 'test-only-unknown' }; },
  ])('does not delete unsafe or unknown old credentials %#', async mutate => {
    mutate(); const before = structuredClone(state.local);
    await expect(api.createKeyVault(PASS)).rejects.toThrow(/旧|已有/);
    expect(state.local).toEqual(before);
  });

  it('does not expose storage exception strings and retains legacy data on write failure', async () => {
    const before = structuredClone(state.local);
    state.localSet.mockRejectedValueOnce(new Error('test-only-private-browser-error-' + DEEPSEEK_KEY));
    const error = await api.createKeyVault(PASS).catch(error => error as Error) as Error;
    expect(error.message).not.toContain(DEEPSEEK_KEY);
    expect(error.message).not.toContain('private-browser-error');
    expect(state.local).toEqual(before);
    await configured(); // A failed mutation must not poison the queue.
    expect((await api.readSettings()).apiKey).toBe(DEEPSEEK_KEY);
  });

  it('keeps verified ciphertext plus legacy data if cleanup fails and unlock resumes safely', async () => {
    const before = structuredClone(persisted());
    state.localSet.mockImplementation(async value => {
      if (Object.hasOwn(value, KEY)) throw new Error('test-only-cleanup-failure');
      writeArea(state.local, value);
    });
    await expect(api.createKeyVault(PASS)).rejects.toThrow(/失败/);
    expect(persisted()).toEqual(before);
    expect(state.local).toHaveProperty(KEY_VAULT_STORAGE_KEY);
    expect(await api.keyVaultStatus()).toMatchObject({ configured: true, locked: true, migrationRequired: true });
    expect((await api.readSettings()).apiKey).toBe('');
    state.localSet.mockImplementation(async value => writeArea(state.local, value));
    await api.unlockKeyVault(PASS);
    expect((await api.readSettings()).apiKey).toBe(DEEPSEEK_KEY);
    expect(JSON.stringify(state.local)).not.toContain(DEEPSEEK_KEY);
  });

  it('rolls back unverified ciphertext while preserving every legacy credential', async () => {
    const before = structuredClone(state.local);
    state.localSet.mockImplementation(async value => {
      const altered = structuredClone(value);
      if (Object.hasOwn(altered, KEY_VAULT_STORAGE_KEY)) {
        const vault = altered[KEY_VAULT_STORAGE_KEY] as { ciphertext: string };
        const bytes = Buffer.from(vault.ciphertext, 'base64'); bytes[0] = bytes[0]! ^ 1;
        vault.ciphertext = bytes.toString('base64');
      }
      writeArea(state.local, altered);
    });
    await expect(api.createKeyVault(PASS)).rejects.toThrow(/验证失败/);
    expect(state.local).toEqual(before);
    state.localSet.mockImplementation(async value => writeArea(state.local, value));
    await configured();
    expect((await api.readSettings()).profiles.openai?.apiKey).toBe(OPENAI_KEY);
  });

  it('requires read-back confirmation that every legacy plaintext field was removed', async () => {
    state.localSet.mockImplementation(async value => {
      if (!Object.hasOwn(value, KEY)) writeArea(state.local, value);
    });
    await expect(api.createKeyVault(PASS)).rejects.toThrow(/清理尚未确认/);
    expect(state.session).not.toHaveProperty(KEY_VAULT_SESSION_KEY);
    expect(persisted().apiKey).toBe(DEEPSEEK_KEY);
    state.localSet.mockImplementation(async value => writeArea(state.local, value));
    await api.unlockKeyVault(PASS);
    expect((await api.keyVaultStatus()).migrationRequired).toBe(false);
    expect(JSON.stringify(state.local)).not.toContain(DEEPSEEK_KEY);
  });

  it('refuses cleanup if a legacy credential no longer matches the encrypted copy', async () => {
    state.localSet.mockImplementation(async value => {
      if (Object.hasOwn(value, KEY)) throw new Error('test-only-cleanup-failure');
      writeArea(state.local, value);
    });
    await api.createKeyVault(PASS).catch(() => undefined);
    const raw = persisted(); raw.apiKey = 'test-only-new-legacy-conflict';
    (raw.profiles as Record<string, unknown>).deepseek = profile('deepseek', String(raw.apiKey));
    state.localSet.mockImplementation(async value => writeArea(state.local, value));
    const before = structuredClone(state.local);
    await expect(api.unlockKeyVault(PASS)).rejects.toThrow(/不一致/);
    expect(state.local).toEqual(before);
  });

  it('preserves the old plaintext awaiting migration when enabling free translation', async () => {
    const original = existing();
    await api.enableFreeTranslation();
    expect(persisted()).toMatchObject({ translationEngine: 'deepl-web', enabled: true, apiKey: original.apiKey, profiles: original.profiles });
    expect((await api.readSettings()).apiKey).toBe('');
    expect(await api.publicSettings()).toMatchObject({ requiresApiKey: false, hasApiKey: false });
    await configured();
    expect(JSON.stringify(state.local)).not.toContain(DEEPSEEK_KEY);
    expect(await api.readSettings()).toMatchObject({ translationEngine: 'deepl-web', apiKey: DEEPSEEK_KEY });
  });

  it('requires a vault before new credentials are accepted on a fresh install', async () => {
    state.local = {};
    expect(await api.readSettings()).toMatchObject({ translationEngine: 'deepl-web', apiKey: '' });
    expect(await api.keyVaultStatus()).toEqual({ configured: false, locked: false, migrationRequired: false, savedProviders: [] });
    await expect(api.saveSettings(form('deepseek', DEEPSEEK_KEY), true)).rejects.toThrow(/创建密钥库/);
    expect(state.localSet).not.toHaveBeenCalled();
    await configured();
    await api.saveSettings(form('deepseek', DEEPSEEK_KEY), true);
    expect((await api.readSettings()).apiKey).toBe(DEEPSEEK_KEY);
  });

  it('never includes API Keys, passphrases, session material or ciphertext in settings projections', async () => {
    await configured();
    const publicValue = await api.publicSettings(); const trustedValue = await api.connectionSettings();
    expect(publicValue).not.toHaveProperty('profiles'); expect(publicValue).not.toHaveProperty('baseUrl'); expect(publicValue).not.toHaveProperty('vault');
    const text = JSON.stringify([publicValue, trustedValue]);
    for (const secret of [DEEPSEEK_KEY, OPENAI_KEY, PASS,
      (state.session[KEY_VAULT_SESSION_KEY] as { key: string }).key,
      (state.local[KEY_VAULT_STORAGE_KEY] as { ciphertext: string }).ciphertext]) expect(text).not.toContain(secret);
  });
});

describe('locking, session lifetime and rotation', () => {
  beforeEach(async () => { await configured(); });

  it('marks saved credentials as locked, retains trusted saved markers and does not erase ciphertext', async () => {
    const encrypted = structuredClone(state.local[KEY_VAULT_STORAGE_KEY]);
    const revision = (await api.readSettings()).connectionRevision;
    await api.lockKeyVault();
    expect(state.session).not.toHaveProperty(KEY_VAULT_SESSION_KEY);
    expect(state.local[KEY_VAULT_STORAGE_KEY]).toEqual(encrypted);
    expect(await api.readSettings()).toMatchObject({ apiKey: '', keyVaultLocked: true, connectionRevision: revision + 1 });
    expect(await api.connectionSettings()).toMatchObject({ hasApiKey: false, vault: { locked: true }, profiles: { deepseek: { hasApiKey: true } } });
    await api.unlockKeyVault(PASS);
    expect(await api.readSettings()).toMatchObject({ apiKey: DEEPSEEK_KEY, keyVaultLocked: false, connectionRevision: revision + 2 });
  });

  it('survives service-worker restart using only trusted session material', async () => {
    const before = structuredClone(state.local);
    vi.resetModules(); api = await import('../../src/platform/settings');
    expect((await api.readSettings()).apiKey).toBe(DEEPSEEK_KEY);
    expect(state.local).toEqual(before);
  });

  it('locks after browser session reset and unlocks all retained providers using the same passphrase', async () => {
    state.session = {}; vi.resetModules(); api = await import('../../src/platform/settings');
    expect(await api.readSettings()).toMatchObject({ apiKey: '', keyVaultLocked: true });
    await api.unlockKeyVault(PASS);
    expect((await api.readSettings()).profiles.openai?.apiKey).toBe(OPENAI_KEY);
  });

  it('rejects forged, stale and malformed session material without exposing a credential', async () => {
    for (const value of [
      { version: 1, key: Buffer.alloc(32, 9).toString('base64'), salt: 'wrong' },
      { ...(state.session[KEY_VAULT_SESSION_KEY] as object), key: Buffer.alloc(32, 9).toString('base64') },
      { ...(state.session[KEY_VAULT_SESSION_KEY] as object), key: 'AB==' },
    ]) {
      state.session[KEY_VAULT_SESSION_KEY] = value;
      expect((await api.readSettings()).apiKey).toBe('');
      expect((await api.keyVaultStatus()).locked).toBe(true);
    }
  });

  it('allows non-secret preferences and DeepL setup while locked, without rewriting the vault', async () => {
    await api.lockKeyVault(); const encrypted = structuredClone(state.local[KEY_VAULT_STORAGE_KEY]);
    await api.saveSettings({ ...form(), model: 'changed-model', includeContext: true, sentenceAnalysisEnabled: false, targetLanguage: 'ja' }, true);
    expect(await api.readSettings()).toMatchObject({ model: 'changed-model', includeContext: true, sentenceAnalysisEnabled: false, targetLanguage: 'ja', apiKey: '' });
    await api.enableFreeTranslation();
    expect((await api.readSettings()).translationEngine).toBe('deepl-web');
    expect(await api.publicSettings()).toMatchObject({ requiresApiKey: false, keyVaultLocked: false });
    expect(state.local[KEY_VAULT_STORAGE_KEY]).toEqual(encrypted);
    expect(JSON.stringify(state.local)).not.toContain(DEEPSEEK_KEY);
  });

  it.each([
    { input: () => ({ ...form(), apiKey: 'test-only-replacement-key' }), keep: true },
    { input: () => form(), keep: false },
    { input: () => ({ ...form(), baseUrl: 'https://gateway.example/v1' }), keep: true },
  ])('rejects locked credential mutation %#', async ({ input, keep }) => {
    await api.lockKeyVault(); const before = structuredClone(state.local);
    await expect(api.saveSettings(input(), keep)).rejects.toThrow(/锁定/);
    expect(state.local).toEqual(before);
  });

  it('rejects a wrong passphrase without unlocking or changing persisted data', async () => {
    await api.lockKeyVault(); const before = structuredClone(state.local);
    await expect(api.unlockKeyVault('test-only incorrect passphrase')).rejects.toThrow(/口令/);
    expect(state.local).toEqual(before);
    expect((await api.readSettings()).apiKey).toBe('');
  });

  it('changes passphrase with fresh salt/IV and keeps every provider credential', async () => {
    const old = structuredClone(state.local[KEY_VAULT_STORAGE_KEY]) as { kdf: { salt: string }; cipher: { iv: string } };
    await api.changeKeyVaultPassphrase(PASS, NEW_PASS);
    const updated = state.local[KEY_VAULT_STORAGE_KEY] as typeof old;
    expect(updated.kdf.salt).not.toBe(old.kdf.salt); expect(updated.cipher.iv).not.toBe(old.cipher.iv);
    await api.lockKeyVault();
    await expect(api.unlockKeyVault(PASS)).rejects.toThrow(/口令/);
    await api.unlockKeyVault(NEW_PASS);
    expect((await api.readSettings()).profiles.openai?.apiKey).toBe(OPENAI_KEY);
    expect(JSON.stringify(state.local)).not.toContain(NEW_PASS);
  });

  it('restores the previous encrypted vault when a rotation fails verification', async () => {
    const old = structuredClone(state.local[KEY_VAULT_STORAGE_KEY]);
    let corruptNextVault = true;
    state.localSet.mockImplementation(async value => {
      const altered = structuredClone(value);
      if (Object.hasOwn(altered, KEY_VAULT_STORAGE_KEY) && corruptNextVault) {
        corruptNextVault = false;
        (altered[KEY_VAULT_STORAGE_KEY] as { ciphertext: string }).ciphertext = Buffer.alloc(20).toString('base64');
      }
      writeArea(state.local, altered);
    });
    await expect(api.changeKeyVaultPassphrase(PASS, NEW_PASS)).rejects.toThrow(/验证失败/);
    expect(state.local[KEY_VAULT_STORAGE_KEY]).toEqual(old);
    await api.lockKeyVault(); await api.unlockKeyVault(PASS);
    expect((await api.readSettings()).apiKey).toBe(DEEPSEEK_KEY);
  });

  it('reports when a new passphrase is saved but session restoration fails', async () => {
    state.sessionSet.mockRejectedValueOnce(new Error('test-only-session-quota-error'));
    await expect(api.changeKeyVaultPassphrase(PASS, NEW_PASS)).rejects.toThrow(/新口令已生效/);
    expect((await api.keyVaultStatus()).locked).toBe(true);
    await api.unlockKeyVault(NEW_PASS);
    expect((await api.readSettings()).apiKey).toBe(DEEPSEEK_KEY);
  });

  it('reports the new passphrase after a post-rotation metadata failure', async () => {
    state.localSet.mockImplementationOnce(async value => writeArea(state.local, value));
    state.localSet.mockRejectedValueOnce(new Error('test-only-metadata-write-error'));
    await expect(api.changeKeyVaultPassphrase(PASS, NEW_PASS)).rejects.toThrow(/新口令已生效/);
    expect((await api.keyVaultStatus()).locked).toBe(true);
    await api.unlockKeyVault(NEW_PASS);
    expect((await api.readSettings()).profiles.openai?.apiKey).toBe(OPENAI_KEY);
  });

  it('rejects malformed on-disk vaults without treating them as a fresh vault', async () => {
    const encrypted = state.local[KEY_VAULT_STORAGE_KEY] as { kdf: { iterations: number } };
    encrypted.kdf.iterations = 1;
    await expect(api.keyVaultStatus()).rejects.toThrow(/损坏/);
    await expect(api.createKeyVault(PASS)).rejects.toThrow(/损坏/);
    expect((state.local[KEY_VAULT_STORAGE_KEY] as typeof encrypted).kdf.iterations).toBe(1);
  });
});

describe('profile compatibility and serialized writes', () => {
  beforeEach(async () => { await configured(); });

  it('preserves profiles, context and analysis choices through a stale hidden DeepL form', async () => {
    const before = await api.readSettings();
    await api.saveSettings({ ...form('custom'), translationEngine: 'deepl-web', model: '', baseUrl: '', apiKey: '', includeContext: true, sentenceAnalysisEnabled: false }, false);
    const free = await api.readSettings();
    expect(free.profiles).toEqual(before.profiles);
    expect(free.apiKey).toBe(DEEPSEEK_KEY);
    expect(await api.publicSettings()).toMatchObject({ includeContext: false, sentenceAnalysisEnabled: false, requiresApiKey: false });
    expect(await api.connectionSettings()).toMatchObject({ includeContext: true, sentenceAnalysisEnabled: false });
    await api.saveSettings(form('openai'), true);
    expect((await api.readSettings()).apiKey).toBe(OPENAI_KEY);
    expect(JSON.stringify(state.local)).not.toContain(OPENAI_KEY);
  });

  it('serializes simultaneous provider saves and retains every credential', async () => {
    await Promise.all([
      api.saveSettings(form('openai', 'test-only-new-openai-key'), true),
      api.saveSettings({ ...form('gemini', 'test-only-gemini-key'), model: 'fixture-model' }, true),
    ]);
    const runtime = await api.readSettings();
    expect(runtime.provider).toBe('gemini');
    expect(runtime.profiles.deepseek?.apiKey).toBe(DEEPSEEK_KEY);
    expect(runtime.profiles.openai?.apiKey).toBe('test-only-new-openai-key');
    expect(runtime.profiles.gemini?.apiKey).toBe('test-only-gemini-key');
    expect(JSON.stringify(state.local)).not.toContain('test-only-new-openai-key');
  });

  it('normalizes equivalent addresses and detaches a key from a changed address', async () => {
    await api.saveSettings({ ...form(), baseUrl: 'https://api.deepseek.com/chat/completions/' }, true);
    expect((await api.readSettings()).apiKey).toBe(DEEPSEEK_KEY);
    await api.saveSettings({ ...form(), baseUrl: 'https://gateway.example/v1' }, true);
    expect((await api.readSettings()).apiKey).toBe('');
    expect((await api.readSettings()).profiles.openai?.apiKey).toBe(OPENAI_KEY);
    await api.lockKeyVault(); await api.unlockKeyVault(PASS);
    expect((await api.readSettings()).apiKey).toBe('');
  });

  it('deletes only the selected credential and never resurrects it when switching engines', async () => {
    await api.saveSettings(form('openai'), false);
    expect((await api.readSettings()).apiKey).toBe('');
    expect((await api.keyVaultStatus()).savedProviders).toEqual(['deepseek']);
    await api.enableFreeTranslation(); await api.saveSettings(form('deepseek'), true);
    expect((await api.readSettings()).apiKey).toBe(DEEPSEEK_KEY);
    await api.saveSettings(form('openai'), true);
    expect((await api.readSettings()).apiKey).toBe('');
  });

  it('preserves provider/address options for older settings callers and advances only connection revisions', async () => {
    await api.saveSettings({ ...form('custom', 'test-only-custom-key'), model: 'vendor/model:latest', baseUrl: 'https://gateway.example/v1' }, true);
    const before = await api.readSettings();
    await api.saveSettings({ enabled: true, includeContext: true, model: before.model, apiKey: '', sentenceAnalysisEnabled: false }, true);
    expect(await api.readSettings()).toMatchObject({ provider: 'custom', baseUrl: before.baseUrl, apiKey: 'test-only-custom-key',
      connectionRevision: before.connectionRevision, sentenceAnalysisEnabled: false });
    await api.saveSettings({ enabled: true, includeContext: true, model: 'new-model', apiKey: '', sentenceAnalysisEnabled: false }, true);
    expect((await api.readSettings()).connectionRevision).toBe(before.connectionRevision + 1);
  });

  it.each([
    { sentenceAnalysisEnabled: 'yes' }, { translationEngine: null }, { provider: 'unknown' }, { jsonMode: 'yes' },
    { model: 'bad\nmodel' }, { apiKey: 'bad\nkey' }, { apiKey: 'x'.repeat(4097) }, { baseUrl: 'http://remote.example' },
    { sourceLanguage: null }, { targetLanguage: 'unknown' },
  ])('rejects invalid settings %# without writing secrets or poisoning the queue', async invalid => {
    const before = structuredClone(state.local);
    await expect(api.saveSettings({ ...form(), ...invalid }, true)).rejects.toThrow();
    expect(state.local).toEqual(before);
    await api.saveSettings(form(), true);
    expect((await api.readSettings()).apiKey).toBe(DEEPSEEK_KEY);
  });

  it('retains unrelated local data and does not persist unknown fields from a settings message', async () => {
    state.local['reading-preferences:v1'] = { theme: 'paper' };
    await api.saveSettings({ ...form(), apiKey: '', injectedSecret: 'test-only-should-not-persist', profiles: { unknown: { apiKey: 'test-only-bypass' } } }, true);
    expect(state.local['reading-preferences:v1']).toEqual({ theme: 'paper' });
    expect(JSON.stringify(state.local)).not.toContain('test-only-should-not-persist');
    expect(JSON.stringify(state.local)).not.toContain('test-only-bypass');
    expect(persisted()).not.toHaveProperty('apiKey');
  });
});
