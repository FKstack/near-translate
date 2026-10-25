import { createRoot } from 'react-dom/client';
import { browser } from 'wxt/browser';
import type { PublicSettings, TranslationServiceStatus, TranslationStatusSource } from '../shared/contracts';
import { pageExecutionPolicy } from '../shared/translation-policy';
import { PageBar, pageBarStyles } from './Bar';
import { PageTranslationRenderer } from './render';
import { collectPageSegments, segmentIsCurrent, selectPageTranslationRoot } from './segments';
import { PageTranslationSession, type PageSessionState } from './session';
import { snapshotViewportPriorities } from './viewport';
import { beforeUserAction, type BeforeUse } from '../shared/before-use';

/** Document-scoped owner of the bar, inserted text, observer and translation session. */
export function mountPageTranslator(options: {
  serviceStatus?: TranslationStatusSource;
  onRead?: (translations: ReadonlyMap<string, string>) => void;
  /** Shares one explicit action with the composition root's popup and keyboard entry points. */
  onReadingAction?: (action: () => void) => void;
  beforeUse?: BeforeUse;
} = {}): () => void {
  const host = document.createElement('near-page-translate');
  host.setAttribute('data-near-page-ui', '');
  host.setAttribute('translate', 'no');
  host.style.cssText = 'all:initial!important;position:fixed!important;top:0!important;right:0!important;width:0!important;height:0!important;z-index:2147483646!important;';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = pageBarStyles;
  const container = document.createElement('div');
  shadow.append(style, container);
  document.documentElement.append(host);
  const react = createRoot(container);
  const translations = new PageTranslationRenderer();
  let state: PageSessionState = { status: 'idle', total: 0, completed: 0, failed: 0, pending: 0, skipped: 0, limitReached: false };
  let settings: PublicSettings | undefined;
  let serviceStatus: TranslationServiceStatus | undefined;
  let settingsReady = false;
  let disposed = false;
  let observing = false;
  let notice = '';
  let scanTimer: ReturnType<typeof setTimeout> | undefined;
  let documentUrl = location.href;
  let translationRoot: HTMLElement | undefined;
  let viewportFrame: number | undefined;
  let watchingViewport = false;
  const observation = { childList: true, subtree: true, characterData: true, attributes: true,
    attributeFilter: ['hidden', 'aria-hidden', 'style', 'class', 'translate', 'contenteditable'] };
  const available = () => settings?.enabled && settings.webAccess;
  const openSettings = () => { void browser.runtime.sendMessage({ type: 'open-options' }).catch(() => undefined); };
  const session = new PageTranslationSession({
    onChange(next) {
      state = next;
      if (next.status === 'stopped' && observing) disconnectObserver();
      if (next.error?.code === 'RATE_LIMIT') options.serviceStatus?.refresh();
      render();
    },
    onSegment(segment, view) {
      if (documentUrl !== location.href) { queueMicrotask(() => { if (!disposed) restore(true); }); return; }
      if (view.status !== 'stopped' && translationRoot && !translationRoot.contains(segment.container)) return;
      translations.update(segment, view, settings?.targetLanguage);
      if (view.status === 'done' || view.status === 'loading') scheduleViewportRefresh();
    },
  });

  function render(): void {
    if (disposed) return;
    react.render(available() ? <PageBar state={state} notice={notice} hasTranslations={state.total > 0}
      onTranslate={userStart} onStop={stop} onRestore={() => restore(false)} onRetry={userRetry} onSettings={openSettings}
      onRead={options.onRead ? userRead : undefined} onContinue={userRetry} serviceStatus={serviceStatus} /> : null);
  }

  function userStart(): void { beforeUserAction(options.beforeUse, start); }
  function userRetry(): void { beforeUserAction(options.beforeUse, retry); }
  function userRead(): void { beforeUserAction(options.beforeUse, read); }

  function disconnectObserver(): void {
    observer.disconnect();
    observing = false;
    clearTimeout(scanTimer);
    stopViewportWatching();
  }

  function refreshViewportPriorities(): void {
    if (disposed || !observing || !pageExecutionPolicy(settings?.translationEngine).viewportPriority) return;
    const snapshot = session.viewportSnapshot;
    if (snapshot.segments.length) session.updateViewportPriorities(snapshot.generation, snapshotViewportPriorities(snapshot.segments));
  }

  function scheduleViewportRefresh(): void {
    if (disposed || !watchingViewport || viewportFrame !== undefined) return;
    viewportFrame = requestAnimationFrame(() => { viewportFrame = undefined; refreshViewportPriorities(); });
  }

  function startViewportWatching(): void {
    if (!pageExecutionPolicy(settings?.translationEngine).viewportPriority) return;
    if (!watchingViewport) {
      watchingViewport = true;
      // Capture also observes scrolling inside an article's own scrolling container.
      document.addEventListener('scroll', scheduleViewportRefresh, { capture: true, passive: true });
      window.addEventListener('resize', scheduleViewportRefresh, { passive: true });
      document.addEventListener('visibilitychange', scheduleViewportRefresh);
    }
    refreshViewportPriorities();
  }

  function stopViewportWatching(): void {
    if (viewportFrame !== undefined) { cancelAnimationFrame(viewportFrame); viewportFrame = undefined; }
    if (!watchingViewport) return;
    watchingViewport = false;
    document.removeEventListener('scroll', scheduleViewportRefresh, true);
    window.removeEventListener('resize', scheduleViewportRefresh);
    document.removeEventListener('visibilitychange', scheduleViewportRefresh);
  }

  function restore(clearCache = true): void {
    disconnectObserver();
    session.reset({ clearCache });
    translations.clear();
    translationRoot = undefined;
    notice = '';
    state = { status: 'idle', total: 0, completed: 0, failed: 0, pending: 0, skipped: 0, limitReached: false };
    render();
  }

  function stop(): void {
    disconnectObserver();
    session.cancel();
  }

  function read(): void {
    if (disposed || !options.onRead) return;
    stop(); options.onRead(session.translationSnapshot);
  }

  function start(): void {
    if (!available() || disposed) return;
    if (settings?.apiKeyMigrationRequired) {
      notice = '请在翻译设置中重新填写 API Key，或导入旧版配置。';
      render();
      return;
    }
    if (!settings?.hasApiKey && settings?.requiresApiKey !== false) {
      notice = '请在翻译设置中选择 DeepL 免费翻译，或填写 API Key。';
      render();
      return;
    }
    if (settings?.apiAccess === false) {
      notice = '请在翻译设置中保存并授权当前翻译服务。';
      render();
      return;
    }
    restore(documentUrl !== location.href);
    documentUrl = location.href;
    translationRoot = selectPageTranslationRoot();
    const segments = collectPageSegments(translationRoot, settings);
    if (!segments.length) { notice = '没有找到需要翻译的正文，请检查源语言与目标语言。'; render(); return; }
    session.start(segments, pageExecutionPolicy(settings?.translationEngine));
    observer.observe(document.body, observation);
    observing = true;
    startViewportWatching();
  }

  function retry(): void {
    if (!available() || disposed) return;
    notice = '';
    session.retryFailed();
    if (!observing && document.body) {
      observer.observe(document.body, observation);
      observing = true;
    }
    startViewportWatching();
  }

  const ownSelector = '[data-near-page-ui],[data-near-page-translation],[data-near-translate]';
  const own = (node: Node) => Boolean((node instanceof Element ? node : node.parentElement)?.closest(ownSelector));
  const containsCandidate = (node: Node) => node instanceof Element
    && (node.matches('article,main,.navheader + .sect1') || node.querySelector('article,main,.navheader + .sect1') !== null);
  const affectsScope = (record: MutationRecord): boolean => {
    const root = translationRoot;
    if (!root || root === document.body || root.contains(record.target)) return true;
    if (record.type !== 'childList') {
      // Ancestor visibility can invalidate the root. A second article/main can
      // also change which root is preferred when its visibility changes.
      return record.target instanceof Element && (record.target.contains(root) || containsCandidate(record.target));
    }
    // Ignore clocks and sidebars, but retain root removal/reparenting and new
    // semantic roots anywhere in the observed page.
    return [...record.addedNodes, ...record.removedNodes].some(node => node === root
      || (node instanceof Element && node.contains(root)) || containsCandidate(node));
  };
  const observer = new MutationObserver(records => {
    if (disposed || !observing) return;
    const relevant = records.some(record => {
      if (own(record.target) || !affectsScope(record)) return false;
      if (record.type !== 'childList') return true;
      return [...record.addedNodes, ...record.removedNodes].some(node => !own(node))
        || [...record.removedNodes].some(node => node instanceof Element && node.hasAttribute('data-near-page-translation'));
    });
    if (!relevant) return;
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      if (disposed || !observing) return;
      if (documentUrl !== location.href) { restore(true); return; }
      const nextRoot = selectPageTranslationRoot();
      if (nextRoot !== translationRoot) {
        session.reset({ clearCache: false }); translations.clear(); translationRoot = nextRoot;
        session.start(collectPageSegments(translationRoot, settings), pageExecutionPolicy(settings?.translationEngine));
        refreshViewportPriorities();
        return;
      }
      translations.prune(segmentIsCurrent);
      session.append(collectPageSegments(translationRoot, settings));
      refreshViewportPriorities();
    }, 400);
  });

  function applySettings(value: PublicSettings): void {
    const changed = settings && (settings.model !== value.model || settings.hasApiKey !== value.hasApiKey
      || settings.provider !== value.provider || settings.translationEngine !== value.translationEngine || settings.connectionRevision !== value.connectionRevision);
    settings = value;
    settingsReady = true;
    options.serviceStatus?.refresh();
    if (!available() || changed) restore(true);
    else if (value.apiAccess === false) stop();
    render();
  }
  const onSettings = (message: unknown) => {
    const update = message as { type?: string; settings?: PublicSettings };
    if (update.type === 'settings-changed' && update.settings && !disposed) applySettings(update.settings);
  };
  const onNavigation = () => restore(true);
  window.addEventListener('pagehide', onNavigation);
  window.addEventListener('popstate', onNavigation);
  window.addEventListener('hashchange', onNavigation);
  browser.runtime.onMessage.addListener(onSettings);
  options.onReadingAction?.(userRead);
  const stopServiceStatus = options.serviceStatus?.subscribe(next => { serviceStatus = next; render(); });
  void browser.runtime.sendMessage({ type: 'get-settings' }).then((value: PublicSettings) => {
    if (!disposed && !settingsReady) applySettings(value);
  }).catch(() => { /* An invalidated extension is removed on the next navigation. */ });
  render();

  return () => {
    if (disposed) return;
    disposed = true;
    stopServiceStatus?.();
    disconnectObserver();
    session.dispose();
    translations.clear();
    browser.runtime.onMessage.removeListener(onSettings);
    window.removeEventListener('pagehide', onNavigation);
    window.removeEventListener('popstate', onNavigation);
    window.removeEventListener('hashchange', onNavigation);
    react.unmount();
    host.remove();
  };
}
