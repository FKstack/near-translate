import { describe, expect, it, vi } from 'vitest';
import { createDeepLCooldownStore, DEEPL_COOLDOWN_EVENT_PREFIX, DEEPL_COOLDOWN_KEY, type CooldownStorage } from '../../src/userscript/deepl-cooldown';
import { GM_STORAGE_PREFIX } from '../../src/userscript/gm';

const legacy = GM_STORAGE_PREFIX + DEEPL_COOLDOWN_KEY;
const prefix = GM_STORAGE_PREFIX + DEEPL_COOLDOWN_EVENT_PREFIX;
function fixture() {
  const values = new Map<string, unknown>();
  let now = 1_000;
  let sequence = 0;
  const storage: CooldownStorage = {
    keys: () => [...values.keys()],
    get: vi.fn(key => structuredClone(values.get(key))),
    set: (key, value) => { values.set(key, structuredClone(value)); },
    delete: key => { values.delete(key); },
  };
  const options = { clock: () => now, identifier: () => `event-${++sequence}` };
  return { values, storage, options, clock: (value: number) => { now = value; },
    store: createDeepLCooldownStore(storage, options), other: () => createDeepLCooldownStore(storage, options) };
}

describe('userscript immutable DeepL cooldown state', () => {
  it('keeps a clean service at zero without reading unrelated private values', () => {
    const f = fixture();
    f.values.set(GM_STORAGE_PREFIX + 'private-api-settings', { key: 'fixture-private-key' });
    expect(f.store.read()).toBe(0);
    expect(f.storage.get).not.toHaveBeenCalledWith(GM_STORAGE_PREFIX + 'private-api-settings');
  });

  it('retains the longest independent observation when a shorter legacy write arrives late', () => {
    const f = fixture();
    f.store.limit(120_000);
    f.other().limit(60_000);
    f.values.set(legacy, 60_000);
    expect(f.store.read()).toBe(120_000);
    expect(f.other().read()).toBe(120_000);
  });

  it('does not discard an expired cooldown until a real recovery is acknowledged', () => {
    const f = fixture();
    f.store.limit(60_000); f.clock(70_000);
    expect(f.other().read()).toBe(60_000);
    f.store.recover(60_000, () => true);
    expect(f.other().read()).toBe(0);
    expect(f.values.get(legacy)).toBe(60_000);
  });

  it('does not let an old successful probe acknowledge a newer restriction', () => {
    const f = fixture();
    f.store.limit(60_000); f.clock(70_000);
    f.other().limit(130_000);
    f.store.recover(60_000, () => true);
    expect(f.store.read()).toBe(130_000);
  });

  it('preserves a new restriction written during a recovery commit', () => {
    const f = fixture();
    f.store.limit(60_000); f.clock(70_000);
    const set = f.storage.set;
    f.storage.set = (key, value) => {
      set(key, value);
      if ((value as { kind?: string })?.kind === 'recovered')
        f.values.set(prefix + 'concurrent-limit', { kind: 'limited', until: 160_000 });
    };
    f.store.recover(60_000, () => true);
    expect(f.store.read()).toBe(160_000);
  });

  it('checks current ownership immediately before the immutable recovery write', () => {
    const f = fixture();
    f.store.limit(60_000); f.clock(70_000);
    let current = true;
    const get = f.storage.get;
    f.storage.get = key => { const value = get(key); current = false; return value; };
    expect(() => f.store.recover(60_000, () => current)).toThrow(expect.objectContaining({ name: 'AbortError' }));
    expect([...f.values.values()].some(value => (value as { kind?: string })?.kind === 'recovered')).toBe(false);
  });

  it('compacts only dominated registers while retaining both independent maxima', () => {
    const f = fixture();
    for (let i = 1; i <= 30; i++) f.other().limit(60_000 + i);
    f.clock(100_000); f.store.recover(60_030, () => true);
    f.other().recover(60_001, () => true);
    expect([...f.values.keys()].filter(key => key.startsWith(prefix))).toHaveLength(2);
    expect(f.store.read()).toBe(0);
    f.other().limit(160_000);
    expect(f.store.read()).toBe(160_000);
  });

  it('keeps protection closed across a backward wall-clock move', () => {
    const f = fixture();
    f.store.limit(60_000); f.clock(70_000); f.store.recover(60_000, () => true);
    expect(f.store.read()).toBe(0);
    f.clock(50_000);
    expect(f.other().read()).toBe(60_000);
  });

  it('never overwrites an immutable event on an identifier collision', () => {
    const f = fixture();
    const store = createDeepLCooldownStore(f.storage, { ...f.options, identifier: () => 'collision' });
    store.limit(120_000);
    expect(() => store.limit(60_000)).toThrow(expect.objectContaining({ code: 'CONFIG' }));
    expect(f.store.read()).toBe(120_000);
  });

  it.each([NaN, -1, '60000', { until: 60_000 }])('rejects an unverifiable legacy deadline %j', value => {
    const f = fixture(); f.values.set(legacy, value);
    expect(() => f.store.read()).toThrow(expect.objectContaining({ code: 'CONFIG' }));
  });

  it('rejects malformed owned records without including their contents in the error', () => {
    const f = fixture(); f.values.set(prefix + 'broken', { kind: 'unknown', secret: 'fixture-private' });
    expect(() => f.store.read()).toThrow(expect.objectContaining({ code: 'CONFIG' }));
    try { f.store.read(); } catch (error) { expect(String(error)).not.toContain('fixture-private'); }
  });
});
