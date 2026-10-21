import type { TranslationError } from '../shared/contracts';
import type { PageSegment } from './segments';

export type SegmentView = {
  status: 'loading' | 'done' | 'error' | 'stopped';
  text?: string;
  error?: TranslationError;
};

/** Owns only inserted translations. The site's nodes and attributes remain untouched. */
export class PageTranslationRenderer {
  private readonly entries = new Map<PageSegment, { host: HTMLElement; text: HTMLElement; view: SegmentView }>();

  update(segment: PageSegment, view: SegmentView): void {
    if (view.status === 'stopped') { this.remove(segment); return; }
    if (!segment.anchor.isConnected || !segment.container.isConnected) { this.remove(segment); return; }
    let entry = this.entries.get(segment);
    if (entry && !entry.host.isConnected) { this.remove(segment); entry = undefined; }
    if (!entry) {
      const doc = segment.container.ownerDocument;
      const host = doc.createElement('near-page-translation');
      host.setAttribute('data-near-translation', '');
      host.setAttribute('data-near-page-translation', '');
      host.setAttribute('translate', 'no');
      host.setAttribute('lang', 'zh-CN');
      const source = doc.defaultView!.getComputedStyle(segment.container);
      host.style.cssText = 'all:initial!important;display:block!important;margin:0.45em 0 0.7em!important;white-space:pre-wrap!important;overflow-wrap:anywhere!important;';
      for (const property of ['color', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'text-align']) {
        host.style.setProperty(property, source.getPropertyValue(property), 'important');
      }
      const shadow = host.attachShadow({ mode: 'open' });
      const style = doc.createElement('style');
      style.textContent = ':host{box-sizing:border-box}span{white-space:pre-wrap;overflow-wrap:anywhere}span[data-state="loading"],span[data-state="error"]{font:12px/1.7 system-ui,sans-serif;opacity:.8}span[data-state="loading"]{color:light-dark(#087e83,#58dadd)}';
      const text = doc.createElement('span');
      shadow.append(style, text);
      // A block inside a nowrap flex row would sit beside the English text.
      // Keep the source layout intact and put its translation after that block.
      const adjacent = ['flex', 'inline-flex', 'grid', 'inline-grid'].includes(source.display)
        && segment.container.parentElement
        && !['TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR'].includes(segment.container.parentElement.tagName);
      const anchor = adjacent ? segment.container : segment.anchor;
      anchor.parentNode?.insertBefore(host, anchor.nextSibling);
      entry = { host, text, view };
      this.entries.set(segment, entry);
    }
    entry.host.setAttribute('data-state', view.status);
    entry.view = view;
    entry.text.dataset.state = view.status;
    // Model output never becomes HTML, including on sites allowing inline scripts.
    entry.text.textContent = view.status === 'done' ? view.text ?? ''
      : view.status === 'error' ? `翻译失败：${view.error?.message ?? '请在右侧翻译栏重试。'}` : '翻译中…';
  }

  prune(isCurrent: (segment: PageSegment) => boolean): void {
    for (const [segment, entry] of [...this.entries]) {
      if (!isCurrent(segment)) this.remove(segment);
      else if (!entry.host.isConnected) this.update(segment, entry.view);
    }
  }

  clear(): void {
    for (const entry of this.entries.values()) entry.host.remove();
    this.entries.clear();
  }

  private remove(segment: PageSegment): void {
    this.entries.get(segment)?.host.remove();
    this.entries.delete(segment);
  }
}
