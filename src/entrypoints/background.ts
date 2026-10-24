import { browser } from 'wxt/browser';
import { OpenAICompatibleProvider } from '@/providers/openai-compatible';
import { DeepLWebProvider, type DeepLWebDiagnostic } from '@/providers/deepl-web';
import { apiOriginPattern, getProvider } from '@/shared/api-config';
import { normalizeTranslationInput } from '@/core/input';
import { toTranslationError } from '@/core/errors';
import { REQUEST_TIMEOUT_MS, TRANSLATION_PORT, type TranslationServerMessage, type TranslationServiceStatus } from '@/shared/contracts';
import { connectionSettings, publicSettings, readSettings, restrictStorageAccess, saveSettings, enableFreeTranslation, importLegacyKeys, WEB_ORIGINS } from '@/platform/settings';
import { broadcastPublicSettings, broadcastTranslationStatus, synchronizeContentRegistration } from '@/platform/web-access';
import { createDeepLWebTransport, DeepLWebTransportError } from '@/platform/deepl-web-transport';
import { DEEPL_WEB_ORIGIN, DEEPL_WEB_PREPARATION_PERMISSION } from '@/shared/translation-engine';
import { createDeepLWebCooldownState, createDeepLWebPreparationState } from '@/platform/deepl-web-state';
import { DEEPL_WEB_SCHEDULING } from '@/shared/translation-policy';
import { readReadingPreferences, saveReadingPreferences } from '@/platform/reading-preferences';
import { readLanguagePair, supportsWordDetails } from '@/shared/languages';
import { FreeTranslationCheck } from '@/platform/free-translation-check';
import { KeyVaultError } from '@/platform/key-vault';

