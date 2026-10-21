import { defineContentScript } from 'wxt/utils/define-content-script';
import { mountSelectionTranslator } from '../selection/mount';
import { mountPageTranslator } from '../page/mount';

export default defineContentScript({
  registration: 'runtime',
  main(ctx) {
    if (document.querySelector('near-translate[data-near-translate]')) return;
    const disposeSelection = mountSelectionTranslator({ source: 'web' });
    const disposePage = window.top === window ? mountPageTranslator() : undefined;
    ctx.onInvalidated(() => { disposePage?.(); disposeSelection(); });
  },
});
