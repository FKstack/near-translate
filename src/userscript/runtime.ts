import { normalizeTranslationInput } from '../core/input';
import { toTranslationError, TranslationFailure } from '../core/errors';
import { OpenAICompatibleProvider } from '../providers/openai-compatible';
import { DeepLWebProvider } from '../providers/deepl-web';
import { RequestScheduler, RequestSchedulingFailure } from '../providers/request-scheduler';
import { connectionSettings, publicSettings, readSettings, restrictStorageAccess, saveSettings, enableFreeTranslation,
  importLegacyKeys, CONNECTION_SETTINGS_KEY } from '../platform/settings';
import { KeyVaultError } from '../platform/key-vault';
import { readReadingPreferences, saveReadingPreferences } from '../platform/reading-preferences';
import { FreeTranslationCheck } from '../platform/free-translation-check';
import { completionEndpoint, getProvider } from '../shared/api-config';
import { DEEPL_WEB_ENDPOINT } from '../shared/translation-engine';
import { DEEPL_WEB_SCHEDULING } from '../shared/translation-policy';
import { readLanguagePair, supportsWordDetails } from '../shared/languages';
import { KEY_VAULT_STORAGE_KEY } from '../shared/key-vault';
import { REQUEST_TIMEOUT_MS, TRANSLATION_PORT, type TranslationServerMessage, type TranslationError } from '../shared/contracts';
import { browser, emitRuntimeMessage, observeLocalStorage, registerRuntimeHandlers, type UserscriptPort } from './browser';
import { createGMFetch } from './transport';
import { isSettingsPage } from './locations';

const SETTINGS_KEY = 'settings:v1';
const COOLDOWN_KEY = 'deepl-web:cooldown-until:v1';
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const changedError: TranslationError = { code: 'CONFIG', message: '翻译配置已更改，请使用当前设置重新翻译。', retryable: false };

