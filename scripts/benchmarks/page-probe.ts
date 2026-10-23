import { collectPageSegments, selectPageTranslationRoot, type PageSegment } from '../../src/page/segments';
import { snapshotViewportPriorities } from '../../src/page/viewport';

export const PUBLIC_GO_URL = 'https://go.dev/talks/2012/splash.article?utm_source=chatgpt.com';

interface SourceRecord {
  id: number;
  segment: PageSegment;
  original: string[];
  visibleProse: boolean;
  host?: HTMLElement;
}

/** Identity mapping only; viewport geometry belongs exclusively to production code. */
export function translationHostForSegment(segment: PageSegment): HTMLElement | undefined {
  for (const candidate of [segment.anchor.nextSibling, segment.container.nextSibling]) {
    if (candidate?.nodeType === 1 && (candidate as Element).tagName === 'NEAR-PAGE-TRANSLATION'
      && (candidate as Element).hasAttribute('data-near-page-translation')) return candidate as HTMLElement;
  }
  return undefined;
}

export function summarizeSources(segments: readonly PageSegment[]) {
  return { sourceSegments: segments.length, sourceChars: segments.reduce((n, segment) => n + segment.text.length, 0),
    uniqueSourceTexts: new Set(segments.map(segment => segment.text)).size };
}

export interface ProbeSnapshot {
  elapsedMs: number;
  firstMs: number | null;
  firstProseMs: number | null;
  firstViewportProseMs: number | null;
  firstVisibleProseDomReadyMs: number | null;
  firstVisibleProseRafMs: number | null;
  firstVisibleProseSourceId: number | null;
  initialViewportAllDoneMs: number | null;
  fullDoneMs: number | null;
  doneAt: number | null;
  clickedAt: number;
  navigationStartedAt: number;
  toolbarReadyAt: number | null;
  selectionLength: number;
  visible: boolean;
  focused: boolean;
  visibilityFailures: number;
  sourceChanged: boolean;
  rootTag: string;
  sourceSegments: number;
  sourceChars: number;
  uniqueSourceTexts: number;
  completed: number;
  failed: number;
  pending: number;
  total: number;
  renderedSegments: number;
  translatedChars: number;
  chineseSegments: number;
  viewportTargets: number;
  initialViewportSourceIds: number[];
  viewportCompleted: number;
  unexpectedTranslations: number;
  mappingConflicts: number;
  status: string;
  statusText: string;
  errorCode: string;
  outputFingerprint?: string;
}

/** One explicitly started pass owns frozen original nodes, observers, and RAF. */
export class PageBenchmarkProbe {
  private readonly view: Window;
  private readonly bodyObserver: MutationObserver;
  private barObserver?: MutationObserver;
  private observedBar?: ShadowRoot;
  private toolbarReadyAt: number | null = null;
  private records: SourceRecord[] = [];
  private started = 0;
  private active = false;
  private raf?: number;
  private visibilityFailures = 0;
  private state?: ProbeSnapshot;
  private output: string[] = [];
  private readonly visibilityListener = () => {
    if (this.active && !this.isForeground()) this.visibilityFailures++;
  };

  constructor(private readonly page: Document = document) {
    if (!page.defaultView || !page.body) throw new Error('Public page document is not ready.');
    this.view = page.defaultView;
    this.bodyObserver = new MutationObserver(() => this.update());
    this.bodyObserver.observe(page.body, { subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ['data-state'] });
    page.addEventListener('visibilitychange', this.visibilityListener);
    this.view.addEventListener('blur', this.visibilityListener);
    this.update();
  }

  private isForeground(): boolean { return this.page.visibilityState === 'visible' && this.page.hasFocus(); }
  private bar(): ShadowRoot | null { return this.page.querySelector('near-page-translate')?.shadowRoot ?? null; }
  private ensurePublicPage(): void {
    if (this.view.location.href !== PUBLIC_GO_URL) throw new Error('Probe is restricted to the exact public Go URL.');
  }

  readiness() {
    this.ensurePublicPage(); this.update();
    return { toolbarReady: this.toolbarReadyAt !== null,
      canStart: !!this.bar()?.querySelector('button[aria-label="翻译整个页面"]'),
      visible: this.page.visibilityState === 'visible', focused: this.page.hasFocus(),
      navigationStartedAt: this.view.performance.timeOrigin, toolbarReadyAt: this.toolbarReadyAt };
  }

