import { browser } from 'wxt/browser';
import { OpenAICompatibleProvider } from '@/providers/openai-compatible';
import { apiOriginPattern, getProvider } from '@/shared/api-config';
import { normalizeTranslationInput } from '@/core/input';
import { toTranslationError } from '@/core/errors';
import { REQUEST_TIMEOUT_MS, TRANSLATION_PORT, type TranslationServerMessage } from '@/shared/contracts';
import { connectionSettings, publicSettings, readSettings, restrictStorageAccess, saveSettings, WEB_ORIGINS } from '@/platform/settings';
import { broadcastPublicSettings, synchronizeContentRegistration } from '@/platform/web-access';

export default defineBackground(() => {
  let registrationQueue = Promise.resolve();
  let settingsQueue = Promise.resolve();
  let activeCount = 0;
  const requests = new Map<AbortController, () => void>();
  const synchronize = () => {
    registrationQueue = registrationQueue.catch(() => {}).then(synchronizeContentRegistration);
    return registrationQueue;
  };
  void restrictStorageAccess().then(synchronize).catch(() => {});
  browser.runtime.onInstalled.addListener(() => { void synchronize().catch(() => {}); });
  browser.runtime.onStartup.addListener(() => { void synchronize().catch(() => {}); });
  const permissionChanged = () => { void synchronize().then(broadcastPublicSettings).catch(() => {}); };
  browser.permissions.onAdded.addListener(permissionChanged);
  browser.permissions.onRemoved.addListener(permissionChanged);

  browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (sender.id !== browser.runtime.id || !message || typeof message !== 'object') return false;
    const request = message as Record<string, unknown>;
    if (request.type === 'get-settings') {
      void publicSettings().then(sendResponse).catch(() => sendResponse({ enabled: false, includeContext: true, sentenceAnalysisEnabled: false, model: 'deepseek-flash', hasApiKey: false, webAccess: false }));
      return true;
    }
    if (request.type === 'open-options') {
      void browser.runtime.openOptionsPage().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
      return true;
    }
    const trusted = sender.url?.startsWith(browser.runtime.getURL('')) === true;
    if (request.type === 'get-connection-settings' && trusted) {
      void connectionSettings().then(sendResponse).catch(() => sendResponse({ ok: false }));
      return true;
    }
    if (request.type === 'save-settings' && trusted) {
      settingsQueue = settingsQueue.catch(() => {}).then(async () => {
        try {
          const previous = await readSettings();
          await saveSettings(request.settings, request.keepExistingKey === true);
          const updated = await readSettings();
          if (!updated.enabled || previous.connectionRevision !== updated.connectionRevision) {
            for (const cancel of requests.values()) cancel();
          }
          await synchronize();
          await broadcastPublicSettings();
          sendResponse({ ok: true, settings: await connectionSettings() });
        } catch (error) {
          sendResponse({ ok: false, error: error instanceof Error ? error.message : '保存设置失败。' });
        }
      });
      return true;
    }
    if (request.type === 'refresh-permissions' && trusted) {
      void synchronize().then(publicSettings).then(sendResponse).catch(() => sendResponse({ ok: false }));
      return true;
    }
    return false;
  });

  browser.runtime.onConnect.addListener(port => {
    if (port.name !== TRANSLATION_PORT || port.sender?.id !== browser.runtime.id) return;
    let closed = false;
    let current: { requestId: string; controller: AbortController } | undefined;
    const send = (message: TranslationServerMessage) => {
      if (closed) return;
      try { port.postMessage(message); } catch { closed = true; current?.controller.abort(); }
    };
    port.onDisconnect.addListener(() => {
      closed = true;
      current?.controller.abort();
      current = undefined;
    });
    port.onMessage.addListener((message: unknown) => {
      if (!message || typeof message !== 'object') return;
      const request = message as Record<string, unknown>;
      if (typeof request.requestId !== 'string' || !/^[a-zA-Z0-9:_-]{1,100}$/.test(request.requestId)) return;
      const requestId = request.requestId;
      if (request.type === 'cancel') {
        if (current?.requestId === requestId) { current.controller.abort(); current = undefined; }
        return;
      }
      if (request.type === 'heartbeat') return;
      if (request.type !== 'translate') return;
      current?.controller.abort();
      if (activeCount >= 64) {
        current = undefined;
        send({ type: 'error', requestId, error: { code: 'RATE_LIMIT', message: '同时翻译的页面过多，请稍后重试。', retryable: true } });
        return;
      }
      const owner = { requestId, controller: new AbortController() };
      requests.set(owner.controller, () => {
        if (!closed && current === owner) send({ type: 'error', requestId, error: {
          code: 'CONFIG', message: '翻译配置已更改，请使用当前设置重新翻译。', retryable: false,
        } });
        owner.controller.abort();
      });
      current = owner;
      activeCount += 1;
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; owner.controller.abort(); }, REQUEST_TIMEOUT_MS);
      const belongs = () => !closed && current === owner && !owner.controller.signal.aborted;
      void (async () => {
        try {
          const input = normalizeTranslationInput(request.input);
          const settings = await readSettings();
          if (!belongs()) return;
          const trustedPage = port.sender?.url?.startsWith(browser.runtime.getURL('')) === true;
          if (!trustedPage && !await browser.permissions.contains({ origins: WEB_ORIGINS })) {
            if (belongs()) send({ type: 'error', requestId, error: { code: 'CONFIG', message: '网页访问权限已关闭，请在扩展设置中重新启用网页划词。', retryable: false } });
            return;
          }
          if (!belongs()) return;
          if (!settings.enabled || (!settings.apiKey && getProvider(settings.provider).requiresApiKey)) {
            send({ type: 'error', requestId, error: { code: 'CONFIG', message: settings.enabled ? '请先在扩展设置中填写 API Key。' : '翻译已暂停，请在扩展设置中启用。', retryable: false } });
            return;
          }
          if (!await browser.permissions.contains({ origins: [apiOriginPattern(settings.baseUrl)] })) {
            if (belongs()) send({ type: 'error', requestId, error: { code: 'CONFIG', message: 'API 地址的访问权限尚未授予，请打开翻译设置重新保存并授权。', retryable: false } });
            return;
          }
          if (!belongs()) return;
          if (!settings.includeContext) delete input.context;
          if (input.task === 'sentence-analysis' && !settings.sentenceAnalysisEnabled) {
            send({ type: 'error', requestId, error: { code: 'CONFIG', message: '长难句拆解已关闭，可在翻译设置中开启。', retryable: false } });
            return;
          }
          const provider = new OpenAICompatibleProvider({ apiKey: settings.apiKey, model: settings.model,
            provider: settings.provider, baseUrl: settings.baseUrl, jsonMode: settings.jsonMode });
          send({ type: 'started', requestId });
          for await (const event of provider.translate(input, owner.controller.signal)) {
            if (!belongs()) break;
            send({ ...event, requestId });
          }
        } catch (error) {
          if (closed || current !== owner) return;
          if (timedOut) send({ type: 'error', requestId, error: { code: 'TIMEOUT', message: '翻译等待超过 90 秒，请稍后重试。', retryable: true } });
          else if (!owner.controller.signal.aborted) send({ type: 'error', requestId, error: toTranslationError(error) });
        } finally {
          clearTimeout(timeout);
          requests.delete(owner.controller);
          activeCount -= 1;
          if (current === owner) current = undefined;
        }
      })();
    });
  });
});
