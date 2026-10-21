import { TranslationClient } from '../platform/translation-client';
import type { TranslationError, TranslationInput, TranslationServerMessage } from '../shared/contracts';
import { PAGE_BATCH_MAX_ITEMS, PAGE_BATCH_TARGET_CHARS, PAGE_CONCURRENCY, splitPageBatchText } from './batches';
import { segmentIsCurrent, type PageSegment } from './segments';

export const MAX_PAGE_SEGMENTS = 1_500;
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
}
export interface PageTranslationClient {
  start(input: TranslationInput): string;
  cancel(): void;
  dispose(): void;
}
type ClientFactory = (receive: (event: TranslationServerMessage) => void) => PageTranslationClient;
type ItemStatus = 'queued' | 'loading' | 'done' | 'error' | 'stopped' | 'skipped';
interface Item { segment: PageSegment; key: string; status: ItemStatus }
interface Part { text: string; status: ItemStatus; translation?: string; error?: TranslationError }
interface Group { items: Item[]; parts: Part[]; status: ItemStatus; error?: TranslationError }
interface Task { group: Group; part: Part }
interface Worker {
  client: PageTranslationClient;
  active?: { tasks: Task[]; requestId: string; generation: number };
}
const STOP_ERRORS = new Set<TranslationError['code']>(['AUTH', 'BALANCE', 'CONFIG', 'RATE_LIMIT', 'DISCONNECTED']);
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

  start(segments: PageSegment[]): void {
    if (this.disposed) return;
    this.stopWork(); this.clearCache(); this.status = 'running'; this.append(segments);
  }

  /** Restoring the original releases cached page text and retained DOM references. */
  reset(): void {
    if (this.disposed) return;
    this.stopWork(); this.clearCache(); this.status = 'idle'; this.changed();
  }

  /** Newly loaded paragraphs join only an explicitly started, non-stopped session. */
  append(segments: PageSegment[]): void {
    if (this.disposed || this.status === 'idle' || this.status === 'stopped') return;
    this.pruneStale();
    for (const segment of segments) {
      if (!segmentIsCurrent(segment)) continue;
      const key = this.segmentKey(segment);
      if (this.segmentKeys.has(key)) continue;
      if (this.acceptedCount >= MAX_PAGE_SEGMENTS) { this.limitReached = true; break; }
      this.segmentKeys.add(key); this.acceptedCount++;
      let group = this.groups.get(segment.text);
      if (!group) {
        group = { items: [], parts: splitPageBatchText(segment.text).map(text => ({ text, status: 'queued' })), status: 'queued' };
        this.groups.set(segment.text, group);
      }
      if (group.status === 'skipped') for (const part of group.parts) if (part.status === 'skipped') part.status = 'queued';
      // A newly observed duplicate must receive the existing cached result as well.
      const item: Item = { segment, key, status: 'queued' };
      group.items.push(item); this.refreshGroup(group);
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
    this.clearCache();
  }

  private clearCache(): void {
    this.groups.clear(); this.segmentKeys.clear(); this.nodeIds = new WeakMap();
    this.nextNodeId = 0; this.acceptedCount = 0; this.prunedCount = 0; this.limitReached = false; this.error = undefined;
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

  private takeBatch(): Task[] {
    const tasks: Task[] = [];
    let characters = 0;
    for (const group of this.groups.values()) {
      if (!group.parts.some(part => part.status === 'queued')) continue;
      for (const item of group.items) this.skipStale(item);
      if (!group.items.length || group.items.every(item => item.status === 'skipped')) {
        for (const part of group.parts) if (part.status === 'queued') part.status = 'skipped';
        group.status = 'skipped'; continue;
      }
      for (const part of group.parts) {
        if (part.status !== 'queued') continue;
        const size = part.text.length + (tasks.length ? 1 : 0);
        if (tasks.length && (characters + size > PAGE_BATCH_TARGET_CHARS || tasks.length >= PAGE_BATCH_MAX_ITEMS)) return tasks;
        tasks.push({ group, part }); characters += size; part.status = 'loading';
      }
    }
    return tasks;
  }

  private pump(): void {
    for (const worker of this.workers) {
      if (worker.active) continue;
      const tasks = this.takeBatch();
      if (!tasks.length) break;
      for (const group of new Set(tasks.map(task => task.group))) this.refreshGroup(group);
      const pageSegments = tasks.map(task => task.part.text);
      worker.active = { tasks, generation: this.generation,
        requestId: worker.client.start({ text: pageSegments.join('\n'), kind: 'text', pageSegments }) };
    }
    this.reconcileStatus(); this.changed();
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
      this.failTasks(active.tasks, event.error);
      if (STOP_ERRORS.has(event.error.code)) { this.error = event.error; this.stopWork(); this.status = 'stopped'; }
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

  private refreshGroup(group: Group): void {
    if (!group.items.length) { group.status = 'skipped'; return; }
    const failed = group.parts.find(part => part.status === 'error');
    group.error = failed?.error;
    group.status = group.parts.every(part => part.status === 'done') ? 'done'
      : failed ? 'error' : group.parts.some(part => part.status === 'loading') ? 'loading'
      : group.parts.some(part => part.status === 'queued') ? 'queued'
      : group.parts.some(part => part.status === 'stopped') ? 'stopped' : 'skipped';
    for (const item of group.items) {
      if (this.skipStale(item)) continue;
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

  private skipStale(item: Item): boolean {
    if (item.status === 'skipped') return true;
    if (segmentIsCurrent(item.segment)) return false;
    item.status = 'skipped'; this.callbacks.onSegment(item.segment, { status: 'stopped' }); return true;
  }

  private pruneStale(): void {
    for (const group of this.groups.values()) {
      group.items = group.items.filter(item => {
        if (item.status !== 'skipped' && segmentIsCurrent(item.segment)) return true;
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
