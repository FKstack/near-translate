import { PageTranslationSession, type PageSessionState } from '../page/session';
import { collectPageSegments, type PageSegment } from '../page/segments';
import { snapshotViewportPriorities } from '../page/viewport';
import type { PageExecutionPolicy } from '../shared/translation-policy';
import { resolveLanguagePair, type LanguageOptions, type LanguagePair } from '../shared/languages';

interface TranslationEntry { output: HTMLElement; originals: HTMLElement[] }

/** Owns the reading snapshot's translations. It never edits the source website. */
export class ReadingTranslation {
  private readonly session: PageTranslationSession;
  private readonly segments: PageSegment[];
  private readonly sourceValues = new Map<PageSegment, string[]>();
  private readonly entries = new Map<PageSegment, TranslationEntry>();
  private disposed = false;
  private started = false;
  private policy?: PageExecutionPolicy;
  private preview: PageSessionState;
  private readonly languages: LanguagePair;

  constructor(private readonly root: HTMLElement, seed: ReadonlyMap<string, string>, private readonly changed: (state: PageSessionState) => void,
    languages: LanguageOptions = {}) {
    this.languages = resolveLanguagePair(languages);
    this.segments = collectPageSegments(root, this.languages);
    for (const segment of this.segments) this.sourceValues.set(segment, segment.nodes.map(node => node.data));
    this.session = new PageTranslationSession({
      // Visibility is a reader presentation choice; immutable text and DOM ownership remain strict.
      isCurrent: segment => this.current(segment),
      onChange: state => { if (!this.disposed && this.started) this.changed(state); },
      onSegment: (segment, view) => {
        if (this.disposed || !this.current(segment)) return;
        if (view.status === 'stopped') {
          const current = this.entries.get(segment);
          if (current?.output.dataset.state === 'loading') {
            current.output.dataset.state = 'stopped'; current.output.textContent = '翻译已暂停';
          }
          return;
        }
        const entry = this.entry(segment);
        entry.output.dataset.state = view.status;
        entry.output.textContent = view.status === 'done' ? view.text : view.status === 'error' ? `翻译失败：${view.error.message}` : '翻译中…';
        if (view.status === 'done') for (const original of entry.originals) original.dataset.nearReaderTranslated = 'true';
      },
    });
    this.session.seedTranslations(seed);
    const validated = this.session.translationSnapshot;
    let completed = 0;
    for (const segment of this.segments) {
      const cached = validated.get(segment.text);
      if (cached === undefined) continue;
      const entry = this.entry(segment);
      entry.output.textContent = cached; entry.output.dataset.state = 'done';
      for (const original of entry.originals) original.dataset.nearReaderTranslated = 'true';
      completed++;
    }
    this.preview = { status: 'idle', total: this.segments.length, completed, failed: 0,
      pending: this.segments.length - completed, skipped: 0, limitReached: false };
  }

  get state(): PageSessionState { return this.started ? this.session.state : this.preview; }
  get snapshot(): ReadonlyMap<string, string> { return this.session.translationSnapshot; }

  start(policy: PageExecutionPolicy): void {
    if (this.disposed) return;
    this.started = true; this.policy = policy;
    this.session.start(this.segments, policy);
    this.refreshViewport();
  }

  retry(): void { if (!this.disposed && this.started) { this.session.retryFailed(); this.refreshViewport(); } }
  stop(): void { if (!this.disposed && this.started) this.session.cancel(); }
  refreshViewport(): void {
    if (this.disposed || !this.policy?.viewportPriority) return;
    const snapshot = this.session.viewportSnapshot;
    if (snapshot.segments.length) this.session.updateViewportPriorities(snapshot.generation, snapshotViewportPriorities(snapshot.segments));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.session.dispose();
    for (const entry of this.entries.values()) {
      entry.output.remove();
      for (const original of entry.originals) {
        if (original.tagName === 'SPAN') original.replaceWith(...original.childNodes);
        else { original.removeAttribute('data-near-reader-original'); original.removeAttribute('data-near-reader-translated'); }
      }
    }
    this.entries.clear(); this.sourceValues.clear();
  }

  private current(segment: PageSegment): boolean {
    const values = this.sourceValues.get(segment);
    return Boolean(values && this.root.isConnected && this.root.contains(segment.container)
      && segment.nodes.every((node, index) => node.isConnected && segment.container.contains(node) && node.data === values[index]));
  }

  private entry(segment: PageSegment): TranslationEntry {
    const existing = this.entries.get(segment);
    if (existing) return existing;
    const doc = this.root.ownerDocument;
    const originals: HTMLElement[] = [];
    for (const text of segment.nodes) {
      const code = text.parentElement?.closest<HTMLElement>('code,kbd,samp');
      if (code && segment.container.contains(code)) {
        code.setAttribute('data-near-reader-original', '');
        if (!originals.includes(code)) originals.push(code);
        continue;
      }
      const original = doc.createElement('span');
      original.setAttribute('data-near-reader-original', '');
      text.parentNode!.insertBefore(original, text); original.append(text); originals.push(original);
    }
    let anchor = segment.anchor;
    while (anchor.parentNode && anchor.parentNode !== segment.container) anchor = anchor.parentNode;
    const output = doc.createElement('div');
    output.setAttribute('data-near-reader-translation', '');
    output.setAttribute('data-near-page-translation', '');
    output.setAttribute('translate', 'no');
    output.lang = this.languages.targetLanguage;
    output.dir = 'auto';
    anchor.parentNode?.insertBefore(output, anchor.nextSibling);
    const entry = { output, originals };
    this.entries.set(segment, entry);
    return entry;
  }
}
