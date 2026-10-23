import { beforeAll, describe, expect, it } from 'vitest';
import { createEncryptedKeyVault, decryptKeyVault, KeyVaultError, legacyCredential, parseEncryptedKeyVault,
  unlockEncryptedKeyVault, updateEncryptedKeyVault, validateVaultCredentials, validateVaultPassphrase,
  validateVaultSessionKey } from '../../src/platform/key-vault';
import type { EncryptedKeyVault, VaultCredentials } from '../../src/shared/key-vault';
import { PROVIDERS } from '../../src/shared/api-config';

const PASSPHRASE = 'test-only vault passphrase 2026';
const credentials: VaultCredentials = {
  deepseek: { baseUrl: 'https://api.deepseek.com', apiKey: 'test-only-deepseek-vault-fixture' },
  openai: { baseUrl: 'https://api.openai.com/v1', apiKey: 'test-only-openai-vault-fixture' },
};
let vault: EncryptedKeyVault;
let sessionKey: string;
beforeAll(async () => { ({ vault, sessionKey } = await createEncryptedKeyVault(PASSPHRASE, credentials)); });

describe('authenticated passphrase key vault', () => {
  it('uses bounded PBKDF2-SHA256 and AES-GCM with no plaintext in the envelope', async () => {
    expect(vault.kdf).toMatchObject({ name: 'PBKDF2', hash: 'SHA-256', iterations: 600000 });
    expect(vault.cipher).toMatchObject({ name: 'AES-GCM', tagLength: 128 });
    expect(Buffer.from(vault.kdf.salt, 'base64')).toHaveLength(16);
    expect(Buffer.from(vault.cipher.iv, 'base64')).toHaveLength(12);
    const disk = JSON.stringify(vault);
    for (const secret of [PASSPHRASE, sessionKey, ...Object.values(credentials).map(value => value!.apiKey)]) expect(disk).not.toContain(secret);
    expect(await decryptKeyVault(vault, sessionKey)).toEqual(credentials);
    expect((await unlockEncryptedKeyVault(vault, PASSPHRASE)).credentials).toEqual(credentials);
  });

  it('creates independent salts/keys and never reuses an IV on update', async () => {
    const created = await createEncryptedKeyVault(PASSPHRASE, credentials);
    expect(created.vault.kdf.salt).not.toBe(vault.kdf.salt);
    expect(created.sessionKey).not.toBe(sessionKey);
    const updated = await updateEncryptedKeyVault(vault, sessionKey, { ...credentials,
      custom: { baseUrl: 'https://gateway.example/v1', apiKey: 'test-only-custom-fixture' } });
    expect(updated.kdf.salt).toBe(vault.kdf.salt);
    expect(updated.cipher.iv).not.toBe(vault.cipher.iv);
    expect((await decryptKeyVault(updated, sessionKey)).custom?.baseUrl).toBe('https://gateway.example/v1');
    expect(await decryptKeyVault(vault, sessionKey)).toEqual(credentials);
  });

  it('preserves leading and trailing passphrase spaces exactly', async () => {
    const exact = '  test-only padded passphrase  ';
    const created = await createEncryptedKeyVault(exact, credentials);
    await expect(unlockEncryptedKeyVault(created.vault, exact.trim())).rejects.toThrow(/口令/);
    expect((await unlockEncryptedKeyVault(created.vault, exact)).credentials).toEqual(credentials);
  });

  it('rejects a wrong passphrase without changing the vault or exposing input', async () => {
    const before = structuredClone(vault);
    const wrong = 'test-only deliberately wrong passphrase';
    const error = await unlockEncryptedKeyVault(vault, wrong).catch(error => error as Error) as Error;
    expect(error).toBeInstanceOf(KeyVaultError);
    expect(error.message).not.toContain(wrong);
    expect(error.message).not.toContain(credentials.deepseek!.apiKey);
    expect(vault).toEqual(before);
  });

  it.each(['ciphertext', 'iv', 'salt', 'providers'] as const)('authenticates tampered %s', async field => {
    const changed = structuredClone(vault);
    const flip = (value: string) => { const bytes = Buffer.from(value, 'base64'); bytes[0] = bytes[0]! ^ 1; return bytes.toString('base64'); };
    if (field === 'ciphertext') changed.ciphertext = flip(changed.ciphertext);
    if (field === 'iv') changed.cipher.iv = flip(changed.cipher.iv);
    if (field === 'salt') changed.kdf.salt = flip(changed.kdf.salt);
    if (field === 'providers') changed.savedProviders = ['deepseek'];
    await expect(decryptKeyVault(changed, sessionKey)).rejects.toThrow(/损坏/);
  });

  it('cannot overwrite a vault using a forged or stale session key', async () => {
    const forged = Buffer.alloc(32, 7).toString('base64');
    await expect(updateEncryptedKeyVault(vault, forged, {})).rejects.toThrow(/损坏/);
    expect(await decryptKeyVault(vault, sessionKey)).toEqual(credentials);
  });

  it('round-trips all providers and bounded long credentials', async () => {
    const all = Object.fromEntries(PROVIDERS.map(preset => [preset.id,
      { baseUrl: preset.baseUrl || 'https://custom.example/v1', apiKey: 'x'.repeat(4096) }])) as VaultCredentials;
    const created = await createEncryptedKeyVault(PASSPHRASE, all);
    expect(await decryptKeyVault(created.vault, created.sessionKey)).toEqual(all);
  });

  it.each([undefined, null, 4, '', 'short', 'x'.repeat(129)])('rejects invalid passphrase %# before crypto', value => {
    expect(() => validateVaultPassphrase(value)).toThrow(/12–128/);
  });

  it.each([0, 1, 599999, 600001, Infinity, '600000'])('rejects unapproved iteration count %s', iterations => {
    expect(() => parseEncryptedKeyVault({ ...vault, kdf: { ...vault.kdf, iterations } })).toThrow(/损坏/);
  });

  it.each([
    (value: EncryptedKeyVault) => ({ ...value, extra: true }),
    (value: EncryptedKeyVault) => ({ ...value, version: 2 }),
    (value: EncryptedKeyVault) => ({ ...value, ciphertext: 'A'.repeat(300000) }),
    (value: EncryptedKeyVault) => ({ ...value, ciphertext: '**invalid**' }),
    (value: EncryptedKeyVault) => ({ ...value, kdf: { ...value.kdf, salt: 'AB==' } }),
    (value: EncryptedKeyVault) => ({ ...value, cipher: { ...value.cipher, iv: Buffer.alloc(11).toString('base64') } }),
    (value: EncryptedKeyVault) => ({ ...value, savedProviders: ['openai', 'deepseek'] }),
    (value: EncryptedKeyVault) => ({ ...value, savedProviders: ['deepseek', 'deepseek'] }),
    (value: EncryptedKeyVault) => ({ ...value, savedProviders: ['unknown'] }),
  ])('rejects malformed envelope %# with bounded parsing', mutate => {
    expect(() => parseEncryptedKeyVault(mutate(vault))).toThrow(/损坏/);
  });

  it('validates canonical session-key encoding', () => {
    expect(validateVaultSessionKey(sessionKey)).toBe(true);
    for (const value of [undefined, 'AB==', 'x'.repeat(1000), Buffer.alloc(31).toString('base64'), sessionKey + '\n']) {
      expect(validateVaultSessionKey(value)).toBe(false);
    }
  });

  it.each([
    { unknown: { baseUrl: 'https://a.example', apiKey: 'secret' } },
    { deepseek: { baseUrl: 'http://remote.example', apiKey: 'secret' } },
    { deepseek: { baseUrl: 'https://a.example/', apiKey: 'secret' } },
    { deepseek: { baseUrl: 'https://a.example', apiKey: 'secret\n' } },
    { deepseek: { baseUrl: 'https://a.example', apiKey: 'x'.repeat(4097) } },
    { deepseek: { baseUrl: 'https://a.example', apiKey: 'secret', extra: true } },
  ])('rejects malformed credential record %#', value => {
    expect(() => validateVaultCredentials(value)).toThrow(/损坏/);
  });

  it('keeps old keys bound to validated normalized URLs and refuses unsafe fallback', () => {
    expect(legacyCredential({ apiKey: ' legacy-secret ', baseUrl: 'https://api.deepseek.com/chat/completions/' }, 'deepseek'))
      .toEqual({ apiKey: 'legacy-secret', baseUrl: 'https://api.deepseek.com' });
    expect(() => legacyCredential({ apiKey: 'legacy-secret', baseUrl: 'http://remote.example' }, 'deepseek')).toThrow(/地址/);
    expect(() => legacyCredential({ apiKey: 'legacy-secret\n' }, 'deepseek')).toThrow(/格式/);
  });
});
