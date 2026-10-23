import { getProvider, isProviderId, normalizeBaseUrl, PROVIDERS } from '../shared/api-config';
import type { ProviderId } from '../shared/contracts';
import { KEY_VAULT_MAX_PASSPHRASE, KEY_VAULT_MIN_PASSPHRASE,
  type EncryptedKeyVault, type VaultCredentials } from '../shared/key-vault';

const ITERATIONS = 600000;
const MAX_CIPHERTEXT_BYTES = 196608;
const CONTEXT = 'near-translate:key-vault:v1';
const CONTROLS = /[\u0000-\u001f\u007f]/;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** Only fixed, non-secret messages cross the settings boundary. */
export class KeyVaultError extends Error {
  constructor(message: string) { super(message); this.name = 'KeyVaultError'; }
}

const invalid = () => new KeyVaultError('密钥库数据损坏或格式不受支持。原有数据未删除，请勿重置。');
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, fields: string[]): boolean {
  return Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}
export function validateVaultPassphrase(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length < KEY_VAULT_MIN_PASSPHRASE || value.length > KEY_VAULT_MAX_PASSPHRASE) {
    throw new KeyVaultError('解锁口令须为 12–128 个字符；空格属于口令，不会自动去除。');
  }
}
function encode(bytes: Uint8Array): string {
  let result = '';
  for (let offset = 0; offset < bytes.length; offset += 4096) result += String.fromCharCode(...bytes.subarray(offset, offset + 4096));
  return btoa(result);
}
function decode(value: unknown, min: number, max: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || value.length > Math.ceil(max / 3) * 4 || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw invalid();
  try {
    const bytes = Uint8Array.from(atob(value), char => char.charCodeAt(0));
    if (bytes.length < min || bytes.length > max || encode(bytes) !== value) throw invalid();
    return bytes;
  } catch { throw invalid(); }
}
function sortedProviders(credentials: VaultCredentials): ProviderId[] {
  return PROVIDERS.filter(provider => Object.hasOwn(credentials, provider.id)).map(provider => provider.id);
}
export function validateVaultCredentials(value: unknown): VaultCredentials {
  if (!record(value) || Object.keys(value).length > PROVIDERS.length) throw invalid();
  const result: VaultCredentials = {};
  for (const [id, credential] of Object.entries(value)) {
    if (!isProviderId(id) || !record(credential) || !exact(credential, ['baseUrl', 'apiKey'])
      || typeof credential.baseUrl !== 'string' || typeof credential.apiKey !== 'string'
      || !credential.apiKey || credential.apiKey.length > 4096 || CONTROLS.test(credential.apiKey)
      || credential.apiKey.trim() !== credential.apiKey) throw invalid();
    let baseUrl: string;
    try { baseUrl = normalizeBaseUrl(credential.baseUrl); } catch { throw invalid(); }
    if (baseUrl !== credential.baseUrl) throw invalid();
    result[id] = { baseUrl, apiKey: credential.apiKey };
  }
  return result;
}
export function parseEncryptedKeyVault(value: unknown): EncryptedKeyVault {
  if (!record(value) || !exact(value, ['version', 'kdf', 'cipher', 'savedProviders', 'ciphertext']) || value.version !== 1
    || !record(value.kdf) || !exact(value.kdf, ['name', 'hash', 'iterations', 'salt'])
    || value.kdf.name !== 'PBKDF2' || value.kdf.hash !== 'SHA-256' || value.kdf.iterations !== ITERATIONS
    || !record(value.cipher) || !exact(value.cipher, ['name', 'iv', 'tagLength'])
    || value.cipher.name !== 'AES-GCM' || value.cipher.tagLength !== 128
    || !Array.isArray(value.savedProviders) || value.savedProviders.length > PROVIDERS.length
    || value.savedProviders.some(id => !isProviderId(id)) || new Set(value.savedProviders).size !== value.savedProviders.length) throw invalid();
  const providers = value.savedProviders as ProviderId[];
  if (PROVIDERS.filter(provider => providers.includes(provider.id)).map(provider => provider.id).join(',') !== providers.join(',')) throw invalid();
  decode(value.kdf.salt, 16, 16); decode(value.cipher.iv, 12, 12); decode(value.ciphertext, 16, MAX_CIPHERTEXT_BYTES);
  return {
    version: 1,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS, salt: value.kdf.salt as string },
    cipher: { name: 'AES-GCM', iv: value.cipher.iv as string, tagLength: 128 },
    savedProviders: [...providers], ciphertext: value.ciphertext as string,
  };
}
function aad(providers: ProviderId[], salt: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(`${CONTEXT}\n${salt}\n${providers.join(',')}`);
}
async function derive(passphrase: string, salt: string): Promise<string> {
  validateVaultPassphrase(passphrase);
  const bytes = encoder.encode(passphrase);
  try {
    const material = await crypto.subtle.importKey('raw', bytes, 'PBKDF2', false, ['deriveBits']);
    const derived = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256',
      iterations: ITERATIONS, salt: decode(salt, 16, 16) }, material, 256));
    try { return encode(derived); } finally { derived.fill(0); }
  } finally { bytes.fill(0); }
}
async function importSessionKey(sessionKey: string): Promise<CryptoKey> {
  const bytes = decode(sessionKey, 32, 32);
  try { return await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']); }
  finally { bytes.fill(0); }
}
export function validateVaultSessionKey(value: unknown): value is string {
  try { decode(value, 32, 32); return true; } catch { return false; }
}
export async function decryptKeyVault(value: unknown, sessionKey: string): Promise<VaultCredentials> {
  const vault = parseEncryptedKeyVault(value);
  let plaintext: Uint8Array | undefined;
  try {
    const key = await importSessionKey(sessionKey);
    plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(vault.cipher.iv, 12, 12),
      additionalData: aad(vault.savedProviders, vault.kdf.salt), tagLength: 128 }, key, decode(vault.ciphertext, 16, MAX_CIPHERTEXT_BYTES)));
    const payload: unknown = JSON.parse(decoder.decode(plaintext));
    if (!record(payload) || !exact(payload, ['version', 'credentials']) || payload.version !== 1) throw invalid();
    const credentials = validateVaultCredentials(payload.credentials);
    if (sortedProviders(credentials).join(',') !== vault.savedProviders.join(',')) throw invalid();
    return credentials;
  } catch { throw invalid(); }
  finally { plaintext?.fill(0); }
}
async function encrypt(credentials: VaultCredentials, salt: string, sessionKey: string): Promise<EncryptedKeyVault> {
  const normalized = validateVaultCredentials(credentials);
  const providers = sortedProviders(normalized);
  const bytes = encoder.encode(JSON.stringify({ version: 1, credentials: normalized }));
  if (bytes.length + 16 > MAX_CIPHERTEXT_BYTES) throw invalid();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  try {
    const key = await importSessionKey(sessionKey);
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv,
      additionalData: aad(providers, salt), tagLength: 128 }, key, bytes));
    return { version: 1, kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS, salt },
      cipher: { name: 'AES-GCM', iv: encode(iv), tagLength: 128 }, savedProviders: providers, ciphertext: encode(ciphertext) };
  } finally { bytes.fill(0); }
}
export async function createEncryptedKeyVault(passphrase: string, credentials: VaultCredentials) {
  validateVaultPassphrase(passphrase);
  const salt = encode(crypto.getRandomValues(new Uint8Array(16)));
  const sessionKey = await derive(passphrase, salt);
  const vault = await encrypt(credentials, salt, sessionKey);
  // Authenticate and validate what will be persisted before any legacy deletion.
  await decryptKeyVault(vault, sessionKey);
  return { vault, sessionKey };
}
export async function unlockEncryptedKeyVault(value: unknown, passphrase: string) {
  validateVaultPassphrase(passphrase);
  const vault = parseEncryptedKeyVault(value);
  try {
    const sessionKey = await derive(passphrase, vault.kdf.salt);
    return { vault, sessionKey, credentials: await decryptKeyVault(vault, sessionKey) };
  } catch { throw new KeyVaultError('口令不正确，或密钥库数据已损坏。原有数据未删除。'); }
}
export async function updateEncryptedKeyVault(value: unknown, sessionKey: string, credentials: VaultCredentials) {
  const previous = parseEncryptedKeyVault(value);
  // A stale or forged session must never replace a vault it cannot authenticate.
  await decryptKeyVault(previous, sessionKey);
  const vault = await encrypt(credentials, previous.kdf.salt, sessionKey);
  await decryptKeyVault(vault, sessionKey);
  return vault;
}

export function legacyCredential(value: unknown, provider: ProviderId): { baseUrl: string; apiKey: string } | undefined {
  if (!record(value) || !Object.hasOwn(value, 'apiKey') || value.apiKey === '' || value.apiKey === undefined) return;
  if (typeof value.apiKey !== 'string' || value.apiKey.length > 4096 || CONTROLS.test(value.apiKey)) {
    throw new KeyVaultError('已有 API Key 格式无效，尚未迁移或删除。请先检查原配置。');
  }
  const apiKey = value.apiKey.trim();
  if (!apiKey) return;
  let baseUrl: string;
  try { baseUrl = normalizeBaseUrl(value.baseUrl === undefined ? getProvider(provider).baseUrl : value.baseUrl as string); }
  catch { throw new KeyVaultError('已有 API Key 的服务地址无效，尚未迁移或删除。请先检查原配置。'); }
  return { baseUrl, apiKey };
}
