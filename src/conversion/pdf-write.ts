import { degrees, PageSizes, PDFDocument } from 'pdf-lib';
import { parsePageRange } from './ranges';
import {
  checkFiles, ConversionError, LIMITS, safeFilename, throwIfAborted,
  type OutputFile, type ProgressCallback,
} from './types';

export interface PdfWriteOptions {
  signal?: AbortSignal;
  onProgress?: ProgressCallback;
}

export interface ImagesToPdfOptions extends PdfWriteOptions {
  pageSize: 'a4' | 'original';
  /** PDF points (72 points = one inch). Original images use 96 pixels/inch. */
  margin: number;
}

export interface PdfMergeInput { file: File; pages?: string }
export interface MergePdfOptions extends PdfWriteOptions {
  /** Clockwise degrees added to each source page's existing rotation. */
  rotation?: number;
}
export interface SplitPdfOptions extends PdfWriteOptions { pages?: string }

const MAX_CANVAS_SIDE = 16_384;
const PIXELS_TO_POINTS = 72 / 96;

async function yieldTask(signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  throwIfAborted(signal);
}

/** Abort decoding promptly, but close a bitmap that arrives after cancellation. */
function abortable<T>(pending: Promise<T>, signal?: AbortSignal, disposeLate?: (value: T) => void): Promise<T> {
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', cancel);
    const cancel = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new DOMException('已取消转换。', 'AbortError'));
    };
    signal.addEventListener('abort', cancel, { once: true });
    pending.then(value => {
      if (settled) { disposeLate?.(value); return; }
      settled = true;
      cleanup();
      resolve(value);
    }, error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    if (signal.aborted) cancel();
  });
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

async function loadPdf(file: File, signal?: AbortSignal): Promise<PDFDocument> {
  throwIfAborted(signal);
  if (!file.size) throw new ConversionError(`“${file.name}”是空文件。`);
  try {
    const data = await file.arrayBuffer();
    throwIfAborted(signal);
    // Reject encryption explicitly. ignoreEncryption would copy unreadable streams.
    const document = await PDFDocument.load(data, {
      ignoreEncryption: false, updateMetadata: false, parseSpeed: 25,
    });
    throwIfAborted(signal);
    if (document.isEncrypted) throw new ConversionError('加密 PDF 暂不支持合并或拆分，请先在原应用中解密并另存后重试。');
    return document;
  } catch (error) {
    throwIfAborted(signal);
    if (error instanceof ConversionError || isAbort(error)) throw error;
    if (error instanceof Error && /encrypt/i.test(`${error.name} ${error.message}`)) {
      throw new ConversionError('加密 PDF 暂不支持合并或拆分，请先在原应用中解密并另存后重试。');
    }
    throw new ConversionError(`无法读取“${file.name}”，请确认文件是完整有效的 PDF。`);
  }
}

async function savePdf(document: PDFDocument, signal?: AbortSignal): Promise<Uint8Array> {
  throwIfAborted(signal);
  const bytes = await document.save({
    addDefaultPage: false, objectsPerTick: 25, updateFieldAppearances: false,
  });
  throwIfAborted(signal);
  if (bytes.byteLength > LIMITS.maxOutputBytes) throw new ConversionError('生成的文件超过 128 MB，请减少页面后重试。');
  return bytes;
}

/**
 * Copies source page streams, preserving selectable text and vector graphics.
 * Page ranges are one-based, ordered, and may repeat. No network is used.
 */
export async function mergePdfs(inputs: PdfMergeInput[], options: MergePdfOptions = {}): Promise<Uint8Array> {
  throwIfAborted(options.signal);
  checkFiles(inputs.map(input => input.file));
  const rotation = options.rotation ?? 0;
  if (!Number.isSafeInteger(rotation) || rotation % 90 !== 0) throw new ConversionError('页面旋转角度必须是 90° 的整数倍。');
  const prepared: Array<{ document: PDFDocument; pages: number[] }> = [];
  let total = 0;
  for (const input of inputs) {
    await yieldTask(options.signal);
    const document = await loadPdf(input.file, options.signal);
    const pages = parsePageRange(input.pages ?? '', document.getPageCount());
    total += pages.length;
    if (total > LIMITS.maxPages) throw new ConversionError(`一次最多处理 ${LIMITS.maxPages} 页，请减少选定页面。`);
    prepared.push({ document, pages });
  }
  const output = await PDFDocument.create();
  let done = 0;
  options.onProgress?.(0, total);
  for (const source of prepared) {
    await yieldTask(options.signal);
    // One copier per source preserves shared fonts/images. pdf-lib clones each
    // page leaf independently, including repeated indices in the requested order.
    const pages = await output.copyPages(source.document, source.pages.map(pageNumber => pageNumber - 1));
    throwIfAborted(options.signal);
    for (const page of pages) {
      await yieldTask(options.signal);
      const angle = ((page.getRotation().angle + rotation) % 360 + 360) % 360;
      page.setRotation(degrees(angle));
      output.addPage(page);
      options.onProgress?.(++done, total);
    }
  }
  return savePdf(output, options.signal);
}

