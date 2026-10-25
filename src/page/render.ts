import type { TranslationError } from '../shared/contracts';
import { segmentIsCurrent, type PageSegment } from './segments';
import type { TargetLanguage } from '../shared/languages';

export type SegmentView = {
  status: 'loading' | 'done' | 'error' | 'stopped';
  text?: string;
  error?: TranslationError;
};

const inheritedProperties = ['color', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'text-align'];
type SourceStyle = { display: string; inherited: string[] };
type PendingLoading = { token: symbol; epoch: number; document: Document; url: string; values: string[]; targetLanguage: TargetLanguage };

/** Owns only inserted translations. The site's nodes and attributes remain untouched. */
export class PageTranslationRenderer {
  private readonly entries = new Map<PageSegment, { host: HTMLElement; text: HTMLElement; view: SegmentView; targetLanguage: TargetLanguage }>();
  private readonly pending = new Map<PageSegment, PendingLoading>();
  private epoch = 0;
  private frame?: number;
  private frameToken?: symbol;

  update(segment: PageSegment, view: SegmentView, targetLanguage: TargetLanguage = 'zh-Hans'): void {
    this.pending.delete(segment);
    if (view.status === 'stopped') { this.remove(segment); return; }
    if (!segment.anchor.isConnected || !segment.container.isConnected) { this.remove(segment); return; }
    let entry = this.entries.get(segment);
    if (entry && !entry.host.isConnected) { this.remove(segment); entry = undefined; }
    if (!entry && view.status === 'loading') {
      this.pending.set(segment, { token: Symbol(), epoch: this.epoch, document: segment.container.ownerDocument, url: segment.container.ownerDocument.URL,
        values: segment.nodes.map(node => node.data), targetLanguage });
      this.scheduleLoading();
      return;
    }
    if (!entry) {
      entry = this.createEntry(segment, view, targetLanguage, this.readSourceStyle(segment));
      if (this.entries.get(segment) !== entry || entry.view !== view) return;
    }
    this.applyView(entry, view);
  }

  private readSourceStyle(segment: PageSegment): SourceStyle {
    const source = segment.container.ownerDocument.defaultView!.getComputedStyle(segment.container);
    // Computed styles are live. Copy their strings before any host is inserted.
    return { display: source.display, inherited: inheritedProperties.map(property => source.getPropertyValue(property)) };
  }

  private createEntry(segment: PageSegment, view: SegmentView, targetLanguage: TargetLanguage, source: SourceStyle) {
    const doc = segment.container.ownerDocument;
    const host = doc.createElement('near-page-translation');
    host.setAttribute('data-near-translation', '');
    host.setAttribute('data-near-page-translation', '');
    host.setAttribute('translate', 'no');
    host.setAttribute('lang', targetLanguage);
    host.setAttribute('dir', 'auto');
    host.style.cssText = 'all:initial!important;display:block!important;margin:0.45em 0 0.7em!important;white-space:pre-wrap!important;overflow-wrap:anywhere!important;';
    inheritedProperties.forEach((property, index) => host.style.setProperty(property, source.inherited[index]!, 'important'));
    if (targetLanguage === 'ar') { host.style.setProperty('direction', 'rtl', 'important'); host.style.setProperty('text-align', 'start', 'important'); }
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
    const entry = { host, text, view, targetLanguage };
    this.entries.set(segment, entry);
    anchor.parentNode?.insertBefore(host, anchor.nextSibling);
    return entry;
  }

  private applyView(entry: { host: HTMLElement; text: HTMLElement; view: SegmentView }, view: SegmentView): void {
    entry.view = view;
    entry.host.setAttribute('data-state', view.status);
    if (entry.view !== view) return;
    entry.text.dataset.state = view.status;
    if (entry.view !== view) return;
    // Model output never becomes HTML, including on sites allowing inline scripts.
    entry.text.textContent = view.status === 'done' ? view.text ?? ''
      : view.status === 'error' ? `翻译失败：${view.error?.message ?? '请在右侧翻译栏重试。'}` : '翻译中…';
  }

  private scheduleLoading(): void {
    if (this.frameToken !== undefined) return;
    const token = Symbol();
    this.frameToken = token;
    this.frame = requestAnimationFrame(() => {
      if (this.frameToken !== token) return;
      this.frame = undefined;
      this.frameToken = undefined;
      this.flushLoading();
    });
  }

  private pendingIsCurrent(segment: PageSegment, pending: PendingLoading): boolean {
    return this.pending.get(segment)?.token === pending.token && pending.epoch === this.epoch
      && segment.container.ownerDocument === pending.document && pending.document.URL === pending.url
      && segment.anchor.isConnected && segment.container.isConnected
      && segment.nodes.length === pending.values.length
      && segment.nodes.every((node, index) => node.isConnected && segment.container.contains(node) && node.data === pending.values[index]);
  }

  private flushLoading(): void {
    const prepared: Array<{ segment: PageSegment; pending: PendingLoading; source: SourceStyle }> = [];
    for (const [segment, pending] of [...this.pending]) {
      if (this.pendingIsCurrent(segment, pending) && segmentIsCurrent(segment)) {
        prepared.push({ segment, pending, source: this.readSourceStyle(segment) });
      } else if (this.pending.get(segment)?.token === pending.token) this.pending.delete(segment);
    }
    // Full eligibility and style reads above precede every insertion in this frame.
    for (const { segment, pending, source } of prepared) {
      if (!this.pendingIsCurrent(segment, pending)) {
        if (this.pending.get(segment)?.token === pending.token) this.pending.delete(segment);
        continue;
      }
      const view: SegmentView = { status: 'loading' };
      const entry = this.createEntry(segment, view, pending.targetLanguage, source);
      // Connecting a custom host can synchronously stop, clear or finish it.
      if (!this.pendingIsCurrent(segment, pending) || this.entries.get(segment) !== entry || entry.view !== view) {
        if (this.entries.get(segment) === entry && entry.view === view) this.remove(segment);
        continue;
      }
      this.pending.delete(segment);
      this.applyView(entry, view);
    }
  }

  prune(isCurrent: (segment: PageSegment) => boolean): void {
    for (const segment of [...this.pending.keys()]) if (!isCurrent(segment)) this.remove(segment);
    for (const [segment, entry] of [...this.entries]) {
      if (!isCurrent(segment)) this.remove(segment);
      else if (!entry.host.isConnected) this.update(segment, entry.view, entry.targetLanguage);
    }
  }

  clear(): void {
    this.epoch++;
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;
    this.frameToken = undefined;
    this.pending.clear();
    for (const entry of this.entries.values()) entry.host.remove();
    this.entries.clear();
  }

  private remove(segment: PageSegment): void {
    this.pending.delete(segment);
    this.entries.get(segment)?.host.remove();
    this.entries.delete(segment);
  }
}
