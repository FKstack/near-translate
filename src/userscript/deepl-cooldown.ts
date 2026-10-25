import { TranslationFailure } from '../core/errors';
import { GM_STORAGE_PREFIX, requireUserscriptStorage } from './gm';

export const DEEPL_COOLDOWN_KEY = 'deepl-web:cooldown-until:v1';
export const DEEPL_COOLDOWN_NOTICE_KEY = 'deepl-web:cooldown-notice:v1';
export const DEEPL_COOLDOWN_EVENT_PREFIX = 'deepl-web:cooldown-event:v1:';

export interface CooldownStorage {
  keys(): string[];
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  delete(key: string): void;
}
type Event = { kind: 'limited'; until: number } | { kind: 'recovered'; throughUntil: number };
type Entry = { key: string; event: Event; value: number };
const invalid = () => new TranslationFailure('CONFIG', 'DeepL 的保护状态无法验证，请刷新页面后重试。');
const cancelled = () => new DOMException('翻译请求已取消。', 'AbortError');
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const gmStorage: CooldownStorage = {
  keys() { requireUserscriptStorage(); return GM_listValues(); },
  get(key) { return GM_getValue(key); },
  set(key, value) { requireUserscriptStorage(); GM_setValue(key, value); },
  delete(key) { requireUserscriptStorage(); GM_deleteValue(key); },
};
const identifier = () => [...crypto.getRandomValues(new Uint32Array(4))].map(value => value.toString(16).padStart(8, '0')).join('');

/** Immutable max registers: eventual GM broadcasts are not a global admission lock. */
export function createDeepLCooldownStore(storage: CooldownStorage = gmStorage,
  options: { clock?: () => number; identifier?: () => string } = {}) {
  const clock = options.clock ?? (() => Date.now());
  const id = options.identifier ?? identifier;
  const legacyKey = GM_STORAGE_PREFIX + DEEPL_COOLDOWN_KEY;
  const eventPrefix = GM_STORAGE_PREFIX + DEEPL_COOLDOWN_EVENT_PREFIX;
  const noticeKey = GM_STORAGE_PREFIX + DEEPL_COOLDOWN_NOTICE_KEY;

  function inspect() {
    const legacy = storage.get(legacyKey);
    if (legacy !== undefined && !timestamp(legacy)) throw invalid();
    const entries: Entry[] = [];
    let limited = legacy ?? 0;
    let recovered = 0;
    for (const key of storage.keys()) {
      if (!key.startsWith(eventPrefix)) continue;
      const event = storage.get(key);
      if (!event || typeof event !== 'object' || Array.isArray(event)) throw invalid();
      const row = event as Record<string, unknown>;
      if (row.kind === 'limited' && timestamp(row.until)) {
        limited = Math.max(limited, row.until);
        entries.push({ key, event: { kind: 'limited', until: row.until }, value: row.until });
      } else if (row.kind === 'recovered' && timestamp(row.throughUntil)) {
        recovered = Math.max(recovered, row.throughUntil);
        entries.push({ key, event: { kind: 'recovered', throughUntil: row.throughUntil }, value: row.throughUntil });
      } else throw invalid();
    }
    // An acknowledgement from the future indicates a backward wall-clock move.
    // Keep protection closed until that observed time catches up.
    const acknowledged = recovered <= clock() ? recovered : 0;
    return { entries, limited, recovered, until: limited > acknowledged ? limited : 0 };
  }

  function compact() {
    const { entries } = inspect();
    for (const kind of ['limited', 'recovered'] as const) {
      const same = entries.filter(entry => entry.event.kind === kind);
      const winner = same.reduce<Entry | undefined>((best, entry) => !best || entry.value > best.value
        || entry.value === best.value && entry.key > best.key ? entry : best, undefined);
      // Only delete a register dominated by another immutable register of the
      // same kind. Concurrent compactors cannot delete each other's winner.
      for (const entry of same) if (winner && entry.key !== winner.key) storage.delete(entry.key);
    }
  }

  function append(event: Event, isCurrent: () => boolean) {
    const suffix = id();
    if (!/^[a-zA-Z0-9-]{1,128}$/.test(suffix)) throw invalid();
    const key = eventPrefix + suffix;
    if (storage.get(key) !== undefined) throw invalid();
    if (!isCurrent()) throw cancelled();
    storage.set(key, event);
    return suffix;
  }

  return {
    /** Nonzero expired protection still requires a real successful recovery batch. */
    read(): number { return inspect().until; },
    limit(until: number): void {
      if (!timestamp(until)) throw invalid();
      inspect();
      const suffix = append({ kind: 'limited', until }, () => true);
      // Retain the legacy signal for already-open older scripts; correctness in
      // this version comes from the immutable registers, not read-max-write.
      storage.set(legacyKey, inspect().limited);
      storage.set(noticeKey, suffix);
      compact();
    },
    recover(throughUntil: number, isCurrent: () => boolean): void {
      if (!timestamp(throughUntil) || throughUntil > clock()) throw invalid();
      inspect();
      const suffix = append({ kind: 'recovered', throughUntil }, isCurrent);
      storage.set(noticeKey, suffix);
      compact();
    },
  };
}
