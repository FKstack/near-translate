import { ConversionError, LIMITS, throwIfAborted, type OutputFile } from './types';

const table = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
async function crc32(bytes: Uint8Array, signal?: AbortSignal): Promise<number> {
  let value = 0xffffffff;
  for (let start = 0; start < bytes.length; start += 1024 * 1024) {
    throwIfAborted(signal);
    const end = Math.min(bytes.length, start + 1024 * 1024);
    for (let index = start; index < end; index++) value = table[(value ^ bytes[index]!) & 255]! ^ (value >>> 8);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throwIfAborted(signal);
  return (value ^ 0xffffffff) >>> 0;
}

/** Uncompressed ZIP, UTF-8 names. Avoids many separate browser downloads. */
export async function createZip(files: readonly OutputFile[], options: { signal?: AbortSignal } = {}): Promise<Blob> {
  throwIfAborted(options.signal);
  if (!files.length || files.length > LIMITS.maxPages) throw new ConversionError('打包文件数量无效。');
  const encoder = new TextEncoder(), parts: BlobPart[] = [], directory: BlobPart[] = [];
  let offset = 0, centralSize = 0;
  const names = new Set<string>();
  let estimated = 22;
  const entries = files.map(file => {
    if (!file.name || /(^|\/)\.\.(\/|$)|^[/\\]|\\/.test(file.name) || names.has(file.name)) throw new ConversionError('导出文件名无效或重复。');
    names.add(file.name);
    const name = encoder.encode(file.name);
    if (name.length > 65535) throw new ConversionError('导出文件名过长。');
    estimated += 76 + name.length * 2 + file.bytes.length;
    if (estimated > LIMITS.maxOutputBytes) throw new ConversionError('导出文件超过 128 MB，请减少页数或图片分辨率。');
    return { ...file, encodedName: name };
  });
  for (const file of entries) {
    const name = file.encodedName, checksum = await crc32(file.bytes, options.signal);
    throwIfAborted(options.signal);
    const local = new Uint8Array(30), header = new DataView(local.buffer);
    header.setUint32(0, 0x04034b50, true); header.setUint16(4, 20, true); header.setUint16(6, 0x800, true);
    header.setUint16(12, 33, true); header.setUint32(14, checksum, true); header.setUint32(18, file.bytes.length, true); header.setUint32(22, file.bytes.length, true); header.setUint16(26, name.length, true);
    const central = new Uint8Array(46), entry = new DataView(central.buffer);
    entry.setUint32(0, 0x02014b50, true); entry.setUint16(4, 20, true); entry.setUint16(6, 20, true); entry.setUint16(8, 0x800, true);
    entry.setUint16(14, 33, true); entry.setUint32(16, checksum, true); entry.setUint32(20, file.bytes.length, true); entry.setUint32(24, file.bytes.length, true); entry.setUint16(28, name.length, true); entry.setUint32(42, offset, true);
    parts.push(local, name, new Uint8Array(file.bytes)); directory.push(central, name);
    offset += local.length + name.length + file.bytes.length; centralSize += central.length + name.length;
    if (offset + centralSize + 22 > LIMITS.maxOutputBytes) throw new ConversionError('导出文件超过 128 MB，请减少页数或图片分辨率。');
  }
  const end = new Uint8Array(22), footer = new DataView(end.buffer);
  footer.setUint32(0, 0x06054b50, true); footer.setUint16(8, files.length, true); footer.setUint16(10, files.length, true); footer.setUint32(12, centralSize, true); footer.setUint32(16, offset, true);
  throwIfAborted(options.signal);
  return new Blob([...parts, ...directory, end], { type: 'application/zip' });
}
