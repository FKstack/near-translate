import { TranslationClient } from '../platform/translation-client';
import type { TranslationError, TranslationInput, TranslationServerMessage } from '../shared/contracts';
import { MAX_PAGE_BATCH_ITEMS } from '../shared/contracts';
import { PAGE_BATCH_MAX_ITEMS, PAGE_BATCH_TARGET_CHARS, PAGE_CONCURRENCY, normalizePageBatchTargetChars, splitPageBatchText } from './batches';
import { MAX_PAGE_SEGMENTS, segmentIsCurrent, type PageSegment } from './segments';
import type { PageViewportPriority } from './viewport';

export { MAX_PAGE_SEGMENTS } from './segments';
const MAX_CACHED_TRANSLATIONS = 1_500;
const MAX_CACHED_BYTES = 2 * 1_024 * 1_024;
export interface PageTranslationState {
  status: 'idle' | 'running' | 'done' | 'stopped';
  total: number;
  completed: number;
  failed: number;
  skipped: number;
  pending: number;
  limitReached: boolean;
  error?: TranslationError;
}
export type PageSessionState = PageTranslationState;
export type PageSegmentUpdate =
  | { status: 'loading' | 'stopped' }
  | { status: 'done'; text: string }
  | { status: 'error'; error: TranslationError };
export interface PageSessionCallbacks {
  onChange(state: PageTranslationState): void;
  onSegment(segment: PageSegment, update: PageSegmentUpdate): void;
  isCurrent?(segment: PageSegment): boolean;
}
export interface PageScheduling {
  concurrency?: number; batchMaxItems?: number; batchTargetChars?: number; batchSeparatorChars?: 0 | 1 | 2;
  viewportPriority?: boolean; firstBatchMaxItems?: number; firstBatchTargetChars?: number; packing?: 'ordered' | 'fill';
}
export interface PageTranslationClient {
  start(input: TranslationInput): string;
  cancel(): void;
  dispose(): void;
}
type ClientFactory = (receive: (event: TranslationServerMessage) => void) => PageTranslationClient;
type ItemStatus = 'queued' | 'loading' | 'done' | 'error' | 'stopped' | 'skipped';
interface Item { segment: PageSegment; key: string; status: ItemStatus; priority?: PageViewportPriority }
interface Part { text: string; status: ItemStatus; translation?: string; error?: TranslationError }
interface Group { text: string; items: Item[]; parts: Part[]; status: ItemStatus; error?: TranslationError }
interface Task { group: Group; part: Part }
interface Worker {
  client: PageTranslationClient;
  active?: { tasks: Task[]; requestId: string; generation: number };
}
const STOP_ERRORS = new Set<TranslationError['code']>(['AUTH', 'BALANCE', 'CONFIG', 'RATE_LIMIT', 'DISCONNECTED', 'NETWORK', 'TIMEOUT']);
const INVALID_BATCH: TranslationError = { code: 'INVALID_RESPONSE', message: '整页译文不完整，请重试失败段落。', retryable: true };

/** Owns one bounded page session, including independent batches and all in-flight transports. */
export class PageTranslationSession {
  private readonly workers: Worker[];
  private groups = new Map<string, Group>();
  private segmentKeys = new Set<string>();
  private nodeIds = new WeakMap<Node, number>();
  private nextNodeId = 0;
  private acceptedCount = 0;
  private prunedCount = 0;
  private generation = 0;
  private status: PageTranslationState['status'] = 'idle';
  private limitReached = false;
  private error?: TranslationError;
  private pumping = false;
  private disposed = false;
  private concurrency = PAGE_CONCURRENCY;
  private batchMaxItems = PAGE_BATCH_MAX_ITEMS;
  private batchTargetChars = PAGE_BATCH_TARGET_CHARS;
  private batchSeparatorChars: 0 | 1 | 2 = 1;
  private viewportPriority = false;
  private firstBatchMaxItems = PAGE_BATCH_MAX_ITEMS;
  private firstBatchTargetChars = PAGE_BATCH_TARGET_CHARS;
  private packing: PageScheduling['packing'];
  private dispatchedBatches = 0;
  // Text only: hiding translations releases all DOM references, but can reuse successful work.
  private readonly translations = new Map<string, string>();
  private cachedBytes = 0;