  prepare() {
    this.ensurePublicPage();
    if (!this.isForeground()) throw new Error('Benchmark page must be visible and focused before translation.');
    const button = this.bar()?.querySelector<HTMLButtonElement>('button[aria-label="翻译整个页面"]');
    if (!button) throw new Error('Public page is not in a state that can start translation.');
    const root = selectPageTranslationRoot(this.page);
    const segments = collectPageSegments(root);
    const priorities = snapshotViewportPriorities(segments);
    this.records = segments.map((segment, id) => ({ id, segment, original: segment.nodes.map(node => node.data),
      visibleProse: priorities.get(segment)?.visibleProse === true }));
    this.visibilityFailures = 0;
    this.output = [];
    this.started = this.view.performance.now();
    this.state = {
      elapsedMs: 0, firstMs: null, firstProseMs: null, firstViewportProseMs: null,
      firstVisibleProseDomReadyMs: null, firstVisibleProseRafMs: null, firstVisibleProseSourceId: null,
      initialViewportAllDoneMs: null, fullDoneMs: null, doneAt: null,
      clickedAt: this.view.performance.timeOrigin + this.started,
      navigationStartedAt: this.view.performance.timeOrigin, toolbarReadyAt: this.toolbarReadyAt,
      selectionLength: this.view.getSelection()?.toString().length ?? 0,
      visible: true, focused: true, visibilityFailures: 0, sourceChanged: false,
      rootTag: root.tagName.toLowerCase(), ...summarizeSources(segments),
      completed: 0, failed: 0, pending: 0, total: 0, renderedSegments: 0,
      translatedChars: 0, chineseSegments: 0, viewportTargets: this.records.filter(r => r.visibleProse).length,
      initialViewportSourceIds: this.records.filter(record => record.visibleProse).map(record => record.id),
      viewportCompleted: 0, unexpectedTranslations: 0, mappingConflicts: 0,
      status: 'idle', statusText: '', errorCode: '',
    };
    this.active = false;
    return { ...summarizeSources(segments), rootTag: root.tagName.toLowerCase(),
      viewportTargets: this.state.viewportTargets, initialViewportSourceIds: [...this.state.initialViewportSourceIds] };
  }

  start(): void {
    this.ensurePublicPage();
    if (!this.isForeground()) throw new Error('Benchmark page must remain visible and focused.');
    if (!this.state) this.prepare();
    const button = this.bar()?.querySelector<HTMLButtonElement>('button[aria-label="翻译整个页面"]');
    if (!button) throw new Error('Translation button is not ready.');
    this.started = this.view.performance.now();
    this.state!.clickedAt = this.view.performance.timeOrigin + this.started;
    this.active = true; button.click(); this.update();
  }

