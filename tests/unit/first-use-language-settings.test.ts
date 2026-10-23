import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProvider } from '../../src/shared/api-config';

const store = vi.hoisted(() => ({
  value: undefined as unknown,
  access: vi.fn<() => Promise<void>>(),
  get: vi.fn<(key: string) => Promise<Record<string, unknown>>>(),
  set: vi.fn<(value: Record<string, unknown>) => Promise<void>>(),
  contains: vi.fn<(query: unknown) => Promise<boolean>>(),
  request: vi.fn<(query: unknown) => Promise<boolean>>(),
  fetch: vi.fn<typeof fetch>(),
}));
vi.mock('wxt/browser', () => ({ browser: {
  storage: { local: { setAccessLevel: store.access, get: store.get, set: store.set } },
  permissions: { contains: store.contains, request: store.request },
} }));

const KEY = 'settings:v1';
let settings: typeof import('../../src/platform/settings');
function profiles() {
  return {
    deepseek: { model: 'saved-deepseek-model', baseUrl: getProvider('deepseek').baseUrl, jsonMode: true, apiKey: 'private-deepseek-fixture' },
    openai: { model: 'saved-openai-model', baseUrl: getProvider('openai').baseUrl, jsonMode: false, apiKey: 'private-openai-fixture' },
  };
}
function existing(provider: 'deepseek' | 'openai' = 'deepseek') {
  const savedProfiles = profiles();
  return { schemaVersion: 2, translationEngine: 'model', connectionRevision: 7, enabled: false,
    includeContext: true, sentenceAnalysisEnabled: true, sourceLanguage: 'ja', targetLanguage: 'de',
    provider, ...savedProfiles[provider], profiles: savedProfiles };
}
function form(provider: 'deepseek' | 'openai' = 'deepseek', apiKey = '') {
  return { enabled: false, includeContext: true, sentenceAnalysisEnabled: true, provider,
    ...profiles()[provider], apiKey };
}
async function writeStored(update: Record<string, unknown>) { store.value = structuredClone(update[KEY]); }
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function holdNextWrite() {
  const entered = deferred(); const release = deferred();
  store.set.mockImplementationOnce(async value => {
    entered.resolve(); await release.promise; await writeStored(value);
  });
  return { entered: entered.promise, release: release.resolve };
}
const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks();
  store.value = undefined;
  store.access.mockResolvedValue(undefined);
  store.get.mockImplementation(async () => ({ [KEY]: structuredClone(store.value) }));
  store.set.mockImplementation(writeStored);
  store.contains.mockResolvedValue(true); store.request.mockResolvedValue(false);
  store.fetch.mockRejectedValue(new Error('Unexpected network access in settings test'));
  vi.stubGlobal('fetch', store.fetch);
  settings = await import('../../src/platform/settings');
});
afterEach(() => {
  try {
    expect(store.fetch).not.toHaveBeenCalled();
    expect(store.request).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); }
});

describe('first-use engine selection', () => {
  it('defaults genuinely absent settings to usable DeepL without requiring or inventing a Key', async () => {
    expect(await settings.readSettings()).toMatchObject({ translationEngine: 'deepl-web', enabled: true,
      apiKey: '', sourceLanguage: 'auto', targetLanguage: 'zh-Hans', connectionRevision: 0 });
    expect(await settings.publicSettings()).toMatchObject({ translationEngine: 'deepl-web', requiresApiKey: false, hasApiKey: false });
    expect(store.value).toBeUndefined(); expect(store.set).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'an existing empty settings record', value: {}, key: '' },
    { name: 'legacy v1 settings with a Key', value: { schemaVersion: 1, model: 'saved-model', apiKey: 'private-legacy-fixture' }, key: 'private-legacy-fixture' },
    { name: 'an explicitly selected model without a Key', value: { translationEngine: 'model', apiKey: '' }, key: '' },
    { name: 'a saved model profile with a Key', value: existing('openai'), key: 'private-openai-fixture' },
  ])('preserves $name instead of silently switching its engine', async ({ value, key }) => {
    store.value = structuredClone(value);
    const before = structuredClone(store.value);
    expect(await settings.readSettings()).toMatchObject({ translationEngine: 'model', apiKey: key });
    expect(store.value).toEqual(before); expect(store.set).not.toHaveBeenCalled();
  });

  it('retains an existing DeepL choice and conservatively migrates invalid stored language choices', async () => {
    store.value = { ...existing(), translationEngine: 'deepl-web', sourceLanguage: 'unknown', targetLanguage: null };
    const before = structuredClone(store.value);
    expect(await settings.readSettings()).toMatchObject({ translationEngine: 'deepl-web', sourceLanguage: 'auto', targetLanguage: 'zh-Hans' });
    expect(store.value).toEqual(before); expect(store.set).not.toHaveBeenCalled();
  });
});