  constructor(private readonly callbacks: PageSessionCallbacks, createClient: ClientFactory = receive => new TranslationClient(receive)) {
    this.workers = Array.from({ length: PAGE_CONCURRENCY }, () => {
      const worker = {} as Worker;
      worker.client = createClient(event => this.receive(worker, event));
      return worker;
    });
  }

  get state(): PageTranslationState {
    const items = Array.from(this.groups.values()).flatMap(group => group.items);
    return {
      status: this.status, total: items.length,
      completed: items.filter(item => item.status === 'done').length,
      failed: items.filter(item => item.status === 'error').length,
      skipped: this.prunedCount + items.filter(item => item.status === 'skipped').length,
      pending: items.filter(item => ['queued', 'loading', 'stopped'].includes(item.status)).length,
      limitReached: this.limitReached, error: this.error,
    };
  }

  /** Text-only copy for another view in this document; never exposes the owned cache. */
  get translationSnapshot(): ReadonlyMap<string, string> { return new Map(this.translations); }

  /** Import successful text before an explicit start, using the existing cache bounds. */
  seedTranslations(entries: ReadonlyMap<string, string>): void {
    if (this.disposed || this.status !== 'idle') return;
    for (const [text, translation] of entries) {
      if (typeof text !== 'string' || !text.trim() || typeof translation !== 'string' || !translation.trim()) continue;
      this.rememberTranslation(text, translation);
    }
  }

  start(segments: PageSegment[], scheduling: PageScheduling = {}): void {
    if (this.disposed) return;
    this.concurrency = Number.isInteger(scheduling.concurrency) ? Math.max(1, Math.min(PAGE_CONCURRENCY, scheduling.concurrency!)) : PAGE_CONCURRENCY;
    this.batchMaxItems = Number.isInteger(scheduling.batchMaxItems) ? Math.max(1, Math.min(MAX_PAGE_BATCH_ITEMS, scheduling.batchMaxItems!)) : PAGE_BATCH_MAX_ITEMS;
    this.batchTargetChars = normalizePageBatchTargetChars(scheduling.batchTargetChars);
    this.batchSeparatorChars = scheduling.batchSeparatorChars === 0 ? 0 : scheduling.batchSeparatorChars === 2 ? 2 : 1;
    this.viewportPriority = scheduling.viewportPriority === true;
    this.firstBatchMaxItems = Number.isInteger(scheduling.firstBatchMaxItems)
      ? Math.max(1, Math.min(this.batchMaxItems, scheduling.firstBatchMaxItems!)) : this.batchMaxItems;
    this.firstBatchTargetChars = scheduling.firstBatchTargetChars === undefined ? this.batchTargetChars
      : Math.min(this.batchTargetChars, normalizePageBatchTargetChars(scheduling.firstBatchTargetChars));
    this.packing = scheduling.packing;
    this.stopWork(); this.clearSession(); this.status = 'running'; this.append(segments);
  }

  /** The mount measures session-owned source identities, never newly collected duplicates. */
  get viewportSnapshot(): { generation: number; segments: readonly PageSegment[] } {
    return { generation: this.generation, segments: this.viewportPriority && this.status === 'running'
      ? Array.from(this.groups.values()).filter(group => group.parts.some(part => part.status === 'queued'))
        .flatMap(group => group.items.filter(item => item.status !== 'skipped').map(item => item.segment)) : [] };
  }

  updateViewportPriorities(generation: number, priorities: ReadonlyMap<PageSegment, PageViewportPriority>): void {
    if (this.disposed || this.status !== 'running' || !this.viewportPriority || generation !== this.generation) return;
    for (const group of this.groups.values()) {
      if (!group.parts.some(part => part.status === 'queued')) continue;
      for (const item of group.items) item.priority = priorities.get(item.segment);
    }
    this.schedulePump();
  }