  private update(): void {
    const root = this.bar();
    if (root && root !== this.observedBar) {
      this.barObserver?.disconnect(); this.observedBar = root;
      this.barObserver = new MutationObserver(() => this.update());
      this.barObserver.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
    }
    if (root?.querySelector('[data-status]') && this.toolbarReadyAt === null)
      this.toolbarReadyAt = this.view.performance.timeOrigin + this.view.performance.now();
    const state = this.state;
    if (!state || !this.active) return;
    const elapsed = this.view.performance.now() - this.started;
    const used = new Set<HTMLElement>();
    const done = new Set<number>();
    const output = this.records.map(record => {
      if (!record.segment.container.isConnected || record.segment.nodes.some((node, i) => !node.isConnected || node.data !== record.original[i]))
        state.sourceChanged = true;
      if (!record.host?.isConnected) record.host = translationHostForSegment(record.segment);
      const host = record.host;
      if (!host) return '';
      if (used.has(host)) { state.mappingConflicts++; return ''; }
      used.add(host);
      const text = host.shadowRoot?.querySelector('span')?.textContent ?? '';
      if (host.dataset.state === 'done' && text.trim()) { done.add(record.id); return text; }
      return '';
    });
    const visibleDone = this.records.filter(record => record.visibleProse && done.has(record.id));
    if (done.size && state.firstMs === null) state.firstMs = elapsed;
    if (visibleDone.length && state.firstVisibleProseDomReadyMs === null && this.isForeground()) {
      state.firstVisibleProseDomReadyMs = elapsed;
      state.firstProseMs = elapsed; state.firstViewportProseMs = elapsed;
      state.firstVisibleProseSourceId = visibleDone[0]!.id;
      const nextVisibleFrame = () => {
        if (!this.active) return;
        if (this.isForeground()) state.firstVisibleProseRafMs = this.view.performance.now() - this.started;
        else this.raf = this.view.requestAnimationFrame(nextVisibleFrame);
      };
      this.raf = this.view.requestAnimationFrame(nextVisibleFrame);
    }
    if (state.viewportTargets > 0 && visibleDone.length === state.viewportTargets && state.initialViewportAllDoneMs === null)
      state.initialViewportAllDoneMs = elapsed;
    state.viewportCompleted = visibleDone.length;
    state.renderedSegments = done.size;
    state.translatedChars = output.reduce((n, text) => n + text.length, 0);
    state.chineseSegments = output.filter(text => /\p{Script=Han}/u.test(text)).length;
    state.unexpectedTranslations = this.page.querySelectorAll('near-page-translation[data-state="done"]').length - done.size;
    state.visible = this.page.visibilityState === 'visible'; state.focused = this.page.hasFocus();
    state.visibilityFailures = this.visibilityFailures;
    this.output = output;
    const aside = root?.querySelector<HTMLElement>('[data-status]');
    if (aside) {
      state.status = aside.dataset.status ?? '';
      for (const key of ['completed', 'failed', 'pending', 'total'] as const) state[key] = Number(aside.dataset[key] ?? 0);
      state.errorCode = aside.dataset.errorCode ?? '';
      state.statusText = root?.querySelector('[role="status"]')?.textContent ?? '';
    }
    if (state.status === 'done' && state.total > 0 && state.completed === state.total && !state.failed && !state.pending
      && done.size === this.records.length && state.fullDoneMs === null) {
      state.fullDoneMs = elapsed;
      state.doneAt = this.view.performance.timeOrigin + this.view.performance.now();
    }
    if (state.fullDoneMs === null) state.elapsedMs = elapsed;
    else state.elapsedMs = state.fullDoneMs;
  }

  async snapshot(): Promise<ProbeSnapshot | undefined> {
    this.ensurePublicPage(); this.update();
    if (!this.state) return;
    const snapshot = { ...this.state, initialViewportSourceIds: [...this.state.initialViewportSourceIds] };
    if (snapshot.fullDoneMs !== null) {
      const bytes = new TextEncoder().encode(JSON.stringify(this.output));
      snapshot.outputFingerprint = [...new Uint8Array(await this.view.crypto.subtle.digest('SHA-256', bytes))]
        .map(byte => byte.toString(16).padStart(2, '0')).join('');
    }
    return snapshot;
  }

  restore(): void {
    this.ensurePublicPage(); this.active = false;
    if (this.raf !== undefined) this.view.cancelAnimationFrame(this.raf);
    const button = this.bar()?.querySelector<HTMLButtonElement>('button[aria-label="显示原文"]');
    if (!button) throw new Error('Restore-original button is unavailable.');
    button.click();
  }

  restored(): boolean {
    this.ensurePublicPage();
    return !this.page.querySelector('near-page-translation') && !!this.bar()?.querySelector('button[aria-label="翻译整个页面"]');
  }

  stop(): void { this.ensurePublicPage(); this.bar()?.querySelector<HTMLButtonElement>('button[aria-label="停止翻译"]')?.click(); }
  cleanup(): void {
    this.active = false; this.bodyObserver.disconnect(); this.barObserver?.disconnect();
    if (this.raf !== undefined) this.view.cancelAnimationFrame(this.raf);
    this.page.removeEventListener('visibilitychange', this.visibilityListener);
    this.view.removeEventListener('blur', this.visibilityListener);
    this.records = []; this.output = [];
  }
}

declare global { interface Window { __nearInstalledBenchmarkProbe?: PageBenchmarkProbe } }
if (typeof window !== 'undefined' && typeof document !== 'undefined' && location.href === PUBLIC_GO_URL && document.body) {
  window.__nearInstalledBenchmarkProbe?.cleanup();
  window.__nearInstalledBenchmarkProbe = new PageBenchmarkProbe(document);
}
