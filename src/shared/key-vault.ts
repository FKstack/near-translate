import type { ProviderId } from './contracts';

export interface KeyVaultStatus {
  configured: boolean;
  locked: boolean;
  migrationRequired: boolean;
  savedProviders: ProviderId[];
}

export interface VaultCredential { baseUrl: string; apiKey: string }
export type VaultCredentials = Partial<Record<ProviderId, VaultCredential>>;
export interface EncryptedKeyVault {
  version: 1;
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: 600000; salt: string };
  cipher: { name: 'AES-GCM'; iv: string; tagLength: 128 };
  savedProviders: ProviderId[];
  ciphertext: string;
}

export const KEY_VAULT_STORAGE_KEY = 'key-vault:v1';
export const KEY_VAULT_SESSION_KEY = 'key-vault-session:v1';
export const KEY_VAULT_MIN_PASSPHRASE = 12;
export const KEY_VAULT_MAX_PASSPHRASE = 128;