  /** Always release DOM references; connection changes and navigation also invalidate text. */
  reset({ clearCache = true }: { clearCache?: boolean } = {}): void {
    if (this.disposed) return;
    this.stopWork(); this.clearSession();
    if (clearCache) this.clearTranslations();
    this.status = 'idle'; this.changed();
  }

  /** Newly loaded paragraphs join only an explicitly started, non-stopped session. */
  append(segments: PageSegment[]): void {
    if (this.disposed || this.status === 'idle' || this.status === 'stopped') return;
    this.pruneStale();
    for (const segment of segments) {
      if (!this.current(segment)) continue;
      const key = this.segmentKey(segment);
      if (this.segmentKeys.has(key)) continue;
      if (this.acceptedCount >= MAX_PAGE_SEGMENTS) { this.limitReached = true; break; }
      this.segmentKeys.add(key); this.acceptedCount++;
      let group = this.groups.get(segment.text);
      if (!group) {
        const cached = this.cachedTranslation(segment.text);
        group = { text: segment.text, items: [], parts: cached === undefined
          ? splitPageBatchText(segment.text, this.batchTargetChars).map(text => ({ text, status: 'queued' }))
          : [{ text: segment.text, status: 'done', translation: cached }], status: cached === undefined ? 'queued' : 'done' };
        this.groups.set(segment.text, group);
      }
      if (group.status === 'skipped') for (const part of group.parts) if (part.status === 'skipped') part.status = 'queued';
      // A newly observed duplicate must receive the existing cached result as well.
      const item: Item = { segment, key, status: 'queued' };
      group.items.push(item);
      // A sole new item was fully checked above, with no intervening callback
      // or DOM write. Other group refreshes still validate every owned source.
      this.refreshGroup(group, group.items.length === 1 ? item : undefined);
    }
    this.reconcileStatus(); this.changed(); this.schedulePump();
  }

  retryFailed(): void {
    if (this.disposed || this.status === 'idle' || this.status === 'running') return;
    for (const group of this.groups.values()) {
      for (const part of group.parts) {
        if (part.status !== 'stopped' && !(part.status === 'error' && part.error?.retryable)) continue;
        part.status = 'queued'; part.error = undefined;
      }
      this.refreshGroup(group);
    }
    this.error = undefined; this.status = 'running'; this.changed(); this.schedulePump();
  }

  cancel(): void {
    if (this.disposed || this.status === 'idle') return;
    this.stopWork(); this.status = 'stopped'; this.changed();
  }

  dispose(): void {
    if (this.disposed) return;
    this.stopWork(); this.disposed = true;
    for (const worker of this.workers) worker.client.dispose();
    this.clearSession(); this.clearTranslations();
  }

  private clearSession(): void {
    this.groups.clear(); this.segmentKeys.clear(); this.nodeIds = new WeakMap();
    this.nextNodeId = 0; this.acceptedCount = 0; this.prunedCount = 0; this.limitReached = false; this.error = undefined;
    this.dispatchedBatches = 0;
  }

  private clearTranslations(): void { this.translations.clear(); this.cachedBytes = 0; }

  private cachedTranslation(text: string): string | undefined {
    const translation = this.translations.get(text);
    if (translation !== undefined) {
      this.translations.delete(text); this.translations.set(text, translation);
    }
    return translation;
  }

  private rememberTranslation(text: string, translation: string): void {
    const bytes = (text.length + translation.length) * 2;
    if (bytes > MAX_CACHED_BYTES) return;
    const previous = this.translations.get(text);
    if (previous !== undefined) this.cachedBytes -= (text.length + previous.length) * 2;
    this.translations.delete(text); this.translations.set(text, translation); this.cachedBytes += bytes;
    while (this.translations.size > MAX_CACHED_TRANSLATIONS || this.cachedBytes > MAX_CACHED_BYTES) {
      const oldest = this.translations.keys().next().value!;
      this.cachedBytes -= (oldest.length + this.translations.get(oldest)!.length) * 2;
      this.translations.delete(oldest);
    }
  }

  private segmentKey(segment: PageSegment): string {
    const identity = segment.nodes.map(node => {
      let id = this.nodeIds.get(node);
      if (id === undefined) { id = ++this.nextNodeId; this.nodeIds.set(node, id); }
      return id;
    }).join(',');
    return `${identity}:${segment.text}`;
  }

