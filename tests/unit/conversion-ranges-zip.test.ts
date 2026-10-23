import { describe, expect, it } from 'vitest';
import { parsePageRange } from '../../src/conversion/ranges';
import { createZip } from '../../src/conversion/zip';

describe('document page ranges', () => {
  it('preserves custom order, repetitions and descending ranges', () => {
    expect(parsePageRange('3,1-2,3，5-4', 5)).toEqual([3, 1, 2, 3, 5, 4]);
    expect(parsePageRange('', 2)).toEqual([1, 2]);
  });
  it.each(['0', '6', '1,,2', '-1', '1-2-3', 'a', '1.5'])('rejects invalid ranges: %s', value => {
    expect(() => parsePageRange(value, 5)).toThrow();
  });
  it('bounds expansion before allocating a large array', () => {
    expect(() => parsePageRange('', 50000)).toThrow(/最多/);
    expect(parsePageRange('49999-50000', 50000)).toEqual([49999, 50000]);
    expect(() => parsePageRange('1-501', 1000)).toThrow(/最多/);
  });
});

describe('portable UTF-8 ZIP downloads', () => {
  it('writes original bytes, UTF-8 names, directory offsets and a valid checksum', async () => {
    const bytes = new Uint8Array(await (await createZip([{ name: '第1页.txt', bytes: new TextEncoder().encode('hello') }])).arrayBuffer());
    const view = new DataView(bytes.buffer), nameLength = view.getUint16(26, true);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint16(6, true)).toBe(0x800);
    expect(view.getUint32(14, true)).toBe(0x3610a686);
    expect(new TextDecoder().decode(bytes.subarray(30, 30 + nameLength))).toBe('第1页.txt');
    expect(new TextDecoder().decode(bytes.subarray(30 + nameLength, 35 + nameLength))).toBe('hello');
    const end = bytes.length - 22, directoryOffset = view.getUint32(end + 16, true);
    expect(view.getUint32(end, true)).toBe(0x06054b50);
    expect(view.getUint32(directoryOffset, true)).toBe(0x02014b50);
    expect(view.getUint32(directoryOffset + 42, true)).toBe(0);
  });
  it('rejects traversal and repeated output names', async () => {
    await expect(createZip([{ name: '../file', bytes: new Uint8Array() }])).rejects.toThrow();
    await expect(createZip([{ name: 'x', bytes: new Uint8Array() }, { name: 'x', bytes: new Uint8Array() }])).rejects.toThrow();
  });
  it('can cancel while computing checksums without returning a partial ZIP', async () => {
    const controller = new AbortController();
    const pending = createZip([{ name: 'pages.bin', bytes: new Uint8Array(3 * 1024 * 1024) }], { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
