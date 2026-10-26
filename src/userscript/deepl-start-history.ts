import { TranslationFailure } from '../core/errors';
import { DEEPL_USERSCRIPT_SCHEDULING } from '../shared/translation-policy';
import { GM_STORAGE_PREFIX, requireUserscriptStorage } from './gm';

export const DEEPL_START_HISTORY_PREFIX = 'deepl-web:start-history:v1:';
export interface DeepLStartHistoryStorage {
  keys(): string[];
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  delete(key: string): void;
}
interface Start { ownerId: string; sequence: number; at: number }
interface Entry extends Start { key: string }
const WINDOW_MS = DEEPL_USERSCRIPT_SCHEDULING.startWindow.durationMs;
const validOwner = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(value);
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const invalid = () => new TranslationFailure('CONFIG', 'DeepL 的请求历史无法验证，已暂停该服务；请刷新页面后重试。');
const identifier = () => [...crypto.getRandomValues(new Uint32Array(4))].map(value => value.toString(16).padStart(8, '0')).join('');
const gmStorage: DeepLStartHistoryStorage = {
  keys() { requireUserscriptStorage(); return GM_listValues(); },
  get(key) { requireUserscriptStorage(); return GM_getValue(key); },
  set(key, value) { requireUserscriptStorage(); GM_setValue(key, value); },
  delete(key) { requireUserscriptStorage(); GM_deleteValue(key); },
};

/** Inherits visible reservations; GM caches and writes are not a global admission lock or durable acknowledgement. */
export function createDeepLStartHistory(storage: DeepLStartHistoryStorage = gmStorage,
  options: { ownerId?: string } = {}) {
  const ownerId = options.ownerId ?? identifier();
  if (!validOwner(ownerId)) throw invalid();
  const prefix = GM_STORAGE_PREFIX + DEEPL_START_HISTORY_PREFIX;
  let sequence = 0;
  const keyOf = (row: Start) => `${prefix}${row.ownerId}:${row.sequence}`;

  function parse(key: string, value: unknown): Entry {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
    const row = value as Record<string, unknown>;
    if (Object.keys(row).length !== 3 || !Object.hasOwn(row, 'ownerId') || !Object.hasOwn(row, 'sequence') || !Object.hasOwn(row, 'at')
      || !validOwner(row.ownerId) || typeof row.sequence !== 'number' || !Number.isSafeInteger(row.sequence) || row.sequence < 1
      || !timestamp(row.at)) throw invalid();
    const start: Start = { ownerId: row.ownerId, sequence: row.sequence, at: row.at };
    if (key !== keyOf(start)) throw invalid();
    return { key, ...start };
  }
  function inspect(): Entry[] {
    const entries: Entry[] = [];
    // Keys identify starts. Two different starts at the same millisecond both count.
    for (const key of new Set(storage.keys())) if (key.startsWith(prefix)) entries.push(parse(key, storage.get(key)));
    return entries;
  }
  function safe<T>(operation: () => T): T {
    try { return operation(); }
    catch { throw invalid(); } // Never expose arbitrary storage exceptions or values.
  }

  return {
    /** Excludes this document. Preserve old/future evidence; the scheduler alone samples the admission clock and filters its window. */
    read(): number[] {
      return safe(() => {
        return inspect().filter(row => row.ownerId !== ownerId)
          .map(row => row.at).sort((a, b) => a - b);
      });
    },
    /** Record admission before I/O; a later cancellation never refunds this reservation. */
    record(at: number): void {
      safe(() => {
        if (!timestamp(at) || !Number.isSafeInteger(sequence + 1)) throw invalid();
        const entries = inspect();
        const row: Start = { ownerId, sequence: sequence + 1, at };
        const key = keyOf(row);
        if (storage.get(key) !== undefined) throw invalid();
        sequence = row.sequence; // Do not reuse an identity after an ambiguous failed write.
        storage.set(key, row);
        const stored = parse(key, storage.get(key));
        if (stored.at !== at) throw invalid();
        entries.push(stored);
        const anchor = entries.reduce((best, entry) => entry.at > best.at || entry.at === best.at && entry.key > best.key ? entry : best);
        // Only a newly recorded start authorizes GC at this captured time. Keep
        // the greatest immutable anchor, including a future one after rollback.
        // Idle/read-time deletion would need a separate durable clock watermark.
        for (const entry of entries) if (entry.key !== anchor.key && entry.at <= at - WINDOW_MS) storage.delete(entry.key);
      });
    },
  };
}