describe('saved language settings compatibility', () => {
  beforeEach(() => { store.value = existing(); });

  it('projects saved languages to content and trusted settings without exposing Keys', async () => {
    const value = await settings.publicSettings();
    expect(value).toMatchObject({ sourceLanguage: 'ja', targetLanguage: 'de', hasApiKey: true });
    expect(value).not.toHaveProperty('apiKey'); expect(value).not.toHaveProperty('profiles');
    expect(JSON.stringify(value)).not.toContain('private-');
    expect(await settings.connectionSettings()).toMatchObject({ sourceLanguage: 'ja', targetLanguage: 'de' });
  });

  it('preserves the chosen pair and revision when an old client omits the new fields', async () => {
    await settings.saveSettings(form(), true);
    expect(await settings.readSettings()).toMatchObject({ sourceLanguage: 'ja', targetLanguage: 'de', connectionRevision: 7,
      apiKey: 'private-deepseek-fixture' });
  });

  it('increments revision for a changed pair, preserves omitted fields and avoids no-op increments', async () => {
    await settings.saveSettings({ ...form(), sourceLanguage: 'ko', targetLanguage: 'ar' }, true);
    expect(await settings.readSettings()).toMatchObject({ sourceLanguage: 'ko', targetLanguage: 'ar', connectionRevision: 8 });
    await settings.saveSettings({ ...form(), sourceLanguage: 'ko', targetLanguage: 'ar' }, true);
    expect((await settings.readSettings()).connectionRevision).toBe(8);
    await settings.saveSettings({ ...form(), targetLanguage: 'en' }, true);
    expect(await settings.readSettings()).toMatchObject({ sourceLanguage: 'ko', targetLanguage: 'en', connectionRevision: 9 });
    await settings.saveSettings({ ...form(), translationEngine: 'deepl-web', sourceLanguage: 'fr', targetLanguage: 'ja' }, false);
    expect(await settings.readSettings()).toMatchObject({ sourceLanguage: 'fr', targetLanguage: 'ja', connectionRevision: 10,
      translationEngine: 'deepl-web', apiKey: 'private-deepseek-fixture' });
    await settings.saveSettings(form(), false);
    expect(await settings.readSettings()).toMatchObject({ sourceLanguage: 'fr', targetLanguage: 'ja', connectionRevision: 10,
      translationEngine: 'deepl-web', apiKey: 'private-deepseek-fixture' });
  });

  it.each([{ sourceLanguage: null }, { sourceLanguage: 12 }, { sourceLanguage: 'unknown' },
    { targetLanguage: null }, { targetLanguage: false }, { targetLanguage: 'auto' }, { targetLanguage: 'ZH-HANS' }])(
    'rejects malformed explicit language choices %j atomically', async invalid => {
      const before = structuredClone(store.value);
      await expect(settings.saveSettings({ ...form(), ...invalid }, true)).rejects.toThrow(/语言/);
      expect(store.value).toEqual(before); expect(store.set).not.toHaveBeenCalled();
    },
  );
});

