import { browser } from 'wxt/browser';
import { DeepSeekProvider } from '@/providers/deepseek';
import { normalizeTranslationInput } from '@/core/input';
import { toTranslationError } from '@/core/errors';
import { REQUEST_TIMEOUT_MS, TRANSLATION_PORT, type TranslationServerMessage } from '@/shared/contracts';
import { publicSettings, readSettings, restrictStorageAccess, saveSettings, WEB_ORIGINS } from '@/platform/settings';
import { broadcastPublicSettings, synchronizeContentRegistration } from '@/platform/web-access';

export default defineBackground(() => {
  let registrationQueue = Promise.resolve();
  let activeCount = 0;
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
      void publicSettings().then(sendResponse).catch(() => sendResponse({ enabled: false, includeContext: true, model: 'deepseek-flash', hasApiKey: false, webAccess: false }));
      return true;
    }
    if (request.type === 'open-options') {
      void browser.runtime.openOptionsPage().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
      return true;
    }
    const trusted = sender.url?.startsWith(browser.runtime.getURL('')) === true;
    if (request.type === 'save-settings' && trusted) {
      void (async () => {
        try {
          await saveSettings(request.settings, request.keepExistingKey === true);
          await synchronize();
          await broadcastPublicSettings();
          sendResponse({ ok: true, settings: await publicSettings() });
        } catch (error) {
          sendResponse({ ok: false, error: error instanceof Error ? error.message : '保存设置失败。' });
        }
      })();
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
      if (activeCount >= 16) {
        current = undefined;
        send({ type: 'error', requestId, error: { code: 'RATE_LIMIT', message: '同时翻译的页面过多，请稍后重试。', retryable: true } });
        return;
      }
      const owner = { requestId, controller: new AbortController() };
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
          if (!settings.enabled || !settings.apiKey) {
            send({ type: 'error', requestId, error: { code: 'CONFIG', message: settings.enabled ? '请先在扩展设置中填写 DeepSeek API Key。' : '翻译已暂停，请在扩展设置中启用。', retryable: false } });
            return;
          }
          if (!settings.includeContext) delete input.context;
          const provider = new DeepSeekProvider({ apiKey: settings.apiKey, model: settings.model });
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
          activeCount -= 1;
          if (current === owner) current = undefined;
        }
      })();
    });
  });
});
