import { browser } from 'wxt/browser';
import { DEFAULT_MODEL, type EditableSettings, type StoredSettings, type PublicSettings } from '@/shared/contracts';

const STORAGE_KEY = 'settings:v1';
export const WEB_ORIGINS = ['http://*/*', 'https://*/*'];
const DEFAULTS: StoredSettings = { schemaVersion: 1, enabled: true, includeContext: true, model: DEFAULT_MODEL, apiKey: '' };
let accessReady: Promise<void> | undefined;

export function restrictStorageAccess(): Promise<void> {
  return accessReady ??= browser.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
}

export async function readSettings(): Promise<StoredSettings> {
  await restrictStorageAccess();
  const data = await browser.storage.local.get(STORAGE_KEY);
  const saved = data[STORAGE_KEY] as Partial<StoredSettings> | undefined;
  return {
    ...DEFAULTS,
    enabled: typeof saved?.enabled === 'boolean' ? saved.enabled : DEFAULTS.enabled,
    includeContext: typeof saved?.includeContext === 'boolean' ? saved.includeContext : DEFAULTS.includeContext,
    model: typeof saved?.model === 'string' && saved.model.trim() ? saved.model : DEFAULT_MODEL,
    apiKey: typeof saved?.apiKey === 'string' ? saved.apiKey : '',
  };
}

export async function publicSettings(): Promise<PublicSettings> {
  const settings = await readSettings();
  return {
    enabled: settings.enabled,
    includeContext: settings.includeContext,
    model: settings.model,
    hasApiKey: Boolean(settings.apiKey),
    webAccess: await browser.permissions.contains({ origins: WEB_ORIGINS }),
  };
}

export async function saveSettings(value: unknown, keepExistingKey: boolean): Promise<void> {
  if (!value || typeof value !== 'object') throw new Error('设置格式不正确。');
  const input = value as Partial<EditableSettings>;
  if (typeof input.enabled !== 'boolean' || typeof input.includeContext !== 'boolean' || typeof input.model !== 'string' || typeof input.apiKey !== 'string') throw new Error('设置格式不正确。');
  const model = input.model.trim();
  if (!/^[a-zA-Z0-9._:/-]{1,120}$/.test(model)) throw new Error('请填写有效的模型名。');
  if (input.apiKey.length > 4096) throw new Error('API Key 太长，请检查输入。');
  const previous = await readSettings();
  await browser.storage.local.set({
    [STORAGE_KEY]: {
      schemaVersion: 1,
      enabled: input.enabled,
      includeContext: input.includeContext,
      model,
      apiKey: keepExistingKey && !input.apiKey.trim() ? previous.apiKey : input.apiKey.trim(),
    } satisfies StoredSettings,
  });
}