describe('safe one-click free translation activation', () => {
  beforeEach(() => { store.value = existing('openai'); });

  it('enables DeepL from saved data while preserving all credentials, model profiles and language preferences', async () => {
    const before = await settings.readSettings();
    await settings.enableFreeTranslation();
    const after = await settings.readSettings();
    expect(after).toMatchObject({ translationEngine: 'deepl-web', enabled: true, connectionRevision: 8,
      sourceLanguage: 'ja', targetLanguage: 'de' });
    for (const field of ['provider', 'model', 'baseUrl', 'apiKey', 'jsonMode', 'profiles', 'includeContext', 'sentenceAnalysisEnabled'] as const) {
      expect(after[field]).toEqual(before[field]);
    }
    await settings.enableFreeTranslation();
    expect((await settings.readSettings()).connectionRevision).toBe(8);
  });

  it('waits behind an ordinary in-flight save and keeps its newly saved Key and languages', async () => {
    store.value = existing('deepseek');
    const blocked = holdNextWrite();
    const ordinary = settings.saveSettings({ ...form('openai', 'private-new-openai-fixture'), sourceLanguage: 'fr', targetLanguage: 'en' }, true);
    await blocked.entered;
    const free = settings.enableFreeTranslation();
    try { await flush(); expect(store.set).toHaveBeenCalledOnce(); }
    finally { blocked.release(); }
    await Promise.all([ordinary, free]);
    const after = await settings.readSettings();
    expect(after).toMatchObject({ translationEngine: 'deepl-web', enabled: true, provider: 'openai',
      sourceLanguage: 'fr', targetLanguage: 'en', apiKey: 'private-new-openai-fixture', connectionRevision: 9 });
    expect(after.profiles.deepseek?.apiKey).toBe('private-deepseek-fixture');
    expect(after.profiles.openai?.apiKey).toBe('private-new-openai-fixture');
  });

  it('also serializes an ordinary save behind a pending free-activation write', async () => {
    const blocked = holdNextWrite();
    const free = settings.enableFreeTranslation();
    await blocked.entered;
    const ordinary = settings.saveSettings({ ...form('openai', 'private-new-openai-fixture'), translationEngine: 'model', targetLanguage: 'es' }, true);
    try { await flush(); expect(store.set).toHaveBeenCalledOnce(); }
    finally { blocked.release(); }
    await Promise.all([free, ordinary]);
    const after = await settings.readSettings();
    expect(after).toMatchObject({ translationEngine: 'model', targetLanguage: 'es', sourceLanguage: 'ja', connectionRevision: 9,
      apiKey: 'private-new-openai-fixture' });
    expect(after.profiles.deepseek?.apiKey).toBe('private-deepseek-fixture');
    expect(after.profiles.openai?.apiKey).toBe('private-new-openai-fixture');
  });

  it('continues after a failed ordinary save without applying its invalid or unsaved form data', async () => {
    const before = await settings.readSettings();
    const failed = settings.saveSettings({ ...form('deepseek', 'private-unsaved-fixture'), targetLanguage: null }, true).catch(error => error);
    const free = settings.enableFreeTranslation();
    expect(await failed).toBeInstanceOf(Error); await free;
    const after = await settings.readSettings();
    expect(after).toMatchObject({ translationEngine: 'deepl-web', provider: 'openai', enabled: true, connectionRevision: 8 });
    expect(after.profiles).toEqual(before.profiles); expect(after.apiKey).toBe(before.apiKey);
    expect(JSON.stringify(after)).not.toContain('private-unsaved-fixture');
  });

  it('propagates a failed activation write without losing the model configuration', async () => {
    const before = structuredClone(store.value);
    store.set.mockRejectedValueOnce(new Error('Storage fixture failure'));
    await expect(settings.enableFreeTranslation()).rejects.toThrow('Storage fixture failure');
    expect(store.value).toEqual(before);
    await settings.enableFreeTranslation();
    expect(await settings.readSettings()).toMatchObject({ translationEngine: 'deepl-web', apiKey: 'private-openai-fixture' });
  });
});