/** Install one sandbox-owned service for this document. No service handles are exposed to the host page. */
export async function installRuntime(options: { onOpenSettings: () => void }): Promise<() => void> {
  await restrictStorageAccess();
  let disposed = false;
  let settingsQueue = Promise.resolve();
  let epoch = 0;
  const jobs = new Map<AbortController, { engine?: string; fail: (error: TranslationError) => void }>();
  const queue = new RequestScheduler<void>({ maxConcurrent: 1, maxQueuedRequests: 64, intervalMs: 200 });
  const readCooldown = async () => {
    const value = (await browser.storage.local.get(COOLDOWN_KEY))[COOLDOWN_KEY];
    if (value === undefined) return 0;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new TranslationFailure('CONFIG', 'DeepL 冷却记录无法验证，请检查篡改猴存储后重试。');
    return value;
  };
  const deeplFetch = createGMFetch(DEEPL_WEB_ENDPOINT, async () => {
    const until = await readCooldown();
    if (until > Date.now()) throw new TranslationFailure('RATE_LIMIT', 'DeepL 请求受限，已暂停后续翻译，请稍后手动重试。', true, until);
  });
  const deepl = new DeepLWebProvider((body, signal) => deeplFetch(DEEPL_WEB_ENDPOINT, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'None' },
    body, signal, credentials: 'omit', redirect: 'error',
  }), { ...DEEPL_WEB_SCHEDULING, maxConcurrent: 1,
    loadCooldownUntil: readCooldown,
    async persistCooldownUntil(until) {
      await browser.storage.local.set({ [COOLDOWN_KEY]: Math.max(until, await readCooldown()) });
      publishStatus();
    },
  });
  const freeCheck = new FreeTranslationCheck(deepl, toTranslationError);

  async function status() {
    const settings = await readSettings();
    return { engine: settings.translationEngine, cooldownUntil: settings.translationEngine === 'deepl-web'
      ? Math.max(await readCooldown(), (await deepl.getServiceStatus()).cooldownUntil) : 0, checkedAt: Date.now() };
  }
  function publishStatus() {
    void status().then(value => { if (!disposed) emitRuntimeMessage({ type: 'translation-status-changed', status: value }); }).catch(() => {});
  }
  function publishSettings() {
    void publicSettings().then(settings => { if (!disposed) emitRuntimeMessage({ type: 'settings-changed', settings }); }).catch(() => {});
    publishStatus();
  }
  function cancelAll(error = changedError) {
    epoch++; freeCheck.cancel();
    for (const [controller, job] of jobs) { job.fail(error); controller.abort(); }
  }
  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const task = settingsQueue.catch(() => {}).then(operation);
    settingsQueue = task.then(() => {}, () => {});
    return task;
  }
  async function persistSettingsOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (typeof location === 'undefined' || !isSettingsPage(location.href)) throw new KeyVaultError('请在近译的专用设置页修改翻译配置。');
    if (typeof navigator === 'undefined' || typeof navigator.locks?.request !== 'function') {
      throw new KeyVaultError('当前设置页无法安全协调多标签写入，请使用支持 Web Locks 的新版浏览器。');
    }
    // Settings pages serialize writes; article pages can only read the configuration.
    return navigator.locks.request('near-translate:userscript:settings:v1', { mode: 'exclusive' }, async () => {
      if (disposed || !isSettingsPage(location.href)) throw new KeyVaultError('设置页已离开，请重新打开近译设置。');
      return operation();
    });
  }
  const removeStorageWatch = observeLocalStorage([CONNECTION_SETTINGS_KEY, SETTINGS_KEY, KEY_VAULT_STORAGE_KEY, COOLDOWN_KEY], (changes, remote) => {
    if (disposed) return;
    if (Object.hasOwn(changes, COOLDOWN_KEY)) {
      const until = changes[COOLDOWN_KEY]?.newValue;
      if (remote && typeof until === 'number' && until > Date.now()) {
        freeCheck.cancel();
        for (const [controller, job] of jobs) if (job.engine === 'deepl-web') {
          job.fail({ code: 'RATE_LIMIT', message: '另一页面的 DeepL 请求触发了冷却，请稍后重试。', retryable: true, retryAt: until });
          controller.abort();
        }
      }
      publishStatus(); return;
    }
    cancelAll();
    publishSettings();
  });

  async function request(message: unknown): Promise<unknown> {
    if (disposed || !record(message)) return { ok: false };
    if (message.type === 'get-settings') return publicSettings();
    if (message.type === 'get-connection-settings') { await settingsQueue; return connectionSettings(); }
    if (message.type === 'get-translation-status') return { ok: true, status: await status() };
    if (message.type === 'open-options') { options.onOpenSettings(); return { ok: true }; }
    if (message.type === 'get-reading-preferences') return { ok: true, preferences: await readReadingPreferences() };
    if (message.type === 'save-reading-preferences') return { ok: true, preferences: await saveReadingPreferences(message.preferences) };
    if (message.type === 'prepare-translation-network' || message.type === 'cancel-network-preparation') {
      // The extension's optional DNR preparation is unavailable to userscripts.
      return { ok: true };
    }
    if (message.type === 'refresh-permissions') return publicSettings();
    if (message.type === 'test-free-translation') {
      const settings = await readSettings();
      if (!settings.enabled || settings.translationEngine !== 'deepl-web') return { ok: false,
        error: { code: 'CONFIG', message: '请先启用免费翻译。', retryable: false } };
      const result = await freeCheck.run(); publishStatus(); return result;
    }
    if (message.type === 'save-settings' || message.type === 'enable-free-translation') return serialize(async () => {
      cancelAll();
      try {
        await persistSettingsOperation(async () => {
          if (message.type === 'enable-free-translation') await enableFreeTranslation();
          else await saveSettings(message.settings, message.keepExistingKey === true);
        });
        publishSettings(); return { ok: true, settings: await connectionSettings() };
      } catch (error) {
        publishSettings();
        return { ok: false, error: error instanceof KeyVaultError ? error.message : '保存设置失败，请重试。' };
      }
    });
    if (message.type === 'import-legacy-keys') return serialize(async () => {
      cancelAll();
      try {
        if (typeof message.passphrase !== 'string') throw new KeyVaultError('请输入旧版口令。');
        const settings = await persistSettingsOperation(() => importLegacyKeys(message.passphrase as string));
        publishSettings(); return { ok: true, settings };
      } catch (error) {
        publishSettings();
        return { ok: false, error: error instanceof KeyVaultError ? error.message : '导入失败，旧版数据仍保留。' };
      }
    });
    return { ok: false };
  }

  function connect(port: UserscriptPort) {
    if (port.name !== TRANSLATION_PORT) { port.disconnect(); return; }
    let closed = false;
    let current: { id: string; controller: AbortController } | undefined;
    const send = (message: TranslationServerMessage) => { if (!closed) port.postMessage(message); };
    port.onDisconnect.addListener(() => { closed = true; current?.controller.abort(); current = undefined; });
    port.onMessage.addListener(message => {
      if (!record(message) || typeof message.requestId !== 'string' || !/^[a-zA-Z0-9:_-]{1,100}$/.test(message.requestId)) return;
      const requestId = message.requestId;
      if (message.type === 'cancel') { if (current?.id === requestId) { current.controller.abort(); current = undefined; } return; }
      if (message.type !== 'translate') return;
      current?.controller.abort();
      const owner = { id: requestId, controller: new AbortController() };
      current = owner;
      const startingEpoch = epoch;
      let timedOut = false;
      let failed = false;
      const belongs = () => !closed && current === owner && !owner.controller.signal.aborted;
      const fail = (error: TranslationError) => { if (!closed && current === owner && !failed) { failed = true; send({ type: 'error', requestId, error }); } };
      const job: { engine?: string; fail: typeof fail } = { fail };
      jobs.set(owner.controller, job);
      const timeout = setTimeout(() => { timedOut = true; owner.controller.abort(); }, REQUEST_TIMEOUT_MS);
      void queue.run(async context => {
        const input = normalizeTranslationInput(message.input);
        const settings = await readSettings();
        job.engine = settings.translationEngine;
        if (!belongs()) return;
        if (startingEpoch !== epoch) throw new TranslationFailure('CONFIG', changedError.message);
        Object.assign(input, readLanguagePair(settings));
        if (input.kind === 'word' && !supportsWordDetails(input)) input.kind = 'text';
        const isDeepL = settings.translationEngine === 'deepl-web';
        if (!settings.enabled) throw new TranslationFailure('CONFIG', '翻译已暂停，请在设置中启用。');
        if (!isDeepL && settings.apiKeyMigrationRequired) throw new TranslationFailure('CONFIG', '请在翻译设置中重新填写 API Key，或导入旧版配置。');
        if (!isDeepL && !settings.apiKey && getProvider(settings.provider).requiresApiKey) throw new TranslationFailure('CONFIG', '请先在翻译设置中填写并保存 API Key。');
        if (isDeepL || !settings.includeContext) delete input.context;
        if (input.task === 'sentence-analysis' && (isDeepL || !settings.sentenceAnalysisEnabled)) throw new TranslationFailure('CONFIG', '当前翻译方式未开启长难句拆解。');
        const provider = isDeepL ? deepl : new OpenAICompatibleProvider({ apiKey: settings.apiKey, model: settings.model,
          provider: settings.provider, baseUrl: settings.baseUrl, jsonMode: settings.jsonMode }, createGMFetch(completionEndpoint(settings.baseUrl)));
        send({ type: 'started', requestId });
        for await (const event of provider.translate(input, context.signal)) {
          if (!belongs()) break;
          send({ ...event, requestId });
        }
      }, owner.controller.signal).catch(error => {
        if (timedOut) fail({ code: 'TIMEOUT', message: '翻译等待超过 90 秒，请稍后重试。', retryable: true });
        else if (!owner.controller.signal.aborted) fail(error instanceof RequestSchedulingFailure && error.kind === 'QUEUE_FULL'
          ? { code: 'RATE_LIMIT', message: '本页等待翻译的任务较多，请稍后重试。', retryable: true }
          : toTranslationError(error));
        publishStatus();
      }).finally(() => {
        clearTimeout(timeout); jobs.delete(owner.controller);
        if (current === owner) current = undefined;
      });
    });
  }
  const removeHandlers = registerRuntimeHandlers({ request, connect });
  return () => {
    if (disposed) return; disposed = true;
    cancelAll(); queue.dispose(); deepl.cancelPreparation(); removeStorageWatch(); removeHandlers();
  };
}
