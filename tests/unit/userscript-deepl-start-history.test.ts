import { describe, expect, it, vi } from 'vitest';
import { createDeepLStartHistory, DEEPL_START_HISTORY_PREFIX, type DeepLStartHistoryStorage } from '../../src/userscript/deepl-start-history';
import { GM_STORAGE_PREFIX } from '../../src/userscript/gm';

const prefix = GM_STORAGE_PREFIX + DEEPL_START_HISTORY_PREFIX;
function fixture() {
  const values = new Map<string, unknown>();
  const storage: DeepLStartHistoryStorage = {
    keys: () => [...values.keys()],
    get: vi.fn(key => structuredClone(values.get(key))),
    set: (key, value) => { values.set(key, structuredClone(value)); },
    delete: vi.fn(key => { values.delete(key); }),
  };
  const owner = (ownerId: string) => createDeepLStartHistory(storage, { ownerId });
  return { values, storage, owner };
}
const row = (ownerId: string, sequence: number, at: number) => ({ ownerId, sequence, at });

describe('userscript visible DeepL request-start history', () => {
  it('inherits prior documents without reading unrelated private values', () => {
    const f = fixture();
    f.values.set(GM_STORAGE_PREFIX + 'private-settings', { key: 'fixture-private' });
    const first = f.owner('document-a'); first.record(900); first.record(1000);
    expect(f.owner('document-b').read()).toEqual([900, 1000]);
    expect(f.storage.get).not.toHaveBeenCalledWith(GM_STORAGE_PREFIX + 'private-settings');
  });

  it('excludes the current document without losing other starts at the same millisecond', () => {
    const f = fixture(); const first = f.owner('a'); const second = f.owner('b');
    first.record(1000); first.record(1000); second.record(1000);
    expect(first.read()).toEqual([1000]); expect(second.read()).toEqual([1000, 1000]);
    expect(f.owner('fresh').read()).toEqual([1000, 1000, 1000]);
    expect([...f.values.keys()].filter(key => key.startsWith(prefix))).toHaveLength(3);
  });

  it('preserves immutable identities across interleaved writers and sorts only timestamps', () => {
    const f = fixture(); const first = f.owner('a'); const second = f.owner('b');
    first.record(950); second.record(900); first.record(1000); second.record(1000);
    expect(f.values.get(prefix + 'a:1')).toEqual(row('a', 1, 950));
    expect(f.values.get(prefix + 'a:2')).toEqual(row('a', 2, 1000));
    expect(f.owner('fresh').read()).toEqual([900, 950, 1000, 1000]);
  });

  it('never truncates more than thirty visible starts or deduplicates equal timestamps', () => {
    const f = fixture();
    for (let index = 0; index < 40; index++) f.owner(`writer-${index}`).record(1000);
    expect(f.owner('fresh').read()).toEqual(Array(40).fill(1000));
  });

  it('retains old clock evidence until an actual admission performs lazy userscript-window GC', () => {
    const f = fixture(); f.owner('old').record(1000);
    expect(f.owner('fresh').read()).toEqual([1000]); expect(f.storage.delete).not.toHaveBeenCalled();
    expect(f.values.has(prefix + 'old:1')).toBe(true);
    f.owner('next').record(13_250);
    expect(f.owner('fresh').read()).toEqual([13_250]);
  });

  it('retains every start until the full 12250ms boundary, including the 250ms headroom', () => {
    const f = fixture(); f.owner('a').record(1000); f.owner('b').record(1001);
    const next = f.owner('next'); next.record(13_249);
    expect(f.owner('reader').read()).toEqual([1000, 1001, 13_249]);
    expect(f.values.has(prefix + 'a:1')).toBe(true);
    next.record(13_250);
    expect(f.values.has(prefix + 'a:1')).toBe(false);
    expect(f.values.has(prefix + 'b:1')).toBe(true);
    expect(f.owner('reader').read()).toEqual([1001, 13_249, 13_250]);
  });

  it('appends a clock anchor before deleting expired records, so later rollback stays visible', () => {
    const f = fixture(); const first = f.owner('old'); first.record(1000); first.record(2000);
    const operations: string[] = []; const set = f.storage.set; const remove = f.storage.delete;
    f.storage.set = (key, value) => { operations.push('set:' + key); set(key, value); };
    f.storage.delete = key => { operations.push('delete:' + key); remove(key); };
    f.owner('new').record(15_000);
    expect(operations[0]).toBe('set:' + prefix + 'new:1');
    expect([...f.values.keys()]).toEqual([prefix + 'new:1']);
    expect(f.owner('later').read()).toEqual([15_000]); // Still available if the scheduler later observes clock 5000.
  });

  it('retains future anchors and every unexpired start during compaction', () => {
    const f = fixture(); f.values.set(prefix + 'future:1', row('future', 1, 40_000));
    f.values.set(prefix + 'old:1', row('old', 1, 1000));
    f.values.set(prefix + 'live:1', row('live', 1, 14_000));
    f.owner('new').record(15_000);
    expect(f.values.has(prefix + 'old:1')).toBe(false);
    expect(f.owner('reader').read()).toEqual([14_000, 15_000, 40_000]);
  });

  it('does not overwrite a pre-existing identity when an injected owner collides', () => {
    const f = fixture(); f.owner('same').record(1000);
    expect(() => f.owner('same').record(1001)).toThrow(expect.objectContaining({ code: 'CONFIG' }));
    expect(f.values.get(prefix + 'same:1')).toEqual(row('same', 1, 1000));
  });

  it('fails closed on read/write exceptions without leaking their contents', () => {
    const f = fixture(); const first = f.owner('a');
    f.storage.keys = () => { throw new Error('fixture-private-read'); };
    expect(() => first.read()).toThrow(expect.objectContaining({ code: 'CONFIG' }));
    try { first.read(); } catch (error) { expect(String(error)).not.toContain('fixture-private'); }
    f.storage.keys = () => [...f.values.keys()];
    f.storage.set = () => { throw new Error('fixture-private-write'); };
    expect(() => first.record(1000)).toThrow(expect.objectContaining({ code: 'CONFIG' }));
    expect(f.values.size).toBe(0);
  });

  it('keeps an ambiguously written reservation and never reuses its sequence', () => {
    const f = fixture(); const first = f.owner('a'); const set = f.storage.set;
    f.storage.set = (key, value) => { set(key, value); throw new Error('ambiguous commit'); };
    expect(() => first.record(1000)).toThrow(expect.objectContaining({ code: 'CONFIG' }));
    expect(f.owner('reader').read()).toEqual([1000]);
    f.storage.set = set; first.record(1000);
    expect(f.values.get(prefix + 'a:2')).toEqual(row('a', 2, 1000));
    expect(f.owner('reader').read()).toEqual([1000, 1000]);
  });

  it('rejects a silent no-op write before allowing I/O', () => {
    const f = fixture(); f.storage.set = () => {};
    expect(() => f.owner('a').record(1000)).toThrow(expect.objectContaining({ code: 'CONFIG' }));
  });

  it.each([
    row('other', 1, 1000), row('a', 2, 1000), row('a', 1, NaN), row('a', 1, -1), row('a', 1, 1.5),
    { ...row('a', 1, 1000), privateText: 'fixture-private' }, { ownerId: 'a', sequence: '1', at: 1000 }, null,
  ])('rejects unverifiable owned records %j without mutating them', value => {
    const f = fixture(); f.values.set(prefix + 'a:1', value);
    expect(() => f.owner('reader').read()).toThrow(expect.objectContaining({ code: 'CONFIG' }));
    expect(() => f.owner('writer').record(1000)).toThrow(expect.objectContaining({ code: 'CONFIG' }));
    expect(f.values.size).toBe(1);
  });

  it.each([NaN, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])('rejects an invalid admission timestamp %j', at => {
    const f = fixture(); expect(() => f.owner('a').record(at)).toThrow(expect.objectContaining({ code: 'CONFIG' }));
    expect(f.values.size).toBe(0);
  });

  it('rejects invalid owner IDs without consulting a separate read clock', () => {
    const f = fixture(); expect(() => f.owner('contains:separator')).toThrow(expect.objectContaining({ code: 'CONFIG' }));
  });
});
