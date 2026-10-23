import { browser } from 'wxt/browser';
import type { ApiProfile, ConnectionSettings, EditableSettings, ProviderId, PublicApiProfile, PublicSettings, StoredSettings } from '@/shared/contracts';
import { apiOriginPattern, getProvider, isProviderId, normalizeBaseUrl, PROVIDERS } from '@/shared/api-config';
import { DEEPL_WEB_ORIGIN, DEEPL_WEB_PREPARATION_PERMISSION, isTranslationEngine, normalizeTranslationEngine } from '@/shared/translation-engine';
import { readLanguagePair, resolveLanguagePair, supportsSentenceAnalysis } from '@/shared/languages';
import { KEY_VAULT_SESSION_KEY, KEY_VAULT_STORAGE_KEY, type EncryptedKeyVault, type KeyVaultStatus, type VaultCredentials } from '@/shared/key-vault';
import { createEncryptedKeyVault, decryptKeyVault, KeyVaultError, legacyCredential, parseEncryptedKeyVault,
  unlockEncryptedKeyVault, updateEncryptedKeyVault, validateVaultPassphrase, validateVaultSessionKey } from './key-vault';

const STORAGE_KEY = 'settings:v1';
export const WEB_ORIGINS = ['http://*/*', 'https://*/*'];
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const MODEL_NAME = /^[a-zA-Z0-9._:/-]{1,200}$/;
let accessReady: Promise<void> | undefined;
let saveQueue = Promise.resolve();

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const failure = (message: string) => new KeyVaultError(message);
async function guarded<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) { throw error instanceof KeyVaultError ? error : failure('密钥库操作失败，已有数据未被主动删除。请重试。'); }
}
/** One writer owns settings, credential mutations, locking and migrations. */
function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = saveQueue.then(() => guarded(operation));
  saveQueue = result.then(() => undefined, () => undefined);
  return result;
}
function defaultProfile(provider: ProviderId): ApiProfile {
  const preset = getProvider(provider);
  return { model: preset.model, baseUrl: preset.baseUrl, jsonMode: preset.jsonMode, apiKey: '' };
}
function readProfile(value: unknown, provider: ProviderId): ApiProfile {
  const defaults = defaultProfile(provider);
  if (!record(value)) return defaults;
  let baseUrl = defaults.baseUrl;
  if (value.baseUrl !== undefined) {
    if (typeof value.baseUrl !== 'string') return defaults;
    try { baseUrl = normalizeBaseUrl(value.baseUrl); } catch { return defaults; }
  }
  const model = typeof value.model === 'string' && !CONTROL_CHARACTERS.test(value.model) && MODEL_NAME.test(value.model.trim())
    ? value.model.trim() : defaults.model;
  return { model, baseUrl, apiKey: '', jsonMode: typeof value.jsonMode === 'boolean' ? value.jsonMode : defaults.jsonMode };
}
export function restrictStorageAccess(): Promise<void> {
  if (!accessReady) accessReady = guarded(async () => {
    await browser.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    await browser.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  }).catch(error => { accessReady = undefined; throw error; });
  return accessReady;
}
function hasLegacyCredential(value: unknown): boolean {
  return record(value) && Object.hasOwn(value, 'apiKey') && value.apiKey !== '' && value.apiKey !== undefined;
}
function legacyProviders(raw: Record<string, unknown>): ProviderId[] {
  const ids = new Set<ProviderId>();
  if (hasLegacyCredential(raw) && (raw.provider === undefined || isProviderId(raw.provider))) ids.add(raw.provider ?? 'deepseek');
  if (record(raw.profiles)) for (const preset of PROVIDERS) if (hasLegacyCredential(raw.profiles[preset.id])) ids.add(preset.id);
  return PROVIDERS.filter(preset => ids.has(preset.id)).map(preset => preset.id);
}
function hasLegacySecrets(raw: Record<string, unknown>): boolean {
  return hasLegacyCredential(raw) || (record(raw.profiles) && Object.values(raw.profiles).some(hasLegacyCredential));
}
function collectLegacy(raw: Record<string, unknown>): VaultCredentials {
  const credentials: VaultCredentials = {};
  const add = (provider: ProviderId, value: unknown) => {
    const credential = legacyCredential(value, provider);
    if (!credential) return;
    const previous = credentials[provider];
    if (previous && (previous.apiKey !== credential.apiKey || previous.baseUrl !== credential.baseUrl)) {
      throw failure('同一服务的旧凭证记录不一致，尚未迁移或删除。请先核对原配置。');
    }
    credentials[provider] = credential;
  };
  if (record(raw.profiles)) for (const [id, profile] of Object.entries(raw.profiles)) {
    if (isProviderId(id)) add(id, profile);
    else if (hasLegacyCredential(profile)) throw failure('旧配置包含未知服务的凭证，尚未迁移或删除。请先核对原配置。');
  }
  if (raw.provider === undefined || isProviderId(raw.provider)) add(raw.provider ?? 'deepseek', raw);
  else if (hasLegacyCredential(raw)) throw failure('旧配置的服务类型无效，尚未迁移或删除。请先核对原配置。');
  return credentials;
}
interface State {
  raw: Record<string, unknown>; fresh: boolean; vault?: EncryptedKeyVault; sessionKey?: string;
  credentials: VaultCredentials; migrationRequired: boolean; legacyProviders: ProviderId[];
}
async function loadState(): Promise<State> {
  await restrictStorageAccess();
  const [saved, encrypted] = await Promise.all([browser.storage.local.get(STORAGE_KEY), browser.storage.local.get(KEY_VAULT_STORAGE_KEY)]);
  const raw = record(saved[STORAGE_KEY]) ? saved[STORAGE_KEY] as Record<string, unknown> : {};
  const state: State = { raw, fresh: saved[STORAGE_KEY] === undefined, credentials: {},
    migrationRequired: hasLegacySecrets(raw), legacyProviders: legacyProviders(raw) };
  if (encrypted[KEY_VAULT_STORAGE_KEY] === undefined) return state;
  state.vault = parseEncryptedKeyVault(encrypted[KEY_VAULT_STORAGE_KEY]);
  const session = (await browser.storage.session.get(KEY_VAULT_SESSION_KEY))[KEY_VAULT_SESSION_KEY] as unknown;
  if (!record(session) || Object.keys(session).length !== 3 || session.version !== 1
    || session.salt !== state.vault.kdf.salt || !validateVaultSessionKey(session.key)) return state;
  try {
    state.credentials = await decryptKeyVault(state.vault, session.key);
    state.sessionKey = session.key;
  } catch { /* Stale or forged session state is locked; unauthenticated data is never used. */ }
  return state;
}
function status(state: State): KeyVaultStatus {
  const ids = new Set([...(state.vault?.savedProviders ?? []), ...state.legacyProviders]);
  return { configured: Boolean(state.vault), locked: state.vault ? !state.sessionKey : state.migrationRequired,
    migrationRequired: state.migrationRequired, savedProviders: PROVIDERS.filter(preset => ids.has(preset.id)).map(preset => preset.id) };
}
function runtimeSettings(state: State): StoredSettings {
  const saved = state.raw;
  const provider = isProviderId(saved.provider) ? saved.provider : 'deepseek';
  const profiles: Partial<Record<ProviderId, ApiProfile>> = {};
  if (record(saved.profiles)) for (const preset of PROVIDERS) {
    if (Object.hasOwn(saved.profiles, preset.id)) profiles[preset.id] = readProfile(saved.profiles[preset.id], preset.id);
  }
  const active = saved.provider !== undefined && !isProviderId(saved.provider) ? defaultProfile(provider) : readProfile(saved, provider);
  profiles[provider] = active;
  for (const preset of PROVIDERS) {
    const profile = profiles[preset.id]; const credential = state.credentials[preset.id];
    if (profile && credential?.baseUrl === profile.baseUrl && !state.migrationRequired) profile.apiKey = credential.apiKey;
  }
  const vault = status(state);
  return { schemaVersion: 2, translationEngine: state.fresh ? 'deepl-web' : normalizeTranslationEngine(saved.translationEngine),
    ...readLanguagePair(saved),
    connectionRevision: typeof saved.connectionRevision === 'number' && Number.isSafeInteger(saved.connectionRevision) && saved.connectionRevision >= 0
      ? saved.connectionRevision : 0,
    enabled: typeof saved.enabled === 'boolean' ? saved.enabled : true,
    includeContext: typeof saved.includeContext === 'boolean' ? saved.includeContext : true,
    sentenceAnalysisEnabled: typeof saved.sentenceAnalysisEnabled === 'boolean' ? saved.sentenceAnalysisEnabled : true,
    provider, ...active, profiles,
    keyVaultLocked: !active.apiKey && vault.savedProviders.includes(provider) && (vault.locked || vault.migrationRequired) };
}
/** Explicit disk projection: never spread a decrypted runtime object into storage. */
function persistentSettings(settings: StoredSettings): Record<string, unknown> {
  const profiles: Partial<Record<ProviderId, Omit<ApiProfile, 'apiKey'>>> = {};
  for (const preset of PROVIDERS) {
    const profile = settings.profiles[preset.id];
    if (profile) profiles[preset.id] = { model: profile.model, baseUrl: profile.baseUrl, jsonMode: profile.jsonMode };
  }
  return { schemaVersion: 3, translationEngine: settings.translationEngine,
    sourceLanguage: settings.sourceLanguage, targetLanguage: settings.targetLanguage,
    connectionRevision: settings.connectionRevision, enabled: settings.enabled, includeContext: settings.includeContext,
    sentenceAnalysisEnabled: settings.sentenceAnalysisEnabled, provider: settings.provider, model: settings.model,
    baseUrl: settings.baseUrl, jsonMode: settings.jsonMode, profiles };
}
function nextRevision(settings: StoredSettings): number {
  if (settings.connectionRevision >= Number.MAX_SAFE_INTEGER) throw failure('设置版本已达到安全上限，请先备份非敏感配置并联系项目维护者。');
  return settings.connectionRevision + 1;
}
async function projectPublicSettings(settings: StoredSettings): Promise<PublicSettings> {
  const deepl = settings.translationEngine === 'deepl-web';
  const [webAccess, apiAccess] = await Promise.all([browser.permissions.contains({ origins: WEB_ORIGINS }),
    browser.permissions.contains(deepl ? { origins: [DEEPL_WEB_ORIGIN] } : { origins: [apiOriginPattern(settings.baseUrl)] })]);
  return { translationEngine: settings.translationEngine, ...readLanguagePair(settings), enabled: settings.enabled,
    includeContext: !deepl && settings.includeContext,
    sentenceAnalysisEnabled: !deepl && settings.sentenceAnalysisEnabled && supportsSentenceAnalysis(settings),
    model: settings.model, provider: settings.provider, connectionRevision: settings.connectionRevision,
    hasApiKey: Boolean(settings.apiKey), keyVaultLocked: !deepl && settings.keyVaultLocked,
    requiresApiKey: !deepl && getProvider(settings.provider).requiresApiKey, webAccess, apiAccess };
}
export async function readSettings(): Promise<StoredSettings> {
  await saveQueue;
  return guarded(async () => runtimeSettings(await loadState()));
}
export async function publicSettings(): Promise<PublicSettings> { return projectPublicSettings(await readSettings()); }
/** Trusted options see saved/locked markers, never credentials or ciphertext. */
export async function connectionSettings(): Promise<ConnectionSettings> {
  await saveQueue;
  return guarded(async () => {
    const state = await loadState(); const settings = runtimeSettings(state); const vault = status(state);
    const profiles: Partial<Record<ProviderId, PublicApiProfile>> = {};
    for (const preset of PROVIDERS) {
      const profile = settings.profiles[preset.id];
      if (profile) profiles[preset.id] = { model: profile.model, baseUrl: profile.baseUrl, jsonMode: profile.jsonMode,
        hasApiKey: Boolean(profile.apiKey) || ((vault.locked || vault.migrationRequired) && vault.savedProviders.includes(preset.id)) };
    }
    return { ...await projectPublicSettings(settings),
      networkPreparationAccess: await browser.permissions.contains({ permissions: [DEEPL_WEB_PREPARATION_PERMISSION] }),
      includeContext: settings.includeContext, sentenceAnalysisEnabled: settings.sentenceAnalysisEnabled,
      provider: settings.provider, baseUrl: settings.baseUrl, jsonMode: settings.jsonMode, profiles, vault };
  });
}
export async function keyVaultStatus(): Promise<KeyVaultStatus> {
  await saveQueue;
  return guarded(async () => status(await loadState()));
}
function sameCredentials(left: VaultCredentials, right: VaultCredentials): boolean {
  return PROVIDERS.every(({ id }) => left[id]?.baseUrl === right[id]?.baseUrl && left[id]?.apiKey === right[id]?.apiKey);
}
async function persistVerifiedVault(vault: EncryptedKeyVault, sessionKey: string, credentials: VaultCredentials,
  previous?: EncryptedKeyVault): Promise<void> {
  try {
    await browser.storage.local.set({ [KEY_VAULT_STORAGE_KEY]: vault });
    const saved = (await browser.storage.local.get(KEY_VAULT_STORAGE_KEY))[KEY_VAULT_STORAGE_KEY] as unknown;
    if (!sameCredentials(await decryptKeyVault(saved, sessionKey), credentials)) throw failure('密钥库保存验证失败，原有配置尚未清理。');
  } catch {
    // Roll back only encrypted state. Never restore a plaintext credential backup.
    try {
      if (previous) await browser.storage.local.set({ [KEY_VAULT_STORAGE_KEY]: previous });
      else await browser.storage.local.remove(KEY_VAULT_STORAGE_KEY);
    } catch { throw failure('密钥库保存验证失败，原有配置尚未清理。请勿重置，稍后重试。'); }
    throw failure('密钥库保存验证失败，原有配置尚未清理。请重试。');
  }
}
async function saveSession(vault: EncryptedKeyVault, sessionKey: string): Promise<void> {
  await browser.storage.session.set({ [KEY_VAULT_SESSION_KEY]: { version: 1, salt: vault.kdf.salt, key: sessionKey } });
}
async function persistCleanSettings(settings: StoredSettings): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEY]: persistentSettings(settings) });
  const saved = (await browser.storage.local.get(STORAGE_KEY))[STORAGE_KEY] as unknown;
  if (!record(saved) || saved.schemaVersion !== 3 || Object.hasOwn(saved, 'apiKey')
    || (record(saved.profiles) && Object.values(saved.profiles).some(profile => record(profile) && Object.hasOwn(profile, 'apiKey')))) {
    throw failure('加密密钥库已保存，但旧配置清理尚未确认。请重新解锁完成迁移。');
  }
}
function verifyLegacyIncluded(state: State, credentials: VaultCredentials): void {
  for (const [id, old] of Object.entries(collectLegacy(state.raw))) {
    const saved = credentials[id as ProviderId];
    if (!saved || saved.baseUrl !== old!.baseUrl || saved.apiKey !== old!.apiKey) {
      throw failure('旧凭证与已保存密钥库不一致，原有数据未清理。请先核对原配置。');
    }
  }
}
export function createKeyVault(passphrase: string): Promise<KeyVaultStatus> {
  return serialize(async () => {
    validateVaultPassphrase(passphrase); const state = await loadState();
    if (state.vault) throw failure('密钥库已经创建，请使用现有口令解锁。');
    const credentials = collectLegacy(state.raw);
    const settings = runtimeSettings(state); settings.connectionRevision = nextRevision(settings);
    const { vault, sessionKey } = await createEncryptedKeyVault(passphrase, credentials);
    await persistVerifiedVault(vault, sessionKey, credentials);
    await persistCleanSettings(settings);
    await saveSession(vault, sessionKey);
    return status(await loadState());
  });
}
export function unlockKeyVault(passphrase: string): Promise<KeyVaultStatus> {
  return serialize(async () => {
    validateVaultPassphrase(passphrase); const state = await loadState();
    if (!state.vault) throw failure('请先设置解锁口令并创建密钥库。');
    const { sessionKey, credentials } = await unlockEncryptedKeyVault(state.vault, passphrase);
    verifyLegacyIncluded(state, credentials);
    const settings = runtimeSettings(state); settings.connectionRevision = nextRevision(settings);
    await persistCleanSettings(settings);
    await saveSession(state.vault, sessionKey);
    return status(await loadState());
  });
}
export function lockKeyVault(): Promise<KeyVaultStatus> {
  return serialize(async () => {
    const state = await loadState(); await browser.storage.session.remove(KEY_VAULT_SESSION_KEY);
    if (state.sessionKey) {
      const settings = runtimeSettings(state);
      const stored = state.migrationRequired ? { ...state.raw, connectionRevision: nextRevision(settings) }
        : persistentSettings({ ...settings, connectionRevision: nextRevision(settings) });
      await browser.storage.local.set({ [STORAGE_KEY]: stored });
    }
    return status(await loadState());
  });
}
export function changeKeyVaultPassphrase(currentPassphrase: string, newPassphrase: string): Promise<KeyVaultStatus> {
  return serialize(async () => {
    validateVaultPassphrase(currentPassphrase); validateVaultPassphrase(newPassphrase);
    const state = await loadState();
    if (!state.vault) throw failure('请先设置解锁口令并创建密钥库。');
    const { credentials } = await unlockEncryptedKeyVault(state.vault, currentPassphrase);
    verifyLegacyIncluded(state, credentials);
    const settings = runtimeSettings(state); settings.connectionRevision = nextRevision(settings);
    const { vault, sessionKey } = await createEncryptedKeyVault(newPassphrase, credentials);
    await persistVerifiedVault(vault, sessionKey, credentials, state.vault);
    try {
      await persistCleanSettings(settings);
      await saveSession(vault, sessionKey);
    }
    catch { throw failure('新口令已生效，但当前会话尚未解锁。请用新口令重新解锁。'); }
    return status(await loadState());
  });
}
export function saveSettings(value: unknown, keepExistingKey: boolean): Promise<void> {
  return serialize(() => saveSettingsNow(value, keepExistingKey));
}
export function enableFreeTranslation(): Promise<void> {
  return serialize(async () => {
    const previous = runtimeSettings(await loadState());
    await saveSettingsNow({ ...previous, translationEngine: 'deepl-web', enabled: true, apiKey: '' }, true);
  });
}
async function saveSettingsNow(value: unknown, keepExistingKey: boolean): Promise<void> {
  if (!record(value)) throw failure('设置格式不正确。');
  const input = value as Partial<EditableSettings>;
  if (typeof input.enabled !== 'boolean' || typeof input.includeContext !== 'boolean' || typeof input.model !== 'string' || typeof input.apiKey !== 'string') throw failure('设置格式不正确。');
  if (input.sentenceAnalysisEnabled !== undefined && typeof input.sentenceAnalysisEnabled !== 'boolean') throw failure('长难句拆解设置格式不正确。');
  if (input.translationEngine !== undefined && !isTranslationEngine(input.translationEngine)) throw failure('请选择有效的翻译方式。');
  const state = await loadState(); const previous = runtimeSettings(state);
  let languages;
  try { languages = resolveLanguagePair({ sourceLanguage: input.sourceLanguage === undefined ? previous.sourceLanguage : input.sourceLanguage,
    targetLanguage: input.targetLanguage === undefined ? previous.targetLanguage : input.targetLanguage }); }
  catch { throw failure('请选择有效的翻译语言。'); }
  const languageChanged = languages.sourceLanguage !== previous.sourceLanguage || languages.targetLanguage !== previous.targetLanguage;
  const translationEngine = input.translationEngine ?? previous.translationEngine;
  if (translationEngine === 'deepl-web') {
    const updated = { ...previous, translationEngine, ...languages,
      connectionRevision: translationEngine !== previous.translationEngine || languageChanged ? nextRevision(previous) : previous.connectionRevision,
      enabled: input.enabled, includeContext: input.includeContext,
      sentenceAnalysisEnabled: input.sentenceAnalysisEnabled ?? previous.sentenceAnalysisEnabled };
    // Pre-migration only: preserve old keys in place until authenticated ciphertext
    // has been verified. A hidden model form must never erase them.
    const saved = state.migrationRequired ? { ...state.raw, translationEngine, ...languages,
      connectionRevision: updated.connectionRevision, enabled: updated.enabled, includeContext: updated.includeContext,
      sentenceAnalysisEnabled: updated.sentenceAnalysisEnabled } : persistentSettings(updated);
    await browser.storage.local.set({ [STORAGE_KEY]: saved });
    return;
  }
  if (state.migrationRequired) throw failure('请先设置或输入解锁口令，完成已有 API Key 的安全迁移。');
  if (input.provider !== undefined && !isProviderId(input.provider)) throw failure('请选择有效的 API 服务商。');
  if (input.baseUrl !== undefined && typeof input.baseUrl !== 'string') throw failure('API 地址格式不正确。');
  if (input.jsonMode !== undefined && typeof input.jsonMode !== 'boolean') throw failure('JSON 模式设置格式不正确。');
  const model = input.model.trim();
  if (CONTROL_CHARACTERS.test(input.model) || !MODEL_NAME.test(model)) throw failure('请填写有效的模型名。');
  if (input.apiKey.length > 4096) throw failure('API Key 太长，请检查输入。');
  if (CONTROL_CHARACTERS.test(input.apiKey)) throw failure('API Key 不能包含换行或控制字符。');
  const provider = input.provider ?? previous.provider; const target = previous.profiles[provider] ?? defaultProfile(provider);
  let baseUrl: string;
  try { baseUrl = normalizeBaseUrl(input.baseUrl ?? target.baseUrl); }
  catch { throw failure('请填写有效的 HTTPS API 地址；HTTP 仅支持本机回环地址。'); }
  const suppliedKey = input.apiKey.trim();
  const removesBoundKey = state.vault?.savedProviders.includes(provider) && baseUrl !== target.baseUrl;
  const changesCredential = Boolean(suppliedKey) || !keepExistingKey || removesBoundKey;
  if (changesCredential && (!state.vault || !state.sessionKey)) throw failure(state.vault
    ? '密钥库已锁定，请先解锁，再保存、删除或更改 API Key 的服务地址。' : '请先设置解锁口令，创建密钥库后再保存 API Key。');
  const credentials = { ...state.credentials };
  if (suppliedKey) credentials[provider] = { baseUrl, apiKey: suppliedKey };
  else if (!keepExistingKey || baseUrl !== target.baseUrl) delete credentials[provider];
  const profile: ApiProfile = { model, baseUrl, jsonMode: input.jsonMode ?? target.jsonMode,
    apiKey: credentials[provider]?.baseUrl === baseUrl ? credentials[provider]!.apiKey : '' };
  const connectionChanged = languageChanged || translationEngine !== previous.translationEngine || provider !== previous.provider
    || profile.model !== previous.model || profile.apiKey !== previous.apiKey || profile.baseUrl !== previous.baseUrl || profile.jsonMode !== previous.jsonMode;
  const updated: StoredSettings = { schemaVersion: 2, translationEngine, ...languages,
    connectionRevision: connectionChanged ? nextRevision(previous) : previous.connectionRevision,
    enabled: input.enabled, includeContext: input.includeContext,
    sentenceAnalysisEnabled: input.sentenceAnalysisEnabled ?? previous.sentenceAnalysisEnabled,
    provider, ...profile, profiles: { ...previous.profiles, [provider]: profile } };
  const writes: Record<string, unknown> = { [STORAGE_KEY]: persistentSettings(updated) };
  if (!sameCredentials(credentials, state.credentials)) writes[KEY_VAULT_STORAGE_KEY] = await updateEncryptedKeyVault(state.vault, state.sessionKey!, credentials);
  await browser.storage.local.set(writes);
}