/** Produces one PDF per selected page; duplicate selections receive unique names. */
export async function splitPdf(file: File, options: SplitPdfOptions = {}): Promise<OutputFile[]> {
  throwIfAborted(options.signal);
  checkFiles([file]);
  const source = await loadPdf(file, options.signal);
  const pages = parsePageRange(options.pages ?? '', source.getPageCount());
  const base = safeFilename(file.name.replace(/\.pdf$/i, ''));
  const digits = Math.max(3, String(source.getPageCount()).length);
  const copies = new Map<number, number>();
  const outputs: OutputFile[] = [];
  let totalBytes = 0;
  options.onProgress?.(0, pages.length);
  for (const pageNumber of pages) {
    await yieldTask(options.signal);
    const output = await PDFDocument.create();
    const [page] = await output.copyPages(source, [pageNumber - 1]);
    throwIfAborted(options.signal);
    if (!page) throw new ConversionError('未能复制选定的 PDF 页面。');
    output.addPage(page);
    const bytes = await savePdf(output, options.signal);
    totalBytes += bytes.byteLength;
    if (totalBytes > LIMITS.maxOutputBytes) throw new ConversionError('拆分文件合计超过 128 MB，请减少选定页面后重试。');
    const copy = (copies.get(pageNumber) ?? 0) + 1;
    copies.set(pageNumber, copy);
    const suffix = copy > 1 ? `-copy-${copy}` : '';
    outputs.push({ name: `${base}-page-${String(pageNumber).padStart(digits, '0')}${suffix}.pdf`, bytes });
    options.onProgress?.(outputs.length, pages.length);
  }
  throwIfAborted(options.signal);
  return outputs;
}

function checkImageType(file: File): void {
  const type = file.type.toLowerCase();
  const supported = ['image/png', 'image/jpeg', 'image/webp'];
  if (supported.includes(type)) return;
  // Some OS file pickers omit MIME types; only recognized image suffixes qualify.
  if ((!type || type === 'application/octet-stream') && /\.(png|jpe?g|webp)$/i.test(file.name)) return;
  throw new ConversionError(`“${file.name}”格式不受支持，请选择 PNG、JPEG 或 WebP 图片。`);
}

function checkImageDimensions(width: number, height: number, filename: string): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || width * height > LIMITS.maxImagePixels || width > MAX_CANVAS_SIDE || height > MAX_CANVAS_SIDE) {
    throw new ConversionError(`“${filename}”尺寸过大，请缩小到 1600 万像素以内，且单边不超过 ${MAX_CANVAS_SIDE} 像素。`);
  }
}

/** Reject huge compressed bitmaps before the browser allocates a decoded surface. */
async function preflightImage(file: File, signal?: AbortSignal): Promise<void> {
  const bytes = new Uint8Array(await file.slice(0, 512 * 1024).arrayBuffer());
  throwIfAborted(signal);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (start: number, text: string) => [...text].every((value, index) => bytes[start + index] === value.charCodeAt(0));
  let dimensions: [number, number] | undefined;
  if (bytes.length >= 24 && bytes[0] === 137 && ascii(1, 'PNG\r\n\x1a\n') && ascii(12, 'IHDR')) {
    dimensions = [view.getUint32(16), view.getUint32(20)];
  } else if (bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    const frameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    while (offset + 1 < bytes.length) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === undefined || marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if (frameMarkers.has(marker) && length >= 7) {
        dimensions = [view.getUint16(offset + 5), view.getUint16(offset + 3)];
        break;
      }
      offset += length;
    }
  } else if (bytes.length >= 20 && ascii(0, 'RIFF') && ascii(8, 'WEBP')) {
    let offset = 12;
    const uint24 = (start: number) => bytes[start]! + bytes[start + 1]! * 256 + bytes[start + 2]! * 65536;
    while (offset + 8 <= bytes.length) {
      const length = view.getUint32(offset + 4, true), data = offset + 8;
      if (data + length > bytes.length) {
        // Only the fixed-size header is needed for large VP8 pixel payloads.
        if (data + 10 > bytes.length) break;
      }
      if (ascii(offset, 'VP8X') && length >= 10 && data + 10 <= bytes.length) {
        dimensions = [uint24(data + 4) + 1, uint24(data + 7) + 1];
        break;
      }
      if (ascii(offset, 'VP8L') && length >= 5 && data + 5 <= bytes.length && bytes[data] === 0x2f) {
        const packed = view.getUint32(data + 1, true);
        dimensions = [(packed & 0x3fff) + 1, ((packed >>> 14) & 0x3fff) + 1];
        break;
      }
      if (ascii(offset, 'VP8 ') && length >= 10 && data + 10 <= bytes.length && ascii(data + 3, '\x9d\x01\x2a')) {
        dimensions = [view.getUint16(data + 6, true) & 0x3fff, view.getUint16(data + 8, true) & 0x3fff];
        break;
      }
      offset = data + length + (length % 2);
    }
  }
  if (!dimensions) throw new ConversionError(`无法识别“${file.name}”的图片尺寸，请用图片应用另存为 PNG、JPEG 或 WebP 后重试。`);
  checkImageDimensions(dimensions[0], dimensions[1], file.name);
}

