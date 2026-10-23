import { browser } from 'wxt/browser';
import type { ApiProfile, ConnectionSettings, EditableSettings, ProviderId, PublicApiProfile, PublicSettings, StoredSettings } from '@/shared/contracts';
import { apiOriginPattern, getProvider, isProviderId, normalizeBaseUrl, PROVIDERS } from '@/shared/api-config';
import { DEEPL_WEB_ORIGIN, DEEPL_WEB_PREPARATION_PERMISSION, isTranslationEngine, normalizeTranslationEngine } from '@/shared/translation-engine';
import { readLanguagePair, resolveLanguagePair, supportsSentenceAnalysis } from '@/shared/languages';

const STORAGE_KEY = 'settings:v1';
export const WEB_ORIGINS = ['http://*/*', 'https://*/*'];
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const MODEL_NAME = /^[a-zA-Z0-9._:/-]{1,200}$/;
let accessReady: Promise<void> | undefined;
let saveQueue = Promise.resolve();

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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
    // An invalid stored address must never move its credential to a preset host.
    if (typeof value.baseUrl !== 'string') return defaults;
    try { baseUrl = normalizeBaseUrl(value.baseUrl); } catch { return defaults; }
  }
  const model = typeof value.model === 'string' && !CONTROL_CHARACTERS.test(value.model) && MODEL_NAME.test(value.model.trim())
    ? value.model.trim() : defaults.model;
  const apiKey = typeof value.apiKey === 'string' && value.apiKey.length <= 4096 && !CONTROL_CHARACTERS.test(value.apiKey)
    ? value.apiKey.trim() : '';
  return { model, baseUrl, apiKey, jsonMode: typeof value.jsonMode === 'boolean' ? value.jsonMode : defaults.jsonMode };
}

export function restrictStorageAccess(): Promise<void> {
  return accessReady ??= browser.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
}

export async function readSettings(): Promise<StoredSettings> {
  await restrictStorageAccess();
  const data = await browser.storage.local.get(STORAGE_KEY);
  const saved = record(data[STORAGE_KEY]) ? data[STORAGE_KEY] as Record<string, unknown> : {};
  const provider = isProviderId(saved.provider) ? saved.provider : 'deepseek';
  const profiles: Partial<Record<ProviderId, ApiProfile>> = {};
  if (record(saved.profiles)) {
    for (const preset of PROVIDERS) {
      if (Object.hasOwn(saved.profiles, preset.id)) profiles[preset.id] = readProfile(saved.profiles[preset.id], preset.id);
    }
  }
  // v1 had only a flattened DeepSeek profile. v2 keeps the active snapshot
  // alongside the inactive profiles, all owned by this storage module.
  const active = saved.provider !== undefined && !isProviderId(saved.provider) ? defaultProfile(provider) : readProfile(saved, provider);
  profiles[provider] = active;
  return {
    schemaVersion: 2,
    translationEngine: data[STORAGE_KEY] === undefined ? 'deepl-web' : normalizeTranslationEngine(saved.translationEngine),
    ...readLanguagePair(saved),
    connectionRevision: typeof saved.connectionRevision === 'number' && Number.isSafeInteger(saved.connectionRevision) && saved.connectionRevision >= 0
      ? saved.connectionRevision : 0,
    enabled: typeof saved.enabled === 'boolean' ? saved.enabled : true,
    includeContext: typeof saved.includeContext === 'boolean' ? saved.includeContext : true,
    sentenceAnalysisEnabled: typeof saved.sentenceAnalysisEnabled === 'boolean' ? saved.sentenceAnalysisEnabled : true,
    provider, ...active, profiles,
  };
}

async function projectPublicSettings(settings: StoredSettings): Promise<PublicSettings> {
  const deepl = settings.translationEngine === 'deepl-web';
  const [webAccess, apiAccess] = await Promise.all([
    browser.permissions.contains({ origins: WEB_ORIGINS }),
    browser.permissions.contains(deepl
      ? { origins: [DEEPL_WEB_ORIGIN] }
      : { origins: [apiOriginPattern(settings.baseUrl)] }),
  ]);
  return {
    translationEngine: settings.translationEngine,
    ...readLanguagePair(settings),
    enabled: settings.enabled,
    includeContext: !deepl && settings.includeContext,
    sentenceAnalysisEnabled: !deepl && settings.sentenceAnalysisEnabled && supportsSentenceAnalysis(settings),
    model: settings.model,
    provider: settings.provider,
    connectionRevision: settings.connectionRevision,
    hasApiKey: Boolean(settings.apiKey),
    requiresApiKey: !deepl && getProvider(settings.provider).requiresApiKey,
    webAccess, apiAccess,
  };
}

export async function publicSettings(): Promise<PublicSettings> {
  return projectPublicSettings(await readSettings());
}

