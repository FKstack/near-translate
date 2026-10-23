import { defineContentScript } from 'wxt/utils/define-content-script';
import { browser } from 'wxt/browser';

/** Optional metadata-only preparation; page text still waits for a translate click. */
export default defineContentScript({
  registration: 'runtime',
  main(ctx) {
    if (window.top !== window || !/^https?:$/.test(location.protocol)
      || document.visibilityState !== 'visible' || document.contentType === 'application/pdf') return;
    const requestId = crypto.randomUUID();
    let pending = true;
    const cleanup = () => {
      pending = false;
      window.removeEventListener('pagehide', cancel);
    };
    const cancel = () => {
      if (!pending) return;
      cleanup();
      try { void browser.runtime.sendMessage({ type: 'cancel-network-preparation', requestId }).catch(() => {}); }
      catch { /* The extension may already have been invalidated. */ }
    };
    window.addEventListener('pagehide', cancel, { once: true });
    ctx.onInvalidated(cancel);
    try {
      void browser.runtime.sendMessage({ type: 'prepare-translation-network', requestId }).catch(() => {}).finally(cleanup);
    } catch { cleanup(); }
  },
});