/** Header-only local attachment validation; does not decode or allocate a bitmap. */
export async function validateImageFile(file: File, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  checkFiles([file]);
  checkImageType(file);
  await preflightImage(file, signal);
  throwIfAborted(signal);
}

async function imageJpeg(file: File, signal?: AbortSignal): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  throwIfAborted(signal);
  await validateImageFile(file, signal);
  let bitmap: ImageBitmap | undefined;
  let canvas: HTMLCanvasElement | undefined;
  try {
    bitmap = await abortable(createImageBitmap(file, { imageOrientation: 'from-image' }), signal, value => value.close());
    throwIfAborted(signal);
    const { width, height } = bitmap;
    checkImageDimensions(width, height, file.name);
    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new ConversionError('浏览器无法创建图片画布，请关闭部分标签页后重试。');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    bitmap = undefined;
    const activeCanvas = canvas;
    const blob = await abortable(new Promise<Blob>((resolve, reject) => {
      activeCanvas.toBlob(result => result ? resolve(result) : reject(new ConversionError('图片编码失败，请缩小图片后重试。')), 'image/jpeg', 0.94);
    }), signal);
    throwIfAborted(signal);
    if (blob.size > LIMITS.maxOutputBytes) throw new ConversionError('图片编码后过大，请缩小图片后重试。');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    throwIfAborted(signal);
    return { bytes, width, height };
  } catch (error) {
    throwIfAborted(signal);
    if (error instanceof ConversionError || isAbort(error)) throw error;
    throw new ConversionError(`无法解码“${file.name}”，请确认图片未损坏且格式为 PNG、JPEG 或 WebP。`);
  } finally {
    bitmap?.close();
    // Release the native backing store immediately, including error/abort paths.
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}

/** One image per page, flattened over white; EXIF orientation is applied by the browser. */
export async function imagesToPdf(files: File[], options: ImagesToPdfOptions): Promise<Uint8Array> {
  throwIfAborted(options.signal);
  checkFiles(files);
  if (files.length > LIMITS.maxImagePages) throw new ConversionError(`一次最多处理 ${LIMITS.maxImagePages} 张图片。`);
  if (!['a4', 'original'].includes(options.pageSize)) throw new ConversionError('请选择 A4 或原图尺寸。');
  if (!Number.isFinite(options.margin) || options.margin < 0 || options.margin > 144) throw new ConversionError('页边距请填写 0 至 144 pt。');
  files.forEach(checkImageType);
  const output = await PDFDocument.create();
  let done = 0, imageBytes = 0;
  options.onProgress?.(0, files.length);
  for (const file of files) {
    await yieldTask(options.signal);
    const image = await imageJpeg(file, options.signal);
    imageBytes += image.bytes.byteLength;
    if (imageBytes > LIMITS.maxOutputBytes) throw new ConversionError('图片合计超过 128 MB，请减少图片后重试。');
    const embedded = await output.embedJpg(image.bytes);
    throwIfAborted(options.signal);
    const dimensions: [number, number] = options.pageSize === 'a4'
      ? [PageSizes.A4[0], PageSizes.A4[1]]
      : [image.width * PIXELS_TO_POINTS + options.margin * 2, image.height * PIXELS_TO_POINTS + options.margin * 2];
    const page = output.addPage(dimensions);
    const scale = Math.min((dimensions[0] - options.margin * 2) / image.width, (dimensions[1] - options.margin * 2) / image.height);
    const width = image.width * scale, height = image.height * scale;
    page.drawImage(embedded, { x: (dimensions[0] - width) / 2, y: (dimensions[1] - height) / 2, width, height });
    options.onProgress?.(++done, files.length);
  }
  return savePdf(output, options.signal);
}