/** The background exposes this projection only to trusted extension pages. */
export async function connectionSettings(): Promise<ConnectionSettings> {
  const settings = await readSettings();
  const profiles: Partial<Record<ProviderId, PublicApiProfile>> = {};
  for (const preset of PROVIDERS) {
    const profile = settings.profiles[preset.id];
    if (profile) profiles[preset.id] = {
      model: profile.model, baseUrl: profile.baseUrl, jsonMode: profile.jsonMode, hasApiKey: Boolean(profile.apiKey),
    };
  }
  return {
    ...await projectPublicSettings(settings),
    networkPreparationAccess: await browser.permissions.contains({ permissions: [DEEPL_WEB_PREPARATION_PERMISSION] }),
    // Trusted options retain model preferences while the public capability projection is disabled.
    includeContext: settings.includeContext, sentenceAnalysisEnabled: settings.sentenceAnalysisEnabled,
    provider: settings.provider, baseUrl: settings.baseUrl, jsonMode: settings.jsonMode, profiles,
  };
}

/** Serialize read/merge/write so separate options pages cannot lose profiles. */
export function saveSettings(value: unknown, keepExistingKey: boolean): Promise<void> {
  const operation = saveQueue.catch(() => undefined).then(() => saveSettingsNow(value, keepExistingKey));
  saveQueue = operation;
  return operation;
}

/** Same storage owner/queue as ordinary saves; enabling free translation never overwrites model profiles. */
export function enableFreeTranslation(): Promise<void> {
  const operation = saveQueue.catch(() => undefined).then(async () => {
    const previous = await readSettings();
    await saveSettingsNow({ ...previous, translationEngine: 'deepl-web', enabled: true, apiKey: '' }, true);
  });
  saveQueue = operation;
  return operation;
}

async function saveSettingsNow(value: unknown, keepExistingKey: boolean): Promise<void> {
  if (!record(value)) throw new Error('设置格式不正确。');
  const input = value as Partial<EditableSettings>;
  if (typeof input.enabled !== 'boolean' || typeof input.includeContext !== 'boolean' || typeof input.model !== 'string' || typeof input.apiKey !== 'string') throw new Error('设置格式不正确。');
  if (input.sentenceAnalysisEnabled !== undefined && typeof input.sentenceAnalysisEnabled !== 'boolean') throw new Error('长难句拆解设置格式不正确。');
  if (input.translationEngine !== undefined && !isTranslationEngine(input.translationEngine)) throw new Error('请选择有效的翻译方式。');
  const previous = await readSettings();
  const languages = resolveLanguagePair({ sourceLanguage: input.sourceLanguage === undefined ? previous.sourceLanguage : input.sourceLanguage,
    targetLanguage: input.targetLanguage === undefined ? previous.targetLanguage : input.targetLanguage });
  const languageChanged = languages.sourceLanguage !== previous.sourceLanguage || languages.targetLanguage !== previous.targetLanguage;
  const translationEngine = input.translationEngine ?? previous.translationEngine;
  if (translationEngine === 'deepl-web') {
    // Model fields still travel with the options form. Never write them in this mode,
    // including an empty API key or a stale deletion flag from the hidden model form.
    await browser.storage.local.set({
      [STORAGE_KEY]: {
        ...previous,
        translationEngine,
        ...languages,
        connectionRevision: previous.connectionRevision + (translationEngine !== previous.translationEngine || languageChanged ? 1 : 0),
        enabled: input.enabled,
        includeContext: input.includeContext,
        sentenceAnalysisEnabled: input.sentenceAnalysisEnabled ?? previous.sentenceAnalysisEnabled,
      } satisfies StoredSettings,
    });
    return;
  }
  if (input.provider !== undefined && !isProviderId(input.provider)) throw new Error('请选择有效的 API 服务商。');
  if (input.baseUrl !== undefined && typeof input.baseUrl !== 'string') throw new Error('API 地址格式不正确。');
  if (input.jsonMode !== undefined && typeof input.jsonMode !== 'boolean') throw new Error('JSON 模式设置格式不正确。');
  const model = input.model.trim();
  if (CONTROL_CHARACTERS.test(input.model) || !MODEL_NAME.test(model)) throw new Error('请填写有效的模型名。');
  if (input.apiKey.length > 4096) throw new Error('API Key 太长，请检查输入。');
  if (CONTROL_CHARACTERS.test(input.apiKey)) throw new Error('API Key 不能包含换行或控制字符。');
  const provider = input.provider ?? previous.provider;
  const target = previous.profiles[provider] ?? defaultProfile(provider);
  const baseUrl = normalizeBaseUrl(input.baseUrl ?? target.baseUrl);
  const profile: ApiProfile = {
    model, baseUrl,
    jsonMode: input.jsonMode ?? target.jsonMode,
    apiKey: input.apiKey.trim() || (keepExistingKey && baseUrl === target.baseUrl ? target.apiKey : ''),
  };
  const connectionChanged = languageChanged || translationEngine !== previous.translationEngine || provider !== previous.provider || profile.model !== previous.model || profile.apiKey !== previous.apiKey
    || profile.baseUrl !== previous.baseUrl || profile.jsonMode !== previous.jsonMode;
  await browser.storage.local.set({
    [STORAGE_KEY]: {
      schemaVersion: 2,
      translationEngine,
      ...languages,
      connectionRevision: previous.connectionRevision + (connectionChanged ? 1 : 0),
      enabled: input.enabled,
      includeContext: input.includeContext,
      sentenceAnalysisEnabled: input.sentenceAnalysisEnabled ?? previous.sentenceAnalysisEnabled,
      provider, ...profile,
      profiles: { ...previous.profiles, [provider]: profile },
    } satisfies StoredSettings,
  });
}