export default defineBackground(() => {
  let registrationQueue = Promise.resolve();
  let settingsQueue = Promise.resolve();
  let activeCount = 0;
  const requests = new Map<AbortController, () => void>();
  const modelRequests = new Set<AbortController>();
  let credentialEpoch = 0;
  const cancelModelTranslations = () => {
    credentialEpoch++;
    for (const controller of modelRequests) requests.get(controller)?.();
  };
  const deeplNetwork = createDeepLWebTransport();
  const deeplRateLimitDiagnostics: DeepLWebDiagnostic[] = [];
  let statusBroadcast: Promise<void> | undefined;
  let statusBroadcastRequested = false;
  let publishedStatus: TranslationServiceStatus | undefined;
  function publishServiceStatus(): void {
    statusBroadcastRequested = true;
    if (statusBroadcast) return;
    statusBroadcastRequested = false;
    // Concurrent failures share a notification, but a later cooldown extension
    // arriving during a slow receiver still gets one fresh state publication.
    statusBroadcast = Promise.resolve().then(async () => {
      const settings = await readSettings();
      const cooldownUntil = settings.translationEngine === 'deepl-web' ? (await deeplProvider.getServiceStatus()).cooldownUntil : 0;
      if (publishedStatus?.engine === settings.translationEngine && publishedStatus.cooldownUntil === cooldownUntil) return;
      const status = { engine: settings.translationEngine, cooldownUntil, checkedAt: Date.now() };
      await broadcastTranslationStatus(status);
      publishedStatus = status;
    }).catch(() => {}).finally(() => {
      statusBroadcast = undefined;
      if (statusBroadcastRequested) publishServiceStatus();
    });
  }
  const cooldownState = createDeepLWebCooldownState();
  // A single provider owns the service queue across all tabs, frames and PDF selections.
  const deeplProvider = new DeepLWebProvider(deeplNetwork.request, { ...cooldownState, ...DEEPL_WEB_SCHEDULING,
    async persistCooldownUntil(until) {
      await cooldownState.persistCooldownUntil(until);
      // Saving the shared timestamp precedes optional slow HTTP error-body diagnostics.
      publishServiceStatus();
    },
    ...createDeepLWebPreparationState(), prepareTransport: deeplNetwork.prepare,
    onDiagnostic(diagnostic) {
      deeplRateLimitDiagnostics.push({ ...diagnostic });
      if (deeplRateLimitDiagnostics.length > 64) deeplRateLimitDiagnostics.shift();
      publishServiceStatus();
    },
  });
  const freeCheck = new FreeTranslationCheck(deeplProvider, toTranslationError);
  let connectionEpoch = 0;
  const cancelActiveTranslations = () => {
    connectionEpoch++;
    freeCheck.cancel();
    for (const cancel of requests.values()) cancel();
  };
  let preparationOwner: { tabId: number; documentId?: string; requestId: string } | undefined;
  const cancelNetworkPreparation = () => {
    preparationOwner = undefined;
    deeplProvider.cancelPreparation();
  };
  const synchronize = () => {
    registrationQueue = registrationQueue.catch(() => {}).then(async () => {
      const settings = await readSettings();
      if (!settings.enabled || settings.translationEngine !== 'deepl-web') cancelNetworkPreparation();
      try {
        await deeplNetwork.synchronize(settings.enabled && settings.translationEngine === 'deepl-web');
      } finally {
        await synchronizeContentRegistration();
      }
    });
    return registrationQueue;
  };
  void restrictStorageAccess().then(synchronize).catch(() => {});
  browser.runtime.onInstalled.addListener(() => { void synchronize().catch(() => {}); });
  browser.runtime.onStartup.addListener(() => { void synchronize().catch(() => {}); });
  const permissionChanged = () => { void synchronize().then(broadcastPublicSettings).catch(() => {}); };
  browser.permissions.onAdded.addListener(permissionChanged);
  browser.permissions.onRemoved.addListener(() => {
    cancelNetworkPreparation();
    cancelActiveTranslations();
    void synchronize().catch(() => {}).then(broadcastPublicSettings).catch(() => {});
  });

  browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (sender.id !== browser.runtime.id || !message || typeof message !== 'object') return false;
    const request = message as Record<string, unknown>;
    if (request.type === 'prepare-translation-network' || request.type === 'cancel-network-preparation') {
      // Browser-provided sender fields own the request. Never accept a URL or body from the page.
      let webSender = false;
      try { webSender = /^https?:$/.test(new URL(sender.url ?? '').protocol); } catch { /* Invalid sender. */ }
      if (!webSender || sender.frameId !== 0 || !Number.isInteger(sender.tab?.id)
        || typeof request.requestId !== 'string' || !/^[a-zA-Z0-9:_-]{1,100}$/.test(request.requestId)) return false;
      const sameOwner = preparationOwner?.tabId === sender.tab!.id
        && preparationOwner?.documentId === sender.documentId && preparationOwner?.requestId === request.requestId;
      if (request.type === 'cancel-network-preparation') {
        if (sameOwner) cancelNetworkPreparation();
        sendResponse({ ok: true });
        return false;
      }
      if (preparationOwner || sender.tab?.active !== true) { sendResponse({ ok: true }); return false; }
      const owner = { tabId: sender.tab!.id!, documentId: sender.documentId, requestId: request.requestId };
      preparationOwner = owner;
      const belongs = () => preparationOwner === owner;
      void (async () => {
        const settings = await readSettings();
        if (!belongs() || !settings.enabled || settings.translationEngine !== 'deepl-web') return;
        const granted = await browser.permissions.contains({ origins: [...WEB_ORIGINS, DEEPL_WEB_ORIGIN],
          permissions: [DEEPL_WEB_PREPARATION_PERMISSION] });
        if (!belongs() || !granted) return;
        // The service queue owns cooldown, deadline and actual network cleanup.
        // Normal translate requests never wait for this promise.
        await deeplProvider.prepareNetwork();
      })().catch(() => { publishServiceStatus(); /* Optional metadata preparation never breaks ordinary translation. */ }).finally(() => {
        if (belongs()) preparationOwner = undefined;
        sendResponse({ ok: true });
      });
      return true;
    }
    if (request.type === 'get-settings') {
      void publicSettings().then(sendResponse).catch(() => sendResponse({ enabled: false, includeContext: true, sentenceAnalysisEnabled: false, model: 'deepseek-flash', hasApiKey: false, webAccess: false }));
      return true;
    }
    if (request.type === 'open-options') {
      void browser.runtime.openOptionsPage().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
      return true;
    }
    const trusted = sender.url?.startsWith(browser.runtime.getURL('')) === true;
    if (request.type === 'import-legacy-keys') {
      let optionsPage = false;
      try { optionsPage = trusted && new URL(sender.url!).pathname === '/options.html'; } catch { /* Invalid sender. */ }
      if (!optionsPage) return false;
      settingsQueue = settingsQueue.catch(() => {}).then(async () => {
        cancelModelTranslations();
        try {
          if (typeof request.passphrase !== 'string') throw new KeyVaultError('请输入旧版口令。');
          await importLegacyKeys(request.passphrase);
          try { await synchronize(); } catch (error) { if (!(error instanceof DeepLWebTransportError)) throw error; }
          await broadcastPublicSettings();
          sendResponse({ ok: true, settings: await connectionSettings() });
        } catch (error) {
          const message = error instanceof KeyVaultError ? error.message : '导入失败，旧版数据仍保留。';
          const refresh = await Promise.allSettled([broadcastPublicSettings(), connectionSettings()]);
          sendResponse({ ok: false, error: message, ...(refresh[1].status === 'fulfilled' ? { settings: refresh[1].value } : {}) });
        }
      });
      return true;
    }
    if (request.type === 'get-translation-status') {
      let web = false;
      try { web = Number.isInteger(sender.tab?.id) && /^https?:$/.test(new URL(sender.url ?? '').protocol); } catch { /* Invalid sender. */ }
      if (!trusted && !web) return false;
      void (async () => {
        const settings = await readSettings();
        const cooldownUntil = settings.translationEngine === 'deepl-web' ? (await deeplProvider.getServiceStatus()).cooldownUntil : 0;
        sendResponse({ ok: true, status: { engine: settings.translationEngine, cooldownUntil, checkedAt: Date.now() } });
      })().catch(() => sendResponse({ ok: false }));
      return true;
    }
    if (request.type === 'enable-free-translation' && trusted) {
      settingsQueue = settingsQueue.catch(() => {}).then(async () => {
        try {
          if (!await browser.permissions.contains({ origins: [...WEB_ORIGINS, DEEPL_WEB_ORIGIN] })) {
            sendResponse({ ok: false, error: { code: 'CONFIG', message: '请先允许网页和 DeepL 服务访问权限；仍可继续本地阅读。', retryable: false } }); return;
          }
          await enableFreeTranslation();
          cancelNetworkPreparation(); cancelActiveTranslations();
          await synchronize(); await broadcastPublicSettings();
          sendResponse({ ok: true, settings: await connectionSettings() });
        } catch {
          sendResponse({ ok: false, error: { code: 'CONFIG', message: '启用免费翻译失败，请重试；原模型配置已保留。', retryable: true } });
        }
      });
      return true;
    }
    if (request.type === 'test-free-translation' && trusted) {
      const epoch = connectionEpoch;
      void (async () => {
        const settings = await readSettings();
        if (settings.translationEngine !== 'deepl-web' || !settings.enabled
          || !await browser.permissions.contains({ origins: [DEEPL_WEB_ORIGIN] })) {
          sendResponse({ ok: false, error: { code: 'CONFIG', message: '请先启用并授权免费翻译，再测试公开示例句。', retryable: false } }); return;
        }
        if (epoch !== connectionEpoch) {
          sendResponse({ ok: false, error: { code: 'CONFIG', message: '设置已改变，请重新测试。', retryable: true } }); return;
        }
        const result = await freeCheck.run();
        publishServiceStatus();
        sendResponse(result);
      })().catch(error => sendResponse({ ok: false, error: toTranslationError(error) }));
      return true;
    }
    if (request.type === 'get-reading-preferences' || request.type === 'save-reading-preferences') {
      let web = false;
      try { web = sender.frameId === 0 && Number.isInteger(sender.tab?.id) && /^https?:$/.test(new URL(sender.url ?? '').protocol); } catch { /* Invalid sender. */ }
      if (!trusted && !web) return false;
      const operation = request.type === 'get-reading-preferences' ? readReadingPreferences() : saveReadingPreferences(request.preferences);
      void operation.then(preferences => sendResponse({ ok: true, preferences })).catch(() => sendResponse({ ok: false }));
      return true;
    }
    if (request.type === 'get-translation-metrics' && trusted) {
      sendResponse({ ...deeplNetwork.metrics(), rateLimitDiagnostics: deeplRateLimitDiagnostics.map(item => ({ ...item })) });
      return false;
    }
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
            cancelNetworkPreparation();
            cancelActiveTranslations();
          }
          await synchronize();
          await broadcastPublicSettings();
          sendResponse({ ok: true, settings: await connectionSettings() });
        } catch (error) {
          sendResponse({ ok: false, error: error instanceof KeyVaultError ? error.message : '保存设置失败，请重试。' });
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
      const startingCredentialEpoch = credentialEpoch;
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
          Object.assign(input, readLanguagePair(settings));
          if (input.kind === 'word' && !supportsWordDetails(input)) input.kind = 'text';
          const deepl = settings.translationEngine === 'deepl-web';
          if (!belongs()) return;
          if (!deepl) {
            if (startingCredentialEpoch !== credentialEpoch) {
              send({ type: 'error', requestId, error: { code: 'CONFIG', message: '翻译配置已更改，请重新翻译。', retryable: false } });
              return;
            }
            modelRequests.add(owner.controller);
          }
          const trustedPage = port.sender?.url?.startsWith(browser.runtime.getURL('')) === true;
          if (!trustedPage && !await browser.permissions.contains({ origins: WEB_ORIGINS })) {
            if (belongs()) send({ type: 'error', requestId, error: { code: 'CONFIG', message: '网页访问权限已关闭，请在扩展设置中重新启用网页划词。', retryable: false } });
            return;
          }
          if (!belongs()) return;
          if (!settings.enabled || (!deepl && (settings.apiKeyMigrationRequired || (!settings.apiKey && getProvider(settings.provider).requiresApiKey)))) {
            if (belongs()) send({ type: 'error', requestId, error: { code: 'CONFIG', message: !settings.enabled
              ? '请先在扩展设置中启用翻译。' : settings.apiKeyMigrationRequired
                ? '请在翻译设置中重新填写 API Key，或导入旧版配置。'
                : '请先在翻译设置中填写并保存 API Key。', retryable: false } });
            return;
          }
          if (!await browser.permissions.contains(deepl
            ? { origins: [DEEPL_WEB_ORIGIN] }
            : { origins: [apiOriginPattern(settings.baseUrl)] })) {
            if (belongs()) send({ type: 'error', requestId, error: { code: 'CONFIG', message: '当前翻译服务的访问权限尚未授予，请打开翻译设置重新保存并授权。', retryable: false } });
            return;
          }
          if (!belongs()) return;
          if (deepl || !settings.includeContext) delete input.context;
          if (input.task === 'sentence-analysis' && (deepl || !settings.sentenceAnalysisEnabled)) {
            send({ type: 'error', requestId, error: { code: 'CONFIG', message: deepl
              ? 'DeepL 免费翻译不支持长难句拆解，请切换大模型 API。' : '长难句拆解已关闭，可在翻译设置中开启。', retryable: false } });
            return;
          }
          if (deepl) await deeplNetwork.synchronize(true);
          if (!belongs()) return;
          const provider = deepl ? deeplProvider : new OpenAICompatibleProvider({ apiKey: settings.apiKey, model: settings.model,
            provider: settings.provider, baseUrl: settings.baseUrl, jsonMode: settings.jsonMode });
          send({ type: 'started', requestId });
          for await (const event of provider.translate(input, owner.controller.signal)) {
            if (!belongs()) break;
            send({ ...event, requestId });
          }
        } catch (error) {
          publishServiceStatus();
          if (closed || current !== owner) return;
          if (timedOut) send({ type: 'error', requestId, error: { code: 'TIMEOUT', message: '翻译等待超过 90 秒，请稍后重试。', retryable: true } });
          else if (!owner.controller.signal.aborted) send({ type: 'error', requestId, error: error instanceof DeepLWebTransportError
            ? { code: 'CONFIG', message: error.message, retryable: false } : toTranslationError(error) });
        } finally {
          clearTimeout(timeout);
          requests.delete(owner.controller);
          modelRequests.delete(owner.controller);
          activeCount -= 1;
          if (current === owner) current = undefined;
        }
      })();
    });
  });
});
