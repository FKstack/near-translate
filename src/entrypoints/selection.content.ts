import { defineContentScript } from 'wxt/utils/define-content-script';
import { mountSelectionTranslator } from '../selection/mount';
import { mountPageTranslator } from '../page/mount';
import { createReadingMode, type ReadingModeController } from '../reading/mount';
import { browser } from 'wxt/browser';
import { TranslationServiceStatusClient } from '../platform/service-status';

export default defineContentScript({
  registration: 'runtime',
  main(ctx) {
    if (document.querySelector('near-translate[data-near-translate],near-reading-mode[data-near-page-ui]')) return;
    let selectionHost: HTMLElement | undefined;
    const serviceStatus = new TranslationServiceStatusClient();
    let closeSelection = () => {};
    const disposeSelection = mountSelectionTranslator({ source: 'web', onHost: (host, close) => { selectionHost = host; closeSelection = close; } });
    const topLevel = window.top === window;
    let reading: ReadingModeController | undefined;
    const getReading = () => {
      if (!topLevel) return;
      return reading ??= createReadingMode({ serviceStatus, onSelectionPortal(portal) {
        closeSelection();
        if (selectionHost) (portal ?? document.documentElement).append(selectionHost);
      } });
    };
    let openReading = () => getReading()?.open();
    const disposePage = topLevel ? mountPageTranslator({
      serviceStatus,
      onRead: translations => getReading()?.open(translations), onReadingAction: action => { openReading = action; },
    }) : undefined;
    const onMessage = (message: unknown, sender: { id?: string }) => {
      if (!topLevel || sender.id !== browser.runtime.id || (message as { type?: string })?.type !== 'open-reading-mode') return;
      openReading(); return Promise.resolve({ ok: true });
    };
    const onShortcut = (event: KeyboardEvent) => {
      if (!topLevel || !event.altKey || !event.shiftKey || event.code !== 'KeyR') return;
      event.preventDefault(); openReading();
    };
    browser.runtime.onMessage.addListener(onMessage);
    document.addEventListener('keydown', onShortcut, true);
    ctx.onInvalidated(() => {
      browser.runtime.onMessage.removeListener(onMessage); document.removeEventListener('keydown', onShortcut, true);
      disposePage?.(); reading?.dispose(); disposeSelection(); serviceStatus.dispose(); selectionHost = undefined;
    });
  },
});
