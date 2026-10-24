import { browser } from 'wxt/browser';
import type { ApiProfile, ConnectionSettings, EditableSettings, ProviderId, PublicApiProfile, PublicSettings, StoredSettings } from '../shared/contracts';
import { apiOriginPattern, getProvider, isProviderId, normalizeBaseUrl, PROVIDERS } from '../shared/api-config';
import { DEEPL_WEB_ORIGIN, DEEPL_WEB_PREPARATION_PERMISSION, isTranslationEngine, normalizeTranslationEngine } from '../shared/translation-engine';
import { readLanguagePair, resolveLanguagePair, supportsSentenceAnalysis } from '../shared/languages';
import { KEY_VAULT_STORAGE_KEY, type VaultCredentials } from '../shared/key-vault';
import { KeyVaultError, legacyCredential, parseEncryptedKeyVault, unlockEncryptedKeyVault, validateVaultCredentials } from './key-vault';

export const CONNECTION_SETTINGS_KEY = 'connection-settings:v2';
/** Compatibility name for the userscript's storage observer. */
export const USERSCRIPT_SETTINGS_KEY = CONNECTION_SETTINGS_KEY;
export const LEGACY_SETTINGS_KEY = 'settings:v1';
export const WEB_ORIGINS = ['http://*/*', 'https://*/*'];
const CONTROLS = /[\u0000-\u001f\u007f]/;
const MODEL_NAME = /^[a-zA-Z0-9._:/-]{1,200}$/;
let accessReady: Promise<void> | undefined;
let saveQueue = Promise.resolve();

