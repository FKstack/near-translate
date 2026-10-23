import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { layoutPdfPage } from './pdf-layout';
import type { PdfTextLink, PdfTextRun } from './pdf-layout';
import { parsePageRange } from './ranges';
import { ConversionError, LIMITS, safeFilename, throwIfAborted } from './types';
import type { OutputFile, ProgressCallback } from './types';

type PdfInput = File | Uint8Array;
interface PdfReadOptions { pages?: string; password?: string; signal?: AbortSignal; onProgress?: ProgressCallback }
export interface PdfTextOptions extends PdfReadOptions { format: 'markdown' | 'text' }
export interface PdfImageOptions extends PdfReadOptions { format: 'png' | 'jpeg'; scale?: number }

const assetUrl = (path: string) => new URL(`/pdfjs/${path}`, window.location.href).href;

function friendlyError(error: unknown): Error {
  if (error instanceof ConversionError || (error instanceof Error && error.name === 'AbortError')) return error;
  const name = error && typeof error === 'object' && 'name' in error ? error.name : '';
  if (name === 'PasswordException') return new ConversionError('PDF 已加密，请填写正确的密码后重试。');
  if (name === 'InvalidPDFException') return new ConversionError('文件不是有效的 PDF，或文件已损坏。');
  if (name === 'UnknownErrorException') return new ConversionError('无法读取这个 PDF，请确认文件完整且密码正确。');
  return new ConversionError(`PDF 转换失败：${error instanceof Error ? error.message : '无法读取文件。'}`);
}

/** This operation owns its worker task; both cancellation and completion release it. */
async function withPdf<T>(input: PdfInput, options: PdfReadOptions, operation: (document: PDFDocumentProxy) => Promise<T>) {
  throwIfAborted(options.signal);
  const size = input instanceof Uint8Array ? input.byteLength : input.size;
  if (size === 0) throw new ConversionError('PDF 文件为空。');
  if (size > LIMITS.maxInputBytes) throw new ConversionError('单个 PDF 不能超过 100 MB。');
  // PDF.js transfers the buffer to its worker. Own a copy rather than detach caller data.
  const data = input instanceof Uint8Array ? input.slice() : new Uint8Array(await input.arrayBuffer());
  throwIfAborted(options.signal);
  pdfjs.GlobalWorkerOptions.workerSrc = assetUrl('pdf.worker.mjs');
  const task = pdfjs.getDocument({
    data, password: options.password || undefined,
    cMapUrl: assetUrl('cmaps/'), cMapPacked: true,
    standardFontDataUrl: assetUrl('standard_fonts/'),
    wasmUrl: assetUrl('wasm/'), iccUrl: assetUrl('iccs/'),
    enableXfa: false,
  });
  let destruction: Promise<void> | undefined;
  const destroy = () => destruction ??= task.destroy().catch(() => {});
  const abort = () => { void destroy(); };
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    const document = await task.promise;
    throwIfAborted(options.signal);
    return await operation(document);
  } catch (error) {
    throwIfAborted(options.signal);
    throw friendlyError(error);
  } finally {
    options.signal?.removeEventListener('abort', abort);
    await destroy();
  }
}

async function readPage(page: PDFPageProxy, format: PdfTextOptions['format'], signal?: AbortSignal) {
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  throwIfAborted(signal);
  const runs: PdfTextRun[] = [];
  const viewportUnit = Math.hypot(viewport.transform[0] ?? 1, viewport.transform[1] ?? 0);
  let vertical = false;
  let characters = 0;
  for (const item of content.items) {
    if (!('str' in item) || !item.str.trim()) continue;
    characters += item.str.length;
    if (characters > LIMITS.maxTextChars) throw new ConversionError('单页文字过多，无法安全导出。');
    const matrix = pdfjs.Util.transform(viewport.transform, item.transform);
    const size = Math.hypot(matrix[2] ?? 0, matrix[3] ?? 0) || Math.abs(item.height) || 12;
    vertical ||= item.dir === 'ttb' || Math.abs(matrix[1] ?? 0) > Math.abs(matrix[0] ?? 0);
    runs.push({
      text: item.str, x: matrix[4] ?? 0, y: matrix[5] ?? 0,
      width: Math.abs(item.width) * viewportUnit, size, fontName: item.fontName,
      fontFamily: content.styles[item.fontName]?.fontFamily,
    });
  }
  const links: PdfTextLink[] = [];
  if (format === 'markdown') {
    const annotations = await page.getAnnotations({ intent: 'display' });
    throwIfAborted(signal);
    for (const annotation of annotations) {
      if (annotation.subtype !== 'Link' || typeof annotation.url !== 'string'
        || !Array.isArray(annotation.rect) || annotation.rect.length !== 4) continue;
      const first = viewport.convertToViewportPoint(annotation.rect[0], annotation.rect[1]);
      const second = viewport.convertToViewportPoint(annotation.rect[2], annotation.rect[3]);
      const rectangle = [...first, ...second];
      const x = Math.min(rectangle[0]!, rectangle[2]!);
      const y = Math.min(rectangle[1]!, rectangle[3]!);
      links.push({ x, y, width: Math.abs(rectangle[2]! - rectangle[0]!), height: Math.abs(rectangle[3]! - rectangle[1]!), url: annotation.url });
    }
  }
  const result = layoutPdfPage(runs, { format, width: viewport.width, links });
  if (vertical) result.warnings.push('存在竖排或旋转文字，导出后的阅读顺序可能需要调整。');
  return result;
}

