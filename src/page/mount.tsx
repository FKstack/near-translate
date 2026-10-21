import { createRoot } from 'react-dom/client';
import { browser } from 'wxt/browser';
import type { PublicSettings } from '../shared/contracts';
import { PageBar, pageBarStyles } from './Bar';
import { PageTranslationRenderer } from './render';
import { collectPageSegments, segmentIsCurrent } from './segments';
import { PageTranslationSession, type PageSessionState } from './session';

/** Document-scoped owner of the bar, inserted text, observer and translation session. */
export function mountPageTranslator(): () => void {
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
  let settingsReady = false;
  let disposed = false;
  let observing = false;
  let notice = '';
  let scanTimer: ReturnType<typeof setTimeout> | undefined;
  let documentUrl = location.href;
  const observation = { childList: true, subtree: true, characterData: true, attributes: true,
    attributeFilter: ['hidden', 'aria-hidden', 'style', 'class', 'translate', 'contenteditable'] };
  const available = () => settings?.enabled && settings.webAccess;
  const openSettings = () => { void browser.runtime.sendMessage({ type: 'open-options' }).catch(() => undefined); };
  const session = new PageTranslationSession({
    onChange(next) {
      state = next;
      if (next.status === 'stopped' && observing) disconnectObserver();
      render();
    },
    onSegment(segment, view) {
      if (documentUrl !== location.href) { queueMicrotask(() => { if (!disposed) restore(); }); return; }
      translations.update(segment, view);
    },
  });

  function render(): void {
    if (disposed) return;
    react.render(available() ? <PageBar state={state} notice={notice} hasTranslations={state.total > 0}
      onTranslate={start} onStop={stop} onRestore={restore} onRetry={retry} onSettings={openSettings} /> : null);
  }

  function disconnectObserver(): void {
    observer.disconnect();
    observing = false;
    clearTimeout(scanTimer);
  }

  function restore(): void {
    disconnectObserver();
    session.reset();
    translations.clear();
    notice = '';
    state = { status: 'idle', total: 0, completed: 0, failed: 0, pending: 0, skipped: 0, limitReached: false };
    render();
  }

  function stop(): void {
    disconnectObserver();
    session.cancel();
  }

  function start(): void {
    if (!available() || disposed) return;
    if (!settings?.hasApiKey && settings?.requiresApiKey !== false) {
      notice = '请先在翻译设置中填写 API Key。';
      render();
      return;
    }
    if (settings?.apiAccess === false) {
      notice = '请在翻译设置中保存并授权当前 API 地址。';
      render();
      return;
    }
    restore();
    documentUrl = location.href;
    const segments = collectPageSegments();
    if (!segments.length) { notice = '没有找到可翻译的英文正文。'; render(); return; }
    session.start(segments);
    observer.observe(document.body, observation);
    observing = true;
  }

  function retry(): void {
    if (!available() || disposed) return;
    notice = '';
    session.retryFailed();
    if (!observing && document.body) {
      observer.observe(document.body, observation);
      observing = true;
    }
  }

  const ownSelector = '[data-near-page-ui],[data-near-page-translation],[data-near-translate]';
  const own = (node: Node) => Boolean((node instanceof Element ? node : node.parentElement)?.closest(ownSelector));
  const observer = new MutationObserver(records => {
    if (disposed || !observing) return;
    const relevant = records.some(record => {
      if (own(record.target)) return false;
      if (record.type !== 'childList') return true;
      return [...record.addedNodes, ...record.removedNodes].some(node => !own(node))
        || [...record.removedNodes].some(node => node instanceof Element && node.hasAttribute('data-near-page-translation'));
    });
    if (!relevant) return;
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      if (disposed || !observing) return;
      if (documentUrl !== location.href) { restore(); return; }
      translations.prune(segmentIsCurrent);
      session.append(collectPageSegments());
    }, 400);
  });

  function applySettings(value: PublicSettings): void {
    const changed = settings && (settings.model !== value.model || settings.hasApiKey !== value.hasApiKey
      || settings.provider !== value.provider || settings.connectionRevision !== value.connectionRevision);
    settings = value;
    settingsReady = true;
    if (!available() || changed) restore();
    else if (value.apiAccess === false) stop();
    render();
  }
  const onSettings = (message: unknown) => {
    const update = message as { type?: string; settings?: PublicSettings };
    if (update.type === 'settings-changed' && update.settings && !disposed) applySettings(update.settings);
  };
  const onNavigation = () => restore();
  window.addEventListener('pagehide', onNavigation);
  window.addEventListener('popstate', onNavigation);
  window.addEventListener('hashchange', onNavigation);
  browser.runtime.onMessage.addListener(onSettings);
  void browser.runtime.sendMessage({ type: 'get-settings' }).then((value: PublicSettings) => {
    if (!disposed && !settingsReady) applySettings(value);
  }).catch(() => { /* An invalidated extension is removed on the next navigation. */ });
  render();

  return () => {
    if (disposed) return;
    disposed = true;
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