export type ConnectionSettingsView = ConnectionSettings & {
  apiKeyMigrationRequired: boolean;
  legacyKeyProviders: ProviderId[];
  legacyKeyMigrationAvailable: boolean;
};
export type UserscriptConnectionSettings = ConnectionSettingsView;
interface SavedConnection {
  version: 1;
  settings: Record<string, unknown>;
  credentials: VaultCredentials;
  handledLegacyProviders: ProviderId[];
}
interface State {
  raw: Record<string, unknown>;
  fresh: boolean;
  credentials: VaultCredentials;
  handled: Set<ProviderId>;
  legacyRaw: Record<string, unknown>;
  legacyVault: unknown;
  legacyProviders: ProviderId[];
  legacyCorrupt: boolean;
}
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
const failure = (message: string) => new KeyVaultError(message);
async function guarded<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) { throw error instanceof KeyVaultError ? error : failure('本地配置操作失败，请重试。旧版数据仍保留。'); }
}
function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const next = saveQueue.then(() => guarded(operation));
  saveQueue = next.then(() => undefined, () => undefined);
  return next;
}
export function restrictStorageAccess(): Promise<void> {
  return accessReady ??= guarded(async () => {
    await browser.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    await browser.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  }).catch(error => { accessReady = undefined; throw error; });
}
function defaultProfile(provider: ProviderId): ApiProfile {
  const preset = getProvider(provider);
  return { baseUrl: preset.baseUrl, model: preset.model, jsonMode: preset.jsonMode, apiKey: '' };
}
function profileOf(value: unknown, provider: ProviderId): ApiProfile {
  const defaults = defaultProfile(provider);
  if (!record(value)) return defaults;
  let baseUrl = defaults.baseUrl;
  try { if (typeof value.baseUrl === 'string') baseUrl = normalizeBaseUrl(value.baseUrl); } catch { return defaults; }
  return { baseUrl, model: typeof value.model === 'string' && MODEL_NAME.test(value.model.trim()) && !CONTROLS.test(value.model)
    ? value.model.trim() : defaults.model,
  jsonMode: typeof value.jsonMode === 'boolean' ? value.jsonMode : defaults.jsonMode, apiKey: '' };
}
function plaintextLegacyProviders(raw: Record<string, unknown>): ProviderId[] {
  const providers = new Set<ProviderId>();
  const hasKey = (value: unknown) => record(value) && typeof value.apiKey === 'string' && value.apiKey.trim().length > 0;
  if (hasKey(raw) && (raw.provider === undefined || isProviderId(raw.provider))) providers.add(raw.provider ?? 'deepseek');
  if (record(raw.profiles)) for (const preset of PROVIDERS) if (hasKey(raw.profiles[preset.id])) providers.add(preset.id);
  return [...providers];
}
async function loadState(): Promise<State> {
  await restrictStorageAccess();
  const data = await browser.storage.local.get([CONNECTION_SETTINGS_KEY, LEGACY_SETTINGS_KEY, KEY_VAULT_STORAGE_KEY]);
  const legacyRaw = record(data[LEGACY_SETTINGS_KEY]) ? data[LEGACY_SETTINGS_KEY] as Record<string, unknown> : {};
  const stored = data[CONNECTION_SETTINGS_KEY];
  let raw = legacyRaw;
  let credentials: VaultCredentials = {};
  let handled: ProviderId[] = [];
  if (stored !== undefined) {
    if (!record(stored) || stored.version !== 1 || !record(stored.settings) || !Array.isArray(stored.handledLegacyProviders)
      || stored.handledLegacyProviders.some(id => !isProviderId(id)) || new Set(stored.handledLegacyProviders).size !== stored.handledLegacyProviders.length) {
      throw failure('本地翻译配置格式无法识别，原有数据未删除。请更新近译后重试。');
    }
    try { credentials = validateVaultCredentials(stored.credentials); }
    catch { throw failure('本地 API Key 记录格式无法识别，原有数据未删除。请联系维护者恢复配置。'); }
    raw = stored.settings;
    handled = stored.handledLegacyProviders as ProviderId[];
  }
  const legacyVault = data[KEY_VAULT_STORAGE_KEY];
  const handledSet = new Set(handled);
  // Early versions already used private local storage without a password.
  // Valid, consistent plaintext can be read immediately; a later trusted save
  // copies it into the new record. Article reads never mutate either record.
  if (legacyVault === undefined) {
    try {
      for (const [id, credential] of Object.entries(collectPlaintextLegacy(legacyRaw))) {
        const provider = id as ProviderId;
        if (!handledSet.has(provider) && !credentials[provider]) credentials[provider] = credential;
      }
    } catch { /* Keep conflicting or malformed old records; users can re-enter a Key. */ }
  }
  let encryptedProviders: ProviderId[] = [];
  let legacyCorrupt = false;
  if (legacyVault !== undefined) {
    try { encryptedProviders = parseEncryptedKeyVault(legacyVault).savedProviders; }
    catch {
      legacyCorrupt = true;
      if (record(legacyVault) && Array.isArray(legacyVault.savedProviders)) encryptedProviders = legacyVault.savedProviders.filter(isProviderId);
    }
  }
  const pending = new Set([...plaintextLegacyProviders(legacyRaw), ...encryptedProviders]);
  const legacyProviders = PROVIDERS.filter(({ id }) => pending.has(id) && !handledSet.has(id) && !credentials[id]).map(({ id }) => id);
  return { raw, fresh: stored === undefined && data[LEGACY_SETTINGS_KEY] === undefined, credentials, handled: handledSet,
    legacyRaw, legacyVault, legacyProviders, legacyCorrupt };
}
function runtimeSettings(state: State): StoredSettings {
  const raw = state.raw;
  const provider = isProviderId(raw.provider) ? raw.provider : 'deepseek';
  const profiles: Partial<Record<ProviderId, ApiProfile>> = {};
  if (record(raw.profiles)) for (const preset of PROVIDERS) if (Object.hasOwn(raw.profiles, preset.id)) profiles[preset.id] = profileOf(raw.profiles[preset.id], preset.id);
  profiles[provider] = profileOf(raw, provider);
  for (const preset of PROVIDERS) {
    const profile = profiles[preset.id], credential = state.credentials[preset.id];
    if (profile && credential?.baseUrl === profile.baseUrl) profile.apiKey = credential.apiKey;
  }
  const translationEngine = state.fresh ? 'deepl-web' : normalizeTranslationEngine(raw.translationEngine);
  return { schemaVersion: 2, translationEngine,
    ...readLanguagePair(raw), connectionRevision: typeof raw.connectionRevision === 'number' && Number.isSafeInteger(raw.connectionRevision) && raw.connectionRevision >= 0 ? raw.connectionRevision : 0,
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
    includeContext: typeof raw.includeContext === 'boolean' ? raw.includeContext : true,
    sentenceAnalysisEnabled: typeof raw.sentenceAnalysisEnabled === 'boolean' ? raw.sentenceAnalysisEnabled : true,
    provider, ...profiles[provider]!, profiles, keyVaultLocked: false,
    apiKeyMigrationRequired: translationEngine !== 'deepl-web' && !profiles[provider]!.apiKey && state.legacyProviders.includes(provider) };
}
function persistentSettings(settings: StoredSettings): Record<string, unknown> {
  const profiles: Partial<Record<ProviderId, Omit<ApiProfile, 'apiKey'>>> = {};
  for (const preset of PROVIDERS) {
    const profile = settings.profiles[preset.id];
    if (profile) profiles[preset.id] = { model: profile.model, baseUrl: profile.baseUrl, jsonMode: profile.jsonMode };
  }
  return { schemaVersion: 4, translationEngine: settings.translationEngine, ...readLanguagePair(settings),
    connectionRevision: settings.connectionRevision, enabled: settings.enabled, includeContext: settings.includeContext,
    sentenceAnalysisEnabled: settings.sentenceAnalysisEnabled, provider: settings.provider, model: settings.model,
    baseUrl: settings.baseUrl, jsonMode: settings.jsonMode, profiles };
}
function nextRevision(settings: StoredSettings): number {
  if (settings.connectionRevision >= Number.MAX_SAFE_INTEGER) throw failure('配置版本已达到安全上限，请联系维护者。');
  return settings.connectionRevision + 1;
}
async function persist(state: State, settings: StoredSettings, credentials: VaultCredentials): Promise<void> {
  const saved: SavedConnection = { version: 1, settings: persistentSettings(settings), credentials,
    handledLegacyProviders: PROVIDERS.filter(({ id }) => state.handled.has(id)).map(({ id }) => id) };
  // One record owns the configuration and its endpoint-bound credentials. Old
  // settings and encrypted vaults are intentionally left untouched as recovery data.
  await browser.storage.local.set({ [CONNECTION_SETTINGS_KEY]: saved });
  const actual = (await browser.storage.local.get(CONNECTION_SETTINGS_KEY))[CONNECTION_SETTINGS_KEY];
  const ordered = (value: unknown): unknown => Array.isArray(value) ? value.map(ordered)
    : record(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
  if (JSON.stringify(ordered(actual)) !== JSON.stringify(ordered(saved))) throw failure('配置保存尚未确认，请重试。旧版数据仍保留。');
}
function migrationRequired(state: State, settings: StoredSettings): boolean {
  return settings.translationEngine !== 'deepl-web' && !settings.apiKey && state.legacyProviders.includes(settings.provider);
}
async function projectPublicSettings(state: State, settings: StoredSettings): Promise<PublicSettings> {
  const deepl = settings.translationEngine === 'deepl-web';
  const [webAccess, apiAccess] = await Promise.all([browser.permissions.contains({ origins: WEB_ORIGINS }),
    browser.permissions.contains(deepl ? { origins: [DEEPL_WEB_ORIGIN] } : { origins: [apiOriginPattern(settings.baseUrl)] })]);
  return { translationEngine: settings.translationEngine, ...readLanguagePair(settings), enabled: settings.enabled,
    includeContext: !deepl && settings.includeContext,
    sentenceAnalysisEnabled: !deepl && settings.sentenceAnalysisEnabled && supportsSentenceAnalysis(settings),
    model: settings.model, provider: settings.provider, connectionRevision: settings.connectionRevision,
    hasApiKey: Boolean(settings.apiKey), keyVaultLocked: false, apiKeyMigrationRequired: migrationRequired(state, settings),
    requiresApiKey: !deepl && getProvider(settings.provider).requiresApiKey, webAccess, apiAccess };
}
export async function readSettings(): Promise<StoredSettings> {
  await saveQueue;
  return guarded(async () => runtimeSettings(await loadState()));
}
export async function publicSettings(): Promise<PublicSettings> {
  await saveQueue;
  return guarded(async () => {
    const state = await loadState();
    return projectPublicSettings(state, runtimeSettings(state));
  });
}
export async function connectionSettings(): Promise<ConnectionSettingsView> {
  await saveQueue;
  return guarded(async () => {
    const state = await loadState(), settings = runtimeSettings(state);
    const profiles: Partial<Record<ProviderId, PublicApiProfile>> = {};
    for (const preset of PROVIDERS) {
      const profile = settings.profiles[preset.id];
      if (profile) profiles[preset.id] = { model: profile.model, baseUrl: profile.baseUrl, jsonMode: profile.jsonMode, hasApiKey: Boolean(profile.apiKey) };
    }
    return { ...await projectPublicSettings(state, settings), apiKeyMigrationRequired: migrationRequired(state, settings),
      networkPreparationAccess: await browser.permissions.contains({ permissions: [DEEPL_WEB_PREPARATION_PERMISSION] }),
      includeContext: settings.includeContext, sentenceAnalysisEnabled: settings.sentenceAnalysisEnabled,
      provider: settings.provider, baseUrl: settings.baseUrl, jsonMode: settings.jsonMode, profiles,
      legacyKeyProviders: state.legacyProviders, legacyKeyMigrationAvailable: state.legacyVault !== undefined && (state.legacyProviders.length > 0 || state.legacyCorrupt) };
  });
}
export function saveSettings(value: unknown, keepExistingKey = true): Promise<void> {
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
  if (typeof input.enabled !== 'boolean' || typeof input.includeContext !== 'boolean' || typeof input.model !== 'string' || typeof input.apiKey !== 'string'
    || (input.sentenceAnalysisEnabled !== undefined && typeof input.sentenceAnalysisEnabled !== 'boolean')) throw failure('设置格式不正确。');
  if (input.translationEngine !== undefined && !isTranslationEngine(input.translationEngine)) throw failure('请选择有效的翻译方式。');
  const state = await loadState(), previous = runtimeSettings(state);
  let languages;
  try { languages = resolveLanguagePair({ sourceLanguage: input.sourceLanguage === undefined ? previous.sourceLanguage : input.sourceLanguage,
    targetLanguage: input.targetLanguage === undefined ? previous.targetLanguage : input.targetLanguage }); }
  catch { throw failure('请选择有效的翻译语言。'); }
  const engine = input.translationEngine ?? previous.translationEngine;
  if (engine === 'deepl-web') {
    const updated = { ...previous, translationEngine: engine, ...languages, enabled: input.enabled,
      includeContext: input.includeContext, sentenceAnalysisEnabled: input.sentenceAnalysisEnabled ?? previous.sentenceAnalysisEnabled,
      connectionRevision: engine !== previous.translationEngine || languages.sourceLanguage !== previous.sourceLanguage || languages.targetLanguage !== previous.targetLanguage
        ? nextRevision(previous) : previous.connectionRevision };
    await persist(state, updated, state.credentials);
    return;
  }
  if (input.provider !== undefined && !isProviderId(input.provider)) throw failure('请选择有效的 API 服务商。');
  if (input.baseUrl !== undefined && typeof input.baseUrl !== 'string') throw failure('API 地址格式不正确。');
  if (input.jsonMode !== undefined && typeof input.jsonMode !== 'boolean') throw failure('JSON 模式设置格式不正确。');
  if (CONTROLS.test(input.model) || !MODEL_NAME.test(input.model.trim())) throw failure('请填写有效的模型名。');
  if (input.apiKey.length > 4096 || CONTROLS.test(input.apiKey)) throw failure('API Key 格式不正确，请检查长度和换行。');
  const provider = input.provider ?? previous.provider, target = previous.profiles[provider] ?? defaultProfile(provider);
  let baseUrl: string;
  try { baseUrl = normalizeBaseUrl(input.baseUrl ?? target.baseUrl); }
  catch { throw failure('请填写有效的 HTTPS API 地址；HTTP 仅支持本机回环地址。'); }
  const supplied = input.apiKey.trim(), credentials = { ...state.credentials };
  if (supplied) credentials[provider] = { baseUrl, apiKey: supplied };
  else if (!keepExistingKey || baseUrl !== target.baseUrl) delete credentials[provider];
  if (supplied || !keepExistingKey || baseUrl !== target.baseUrl) state.handled.add(provider);
  const profile: ApiProfile = { model: input.model.trim(), baseUrl, jsonMode: input.jsonMode ?? target.jsonMode,
    apiKey: credentials[provider]?.baseUrl === baseUrl ? credentials[provider]!.apiKey : '' };
  const connectionChanged = engine !== previous.translationEngine || languages.sourceLanguage !== previous.sourceLanguage || languages.targetLanguage !== previous.targetLanguage
    || provider !== previous.provider || profile.model !== previous.model || profile.baseUrl !== previous.baseUrl || profile.jsonMode !== previous.jsonMode || profile.apiKey !== previous.apiKey;
  await persist(state, { schemaVersion: 2, translationEngine: engine, ...languages,
    enabled: input.enabled, includeContext: input.includeContext, sentenceAnalysisEnabled: input.sentenceAnalysisEnabled ?? previous.sentenceAnalysisEnabled,
    connectionRevision: connectionChanged ? nextRevision(previous) : previous.connectionRevision, provider, ...profile, profiles: { ...previous.profiles, [provider]: profile }, keyVaultLocked: false }, credentials);
}
function collectPlaintextLegacy(raw: Record<string, unknown>): VaultCredentials {
  const credentials: VaultCredentials = {};
  const add = (provider: ProviderId, value: unknown) => {
    const credential = legacyCredential(value, provider);
    if (!credential) return;
    if (credentials[provider] && JSON.stringify(credentials[provider]) !== JSON.stringify(credential)) throw failure('同一服务的旧 Key 记录不一致，旧数据未更改。请重新填写此服务的 Key。');
    credentials[provider] = credential;
  };
  if (record(raw.profiles)) for (const [id, profile] of Object.entries(raw.profiles)) {
    if (isProviderId(id)) add(id, profile);
    else if (record(profile) && profile.apiKey) throw failure('旧配置包含未知服务的 Key，旧数据未更改。');
  }
  if (raw.provider === undefined || isProviderId(raw.provider)) add(raw.provider ?? 'deepseek', raw);
  else if (raw.apiKey) throw failure('旧配置的服务商无法识别，旧数据未更改。');
  return credentials;
}
export async function importLegacyKeys(passphrase: string): Promise<ConnectionSettingsView> {
  await serialize(async () => {
    const initial = await loadState();
    if (!initial.legacyProviders.length && !initial.legacyCorrupt) return;
    const credentials = initial.legacyVault === undefined ? {} : (await unlockEncryptedKeyVault(initial.legacyVault, passphrase)).credentials;
    for (const [id, credential] of Object.entries(collectPlaintextLegacy(initial.legacyRaw))) {
      const provider = id as ProviderId;
      if (credentials[provider] && JSON.stringify(credentials[provider]) !== JSON.stringify(credential)) throw failure('旧版明文记录与加密记录不一致，原有数据未更改。请重新填写此服务的 Key。');
      credentials[provider] = credential;
    }
    // PBKDF2 may overlap with another trusted writer. Re-read and merge into
    // current data; never replace a Key the user has just entered or deleted.
    const state = await loadState();
    if (JSON.stringify(initial.legacyVault) !== JSON.stringify(state.legacyVault) || JSON.stringify(initial.legacyRaw) !== JSON.stringify(state.legacyRaw)) {
      throw failure('旧版配置已在另一页面更改，请重试导入。原有数据未更改。');
    }
    const settings = runtimeSettings(state), merged = { ...state.credentials };
    for (const preset of PROVIDERS) {
      const credential = credentials[preset.id];
      if (!credential || state.handled.has(preset.id) || merged[preset.id]) continue;
      const profile = settings.profiles[preset.id];
      if (profile && profile.baseUrl !== credential.baseUrl) throw failure('旧 Key 的服务地址与当前配置不同，请恢复旧地址或重新填写 Key。旧数据未更改。');
      if (!profile) settings.profiles[preset.id] = { ...defaultProfile(preset.id), baseUrl: credential.baseUrl };
      merged[preset.id] = credential;
      state.handled.add(preset.id);
    }
    settings.connectionRevision = nextRevision(settings);
    await persist(state, settings, merged);
  });
  return connectionSettings();
}