  private changed(): void { if (!this.disposed) this.callbacks.onChange(this.state); }
  private schedulePump(): void {
    if (this.pumping || this.disposed) return;
    this.pumping = true;
    // Finish the terminal callback's transport cleanup before reusing the same port.
    queueMicrotask(() => { this.pumping = false; if (!this.disposed && this.status === 'running') this.pump(); });
  }

  private qualifyQueuedGroup(group: Group, current: () => boolean): boolean {
    for (const item of group.items) {
      this.skipStale(item);
      if (!current()) return false;
    }
    if (group.items.length && group.items.some(item => item.status !== 'skipped')) return true;
    for (const part of group.parts) if (part.status === 'queued') part.status = 'skipped';
    group.status = 'skipped';
    return false;
  }

  private takeBatch(current: () => boolean): Task[] {
    const tasks: Task[] = [];
    let characters = 0;
    const candidates: Group[] = [];
    for (const group of this.groups.values()) {
      if (!group.parts.some(part => part.status === 'queued')) continue;
      if (!group.items.length || group.items.every(item => item.status === 'skipped')) {
        for (const part of group.parts) if (part.status === 'queued') part.status = 'skipped';
        group.status = 'skipped'; continue;
      }
      candidates.push(group);
    }
    const firstVisibleBatch = this.viewportPriority && this.dispatchedBatches === 0
      // A stale visible source must not reserve an empty soft first batch and
      // prevent eligible sources farther down the page from being dispatched.
      && candidates.some(group => current() && this.groupPriority(group).visibleProse
        && this.qualifyQueuedGroup(group, current) && this.groupPriority(group).visibleProse);
    if (!current()) return tasks;
    // Qualification may remove the visible copy of a duplicated passage.
    // Sort using the surviving source identities, not its former priority.
    if (this.viewportPriority && this.dispatchedBatches % 4 !== 3) {
      candidates.sort((a, b) => {
        const left = this.groupPriority(a); const right = this.groupPriority(b);
        return left.tier - right.tier || left.distance - right.distance;
      });
    }
    const maxItems = firstVisibleBatch ? this.firstBatchMaxItems : this.batchMaxItems;
    const targetChars = firstVisibleBatch ? this.firstBatchTargetChars : this.batchTargetChars;
    // Compact only a small tail of whole queued paragraphs. Keep the priority/FIFO
    // anchor; split paragraphs and visible prose retain their existing order.
    if (this.packing === 'fill' && !firstVisibleBatch && candidates.length <= 16
      && candidates.every(group => group.parts.length === 1 && group.parts[0]!.status === 'queued')
      && !candidates.some(group => this.groupPriority(group).visibleProse)
      && (candidates.length > maxItems || candidates.reduce((total, group) => total + group.parts[0]!.text.length, 0)
        + Math.max(0, candidates.length - 1) * this.batchSeparatorChars > targetChars)) {
      const fillers = candidates.slice(1).sort((a, b) => b.parts[0]!.text.length - a.parts[0]!.text.length);
      candidates.splice(1, fillers.length, ...fillers);
    }
    for (const group of candidates) {
      if (!current()) return tasks;
      if (!group.parts.some(part => part.status === 'queued')) continue;
      if (firstVisibleBatch && !this.groupPriority(group).visibleProse) continue;
      let qualified = false;
      for (const part of group.parts) {
        if (part.status !== 'queued') continue;
        const size = part.text.length + (tasks.length ? this.batchSeparatorChars : 0);
        if (tasks.length >= maxItems) return tasks;
        // The first intact paragraph may exceed the soft first-batch budget, never the hard cap.
        if (tasks.length && characters + size > targetChars) {
          if (this.packing === 'fill' && !firstVisibleBatch) break;
          return tasks;
        }
        // Check complete source eligibility only when this group can actually
        // enter the batch. Unselected sources are checked on their own turn.
        if (!qualified) {
          if (!this.qualifyQueuedGroup(group, current)) break;
          if (firstVisibleBatch && !this.groupPriority(group).visibleProse) break;
          qualified = true;
        }
        if (!current()) return tasks;
        tasks.push({ group, part }); characters += size; part.status = 'loading';
      }
    }
    if (!tasks.length && firstVisibleBatch && current()) this.schedulePump();
    return tasks;
  }

