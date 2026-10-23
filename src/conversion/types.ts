export class ConversionError extends Error {
  constructor(message: string) { super(message); this.name = 'ConversionError'; }
}

export const LIMITS = Object.freeze({
  maxFiles: 50,
  maxInputBytes: 100 * 1024 * 1024,
  maxTotalInputBytes: 200 * 1024 * 1024,
  maxOutputBytes: 128 * 1024 * 1024,
  maxPages: 500,
  maxImagePages: 100,
  maxImagePixels: 16_000_000,
  maxRenderPixels: 16_000_000,
  maxTextChars: 8_000_000,
  maxMarkdownBytes: 5 * 1024 * 1024,
});

export type OutputFile = { name: string; bytes: Uint8Array };
export type ProgressCallback = (completed: number, total: number) => void;

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('已取消转换。', 'AbortError');
}

export function checkFiles(files: readonly File[]): void {
  if (!files.length) throw new ConversionError('请先选择文件。');
  if (files.length > LIMITS.maxFiles) throw new ConversionError(`一次最多选择 ${LIMITS.maxFiles} 个文件。`);
  if (files.some(file => file.size > LIMITS.maxInputBytes)) throw new ConversionError('单个文件不能超过 100 MB。');
  if (files.reduce((sum, file) => sum + file.size, 0) > LIMITS.maxTotalInputBytes) throw new ConversionError('本次文件合计不能超过 200 MB。');
}

export function safeFilename(value: string, fallback = '近译文档'): string {
  return value.replace(/[\\/<>:"|?*\u0000-\u001f]/g, '-').replace(/^\.+|\.+$/g, '').trim().slice(0, 100) || fallback;
}
