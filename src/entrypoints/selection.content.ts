import { defineContentScript } from 'wxt/utils/define-content-script';
import { mountSelectionTranslator } from '../selection/mount';

export default defineContentScript({
  registration: 'runtime',
  main(ctx) {
    if (document.querySelector('near-translate[data-near-translate]')) return;
    const dispose = mountSelectionTranslator({ source: 'web' });
    ctx.onInvalidated(dispose);
  },
});