  private groupPriority(group: Group): PageViewportPriority {
    let best: PageViewportPriority = { tier: 4, distance: Infinity, visibleProse: false };
    for (const item of group.items) {
      if (item.status === 'skipped' || !item.priority) continue;
      if (item.priority.tier < best.tier || item.priority.tier === best.tier && item.priority.distance < best.distance) best = item.priority;
    }
    return best;
  }

  private pump(): void {
    const generation = this.generation;
    const current = () => !this.disposed && this.status === 'running' && this.generation === generation;
    for (const worker of this.workers.slice(0, this.concurrency)) {
      if (!current()) return;
      if (worker.active) continue;
      const tasks = this.takeBatch(current);
      if (!current()) return;
      if (!tasks.length) break;
      for (const group of new Set(tasks.map(task => task.group))) {
        this.refreshGroup(group);
        if (!current()) return;
      }
      const selected = this.validateDispatch(tasks, current);
      if (!current()) return;
      if (!selected.length) { this.schedulePump(); continue; }
      const pageSegments = selected.map(task => task.part.text);
      this.dispatchedBatches++;
      const requestId = worker.client.start({ text: pageSegments.join('\n'), kind: 'text', pageSegments });
      if (!current()) { worker.client.cancel(); return; }
      worker.active = { tasks: selected, generation, requestId };
    }
    this.reconcileStatus(); this.changed();
  }

  /** Loading/stopped callbacks can synchronously edit another selected source. */
  private validateDispatch(tasks: Task[], current: () => boolean): Task[] {
    const groups = new Set(tasks.map(task => task.group));
    for (;;) {
      if (!current()) return [];
      const stale: Item[] = [];
      for (const group of groups) for (const item of group.items) {
        if (item.status !== 'skipped' && !this.current(item.segment)) stale.push(item);
      }
      if (!current()) return [];
      if (!stale.length) break;
      // Each cleanup permanently removes an item from this dispatch. Recheck
      // only selected groups after callbacks, so this converges without a
      // whole-queue scan or allowing an earlier source to become stale unnoticed.
      for (const item of stale) {
        this.markStale(item);
        if (!current()) return [];
      }
    }
    return tasks.filter(task => {
      if (task.group.items.some(item => item.status !== 'skipped')) return true;
      if (task.part.status === 'loading') task.part.status = 'skipped';
      task.group.status = 'skipped';
      return false;
    });
  }

  private receive(worker: Worker, event: TranslationServerMessage): void {
    const active = worker.active;
    if (this.disposed || this.status !== 'running' || !active || active.generation !== this.generation || active.requestId !== event.requestId) return;
    if (event.type === 'segment') {
      const task = active.tasks[event.index];
      if (!task || !Number.isInteger(event.index) || !event.text.trim() || task.part.status === 'done') return;
      this.complete(task, event.text); this.changed(); return;
    }
    if (event.type !== 'result' && event.type !== 'error') return;
    worker.active = undefined;
    if (event.type === 'result') {
      const translations = event.result.kind === 'text' ? event.result.segments : undefined;
      if (translations?.length === active.tasks.length && translations.every(text => typeof text === 'string' && text.trim())) {
        active.tasks.forEach((task, index) => this.complete(task, translations[index]!));
      } else if (active.tasks.length === 1 && event.result.kind === 'text' && !translations && event.result.translation.trim()) {
        // Compatibility with a transport returning one ordinary text result.
        this.complete(active.tasks[0]!, event.result.translation);
      } else this.failTasks(active.tasks, INVALID_BATCH);
    } else {
      if (STOP_ERRORS.has(event.error.code) || event.error.serviceWide === true) {
        // A connection or service-wide failure belongs to the session bar, not
        // every paragraph in this batch. Keep completed text and wait for the
        // user's next action before sending any unfinished work again.
        this.error = event.error; this.stopWork(); this.status = 'stopped';
      } else this.failTasks(active.tasks, event.error);
    }
    this.reconcileStatus(); this.changed(); this.schedulePump();
  }