export async function pdfToText(input: PdfInput, options: PdfTextOptions): Promise<{ text: string; pageCount: number; warnings: string[] }> {
  return withPdf(input, options, async (document) => {
    const pages = parsePageRange(options.pages ?? '', document.numPages);
    const sections: string[] = [];
    const warnings = new Set<string>();
    const emptyPages: number[] = [];
    let characters = 0;
    let outputBytes = 0;
    const encoder = new TextEncoder();
    options.onProgress?.(0, pages.length);
    for (let index = 0; index < pages.length; index++) {
      throwIfAborted(options.signal);
      const number = pages[index]!;
      const page = await document.getPage(number);
      try {
        const result = await readPage(page, options.format, options.signal);
        if (result.text.trim()) {
          sections.push(result.text);
          characters += result.text.length;
          outputBytes += encoder.encode(result.text).byteLength;
          if (characters > LIMITS.maxTextChars || outputBytes > LIMITS.maxOutputBytes) throw new ConversionError('导出的文字过多，请缩小页码范围后重试。');
        } else emptyPages.push(number);
        for (const warning of result.warnings) warnings.add(warning);
      } finally { page.cleanup(); }
      throwIfAborted(options.signal);
      options.onProgress?.(index + 1, pages.length);
    }
    if (!sections.length) throw new ConversionError('所选页面没有可提取文字，可能是扫描件或图片 PDF。当前转换不支持 OCR；可使用“PDF 转图片”保留页面。');
    if (emptyPages.length) {
      const sample = emptyPages.slice(0, 20).join('、');
      warnings.add(`第 ${sample}${emptyPages.length > 20 ? ' 等' : ''} 页没有可提取文字（可能是扫描页或空白页），已跳过；当前不支持 OCR。`);
    }
    warnings.add('已按文字位置重建排版。复杂表格、图片、公式和特殊排版可能需要手动整理；图片不会包含在文字导出中。');
    return { text: sections.join(options.format === 'markdown' ? '\n\n---\n\n' : '\n\n\f\n\n'), pageCount: pages.length, warnings: [...warnings] };
  });
}

function canvasBytes(canvas: HTMLCanvasElement, mime: string, signal?: AbortSignal): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(new DOMException('已取消转换。', 'AbortError')); };
    const cleanup = () => signal?.removeEventListener('abort', abort);
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    canvas.toBlob((blob) => {
      if (signal?.aborted) { abort(); return; }
      if (!blob) { cleanup(); reject(new ConversionError('页面图片生成失败，请尝试较低的分辨率。')); return; }
      if (blob.size > LIMITS.maxOutputBytes) { cleanup(); reject(new ConversionError('单页图片过大，请降低分辨率后重试。')); return; }
      void blob.arrayBuffer().then((buffer) => { cleanup(); throwIfAborted(signal); resolve(new Uint8Array(buffer)); }, (error: unknown) => { cleanup(); reject(error); }).catch(reject);
    }, mime, mime === 'image/jpeg' ? 0.92 : undefined);
  });
}

export async function pdfToImages(input: PdfInput, options: PdfImageOptions): Promise<OutputFile[]> {
  const scale = options.scale ?? 1.5;
  if (!Number.isFinite(scale) || scale < 0.5 || scale > 3) throw new ConversionError('图片缩放比例需在 0.5 到 3 之间。');
  return withPdf(input, options, async (document) => {
    const pages = parsePageRange(options.pages ?? '', document.numPages);
    if (pages.length > LIMITS.maxImagePages) throw new ConversionError(`一次最多导出 ${LIMITS.maxImagePages} 页图片，请缩小页码范围。`);
    const base = safeFilename(input instanceof Uint8Array ? '文档' : input.name.replace(/\.pdf$/iu, ''));
    const digits = Math.max(2, String(document.numPages).length);
    const results: OutputFile[] = [];
    let totalBytes = 0;
    options.onProgress?.(0, pages.length);
    for (let index = 0; index < pages.length; index++) {
      throwIfAborted(options.signal);
      const number = pages[index]!;
      const page = await document.getPage(number);
      const canvas = window.document.createElement('canvas');
      try {
        const viewport = page.getViewport({ scale });
        const width = Math.ceil(viewport.width), height = Math.ceil(viewport.height);
        if (!(width > 0 && height > 0) || width * height > LIMITS.maxRenderPixels || width > 32767 || height > 32767) {
          throw new ConversionError(`第 ${number} 页图片尺寸过大，请降低分辨率后重试。`);
        }
        canvas.width = width; canvas.height = height;
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw new ConversionError('浏览器无法创建图片画布。');
        const render = page.render({ canvas, canvasContext: context, viewport, background: '#ffffff' });
        const abort = () => render.cancel();
        options.signal?.addEventListener('abort', abort, { once: true });
        try {
          throwIfAborted(options.signal);
          await render.promise;
          throwIfAborted(options.signal);
        } finally { options.signal?.removeEventListener('abort', abort); }
        const bytes = await canvasBytes(canvas, options.format === 'jpeg' ? 'image/jpeg' : 'image/png', options.signal);
        totalBytes += bytes.byteLength;
        if (totalBytes > LIMITS.maxOutputBytes) throw new ConversionError('导出图片总大小超过 128 MB，请缩小页码范围或降低分辨率。');
        // The sequence prefix prevents duplicate names for repeated/reordered pages.
        results.push({ name: `${base}-${String(index + 1).padStart(digits, '0')}-p${number}.${options.format === 'jpeg' ? 'jpg' : 'png'}`, bytes });
      } finally { canvas.width = 0; canvas.height = 0; page.cleanup(); }
      throwIfAborted(options.signal);
      options.onProgress?.(index + 1, pages.length);
    }
    return results;
  });
}