  private complete(task: Task, text: string): void {
    if (task.part.status === 'done') return;
    task.part.translation = text; task.part.status = 'done'; task.part.error = undefined;
    this.refreshGroup(task.group);
  }

  private failTasks(tasks: Task[], error: TranslationError): void {
    const groups = new Set<Group>();
    for (const task of tasks) {
      if (task.part.status === 'done') continue;
      task.part.status = 'error'; task.part.error = error; groups.add(task.group);
    }
    for (const group of groups) {
      // A failed paragraph's unsent remainder waits for explicit retry.
      for (const part of group.parts) if (part.status === 'queued') { part.status = 'error'; part.error = error; }
      this.refreshGroup(group);
    }
  }

  private refreshGroup(group: Group, knownCurrent?: Item): void {
    if (!group.items.length) { group.status = 'skipped'; return; }
    const previousStatus = group.status;
    const failed = group.parts.find(part => part.status === 'error');
    group.error = failed?.error;
    group.status = group.parts.every(part => part.status === 'done') ? 'done'
      : failed ? 'error' : group.parts.some(part => part.status === 'loading') ? 'loading'
      : group.parts.some(part => part.status === 'queued') ? 'queued'
      : group.parts.some(part => part.status === 'stopped') ? 'stopped' : 'skipped';
    if (group.status === 'done' && previousStatus !== 'done') {
      this.rememberTranslation(group.text, group.parts.map(part => part.translation!).join('\n\n'));
    }
    for (const item of group.items) {
      if (item !== knownCurrent && this.skipStale(item)) continue;
      const previous = item.status; item.status = group.status;
      if (group.status === 'done' && previous !== 'done') this.callbacks.onSegment(item.segment, { status: 'done', text: group.parts.map(part => part.translation!).join('\n\n') });
      else if (group.status === 'error' && group.error && previous !== 'error') this.callbacks.onSegment(item.segment, { status: 'error', error: group.error });
      else if (group.status === 'loading' && previous !== 'loading') this.callbacks.onSegment(item.segment, { status: 'loading' });
      else if (['stopped', 'skipped'].includes(group.status) && previous !== group.status) this.callbacks.onSegment(item.segment, { status: 'stopped' });
    }
  }

  private reconcileStatus(): void {
    if (this.status === 'stopped' || this.status === 'idle') return;
    this.status = this.workers.some(worker => worker.active)
      || Array.from(this.groups.values()).some(group => group.items.length && group.parts.some(part => part.status === 'queued')) ? 'running' : 'done';
  }

  private current(segment: PageSegment): boolean { return this.callbacks.isCurrent?.(segment) ?? segmentIsCurrent(segment); }

  private skipStale(item: Item): boolean {
    if (item.status === 'skipped') return true;
    if (this.current(item.segment)) return false;
    this.markStale(item); return true;
  }

  private markStale(item: Item): void {
    if (item.status === 'skipped') return;
    item.status = 'skipped'; this.callbacks.onSegment(item.segment, { status: 'stopped' });
  }

  private pruneStale(): void {
    for (const group of this.groups.values()) {
      group.items = group.items.filter(item => {
        if (item.status !== 'skipped' && this.current(item.segment)) return true;
        this.segmentKeys.delete(item.key); this.prunedCount++; this.callbacks.onSegment(item.segment, { status: 'stopped' }); return false;
      });
      if (!group.items.length) {
        for (const part of group.parts) if (part.status === 'queued') part.status = 'skipped';
        group.status = 'skipped';
      }
    }
  }

  private stopWork(): void {
    this.generation++;
    for (const worker of this.workers) { worker.active = undefined; worker.client.cancel(); }
    for (const group of this.groups.values()) {
      for (const part of group.parts) if (part.status === 'queued' || part.status === 'loading') part.status = 'stopped';
      this.refreshGroup(group);
    }
  }
}
