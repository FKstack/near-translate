import fontkit from '@pdf-lib/fontkit';
import { degrees, PDFDocument, PDFName, PDFString, rgb, StandardFonts, TextRenderingMode,
  pushGraphicsState, popGraphicsState, setTextRenderingMode, setLineWidth, setStrokingRgbColor,
  type PDFFont, type PDFImage, type RGB } from 'pdf-lib';
import { buildPrintDocument, type PrintDocumentOptions } from './markdown';
import { ConversionError, LIMITS, throwIfAborted, type ProgressCallback } from './types';

export interface DocumentPdfOptions extends PrintDocumentOptions {
  signal?: AbortSignal;
  onProgress?: ProgressCallback;
  onWarning?: (message: string) => void;
}
type Box = { x: number; y: number; width: number; height: number };
type TextRun = { text: string; box: Box; baseline: number; size: number; color: RGB; bold: boolean; italic: boolean; mono: boolean };
type Surface = { box: Box; fill?: RGB; borders: Array<{ width: number; color?: RGB }> };
type Picture = { box: Box; image: PDFImage };
type Link = { box: Box; href: string };
const POINTS_PER_PIXEL = 72 / 96;
const FONT_PATH = '/fonts/NearDocumentSans.ttf.gz';
const MAX_FONT_BYTES = 32 * 1024 * 1024;
const MAX_CHARACTERS = 300_000;
let cachedFont: Uint8Array | undefined;

async function tick(signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  throwIfAborted(signal);
}

function abortable<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => { cleanup(); reject(new DOMException('已取消转换。', 'AbortError')); };
    signal.addEventListener('abort', abort, { once: true });
    pending.then(value => { cleanup(); if (!signal.aborted) resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) abort();
  });
}

function number(value: number, fallback: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

function color(value: string): RGB | undefined {
  const match = value.match(/^rgba?\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/);
  if (!match || (match[4] !== undefined && Number(match[4]) === 0)) return undefined;
  return rgb(Number(match[1]) / 255, Number(match[2]) / 255, Number(match[3]) / 255);
}

function relativeBox(rect: DOMRect, origin: DOMRect): Box {
  return { x: rect.left - origin.left, y: rect.top - origin.top, width: rect.width, height: rect.height };
}

/** Load the complete local font on demand; only its decoded TTF bytes are cached. */
export async function loadDocumentFont(signal?: AbortSignal): Promise<Uint8Array> {
  if (cachedFont) { throwIfAborted(signal); return cachedFont; }
  throwIfAborted(signal);
  const response = await fetch(new URL(FONT_PATH, window.location.href), { signal, cache: 'force-cache', credentials: 'omit' });
  if (!response.ok) throw new ConversionError('本地 PDF 字体加载失败，请重新加载扩展后重试。');
  if (!response.body) throw new ConversionError('本地 PDF 字体文件不完整，请重新加载扩展。');
  const reader = response.body.pipeThrough(new DecompressionStream('gzip'), { signal }).getReader();
  try {
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      throwIfAborted(signal);
      if (done) break;
      length += value.byteLength;
      if (length > MAX_FONT_BYTES) throw new ConversionError('本地 PDF 字体文件不完整，请重新加载扩展。');
      chunks.push(value);
    }
    if (length < 1000) throw new ConversionError('本地 PDF 字体文件不完整，请重新加载扩展。');
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    throwIfAborted(signal);
    cachedFont = bytes;
    return bytes;
  } catch (error) {
    throwIfAborted(signal);
    if (error instanceof ConversionError) throw error;
    throw new ConversionError('本地 PDF 字体文件不完整，请重新加载扩展。');
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function layoutFrame(html: string, options: DocumentPdfOptions, bytes: Uint8Array, width: number): Promise<HTMLIFrameElement> {
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-same-origin');
  frame.setAttribute('aria-hidden', 'true'); frame.tabIndex = -1;
  frame.style.cssText = `position:fixed;left:-100000px;top:0;width:${width + 2}px;height:1000px;border:0;visibility:hidden;pointer-events:none`;
  const loaded = new Promise<void>((resolve, reject) => {
    frame.onload = () => resolve(); frame.onerror = () => reject(new ConversionError('文档排版初始化失败，请重试。'));
  });
  frame.srcdoc = buildPrintDocument(html, options);
  document.body.append(frame);
  try {
    await abortable(loaded, options.signal);
    const doc = frame.contentDocument;
    if (!doc) throw new ConversionError('无法创建本地文档排版。');
    const face = new FontFace('NearPdfDocument', new Uint8Array(bytes));
    await abortable(face.load(), options.signal);
    doc.fonts.add(face);
    const style = doc.createElement('style');
    style.textContent = `html{background:white;overflow:hidden}body{width:${width}px;min-height:0;margin:0;padding:0;font-family:NearPdfDocument,sans-serif}main{min-width:0}*{font-kerning:none;font-variant-ligatures:none}pre,code,kbd,samp{font-family:"Courier New",NearPdfDocument,monospace}pre{tab-size:4}li{position:relative;list-style:none}.near-pdf-marker{position:absolute;right:100%;padding-right:.5em;white-space:nowrap}`;
    doc.head.append(style);
    for (const list of doc.querySelectorAll('ol,ul')) {
      const start = list.tagName === 'OL' ? Number(list.getAttribute('start') ?? 1) : 0;
      let index = 0;
      for (const child of list.children) if (child.tagName === 'LI') {
        const marker = doc.createElement('span'); marker.className = 'near-pdf-marker';
        marker.textContent = list.tagName === 'OL' ? `${start + index}.` : '•';
        child.prepend(marker); index++;
      }
    }
    await abortable(doc.fonts.ready, options.signal);
    await abortable(Promise.all([...doc.images].map(async image => {
      try { await image.decode(); }
      catch { const replacement = doc.createElement('span'); replacement.textContent = `[图片无法解码：${image.alt || '图片'}]`; image.replaceWith(replacement); options.onWarning?.('部分本地图片无法解码，PDF 中已用文字提示代替。'); }
    })), options.signal);
    return frame;
  } catch (error) { frame.remove(); throw error; }
}

/** Returns continuous-layout page cuts, moving short rows/images/headings together. */
export function paginateDocument(height: number, pageHeight: number, protectedBoxes: readonly Pick<Box, 'y' | 'height'>[]): number[] {
  if (!(pageHeight > 0) || !Number.isFinite(height) || height < 0) throw new ConversionError('文档页面尺寸无效。');
  const starts = [0];
  while (starts[starts.length - 1]! + pageHeight < height - 0.1) {
    const top = starts[starts.length - 1]!;
    let cut = top + pageHeight;
    for (let pass = 0; pass < 100; pass++) {
      let next = cut;
      for (const box of protectedBoxes) {
        if (box.height <= pageHeight && box.y > top + 0.1 && box.y < cut - 0.1 && box.y + box.height > cut + 0.1) next = Math.min(next, box.y);
      }
      if (next >= cut - 0.1) break;
      cut = next;
    }
    if (cut <= top + 0.1) cut = top + pageHeight;
    starts.push(cut);
    if (starts.length > LIMITS.maxPages) throw new ConversionError(`文档超过 ${LIMITS.maxPages} 页，请拆分后再下载。`);
  }
  return starts;
}

async function collectText(doc: Document, font: PDFFont, origin: DOMRect, options: DocumentPdfOptions): Promise<TextRun[]> {
  const main = doc.querySelector('main')!;
  const supported = new Set(font.getCharacterSet());
  const missing = new Set<string>();
  const walker = doc.createTreeWalker(main, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let count = 0;
  while (walker.nextNode()) {
    const text = walker.currentNode as Text;
    count += text.length;
    if (count > MAX_CHARACTERS) throw new ConversionError('直接 PDF 排版一次最多支持 30 万字，请拆分文档后下载。');
    text.data = [...text.data.replace(/\t/g, '    ')].map(character => {
      const point = character.codePointAt(0)!;
      if (/[\n\r\t]/.test(character) || supported.has(point)) return character;
      if (point === 0xfe0f || point === 0x200d) return '';
      missing.add(character); return '□';
    }).join('');
    nodes.push(text);
  }
  if (missing.size) options.onWarning?.(`本地字体不含部分字符（${[...missing].slice(0, 12).join(' ')}），PDF 中以 □ 标示；其他文字已保留。`);
  const canvas = doc.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) throw new ConversionError('浏览器不支持文档字体测量。');
  const runs: TextRun[] = [];
  let inspected = 0;
  for (const text of nodes) {
    const parent = text.parentElement;
    if (!parent || !text.data) continue;
    const css = doc.defaultView!.getComputedStyle(parent);
    const size = parseFloat(css.fontSize);
    const mono = Boolean(parent.closest('pre,code,kbd,samp'));
    const bold = Number(css.fontWeight) >= 600 || css.fontWeight === 'bold';
    const italic = css.fontStyle !== 'normal';
    context.font = `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${size}px ${css.fontFamily}`;
    const metrics = context.measureText('Hg');
    const ascent = metrics.fontBoundingBoxAscent || size;
    const range = doc.createRange();
    let run: TextRun | undefined;
    let offset = 0;
    for (const character of text.data) {
      range.setStart(text, offset); offset += character.length; range.setEnd(text, offset);
      const rect = range.getBoundingClientRect();
      if (character === '\n' || character === '\r' || rect.width < .01 || rect.height < .01) { run = undefined; continue; }
      const box = relativeBox(rect, origin);
      const currentMono = mono && /^[\x20-\x7e]$/.test(character);
      // Browser layout supplies Unicode line wrapping and HTML table geometry.
      // Separate runs at line/font changes so PDF retains actual selectable text.
      if (run && Math.abs(run.box.y - box.y) < .2 && run.mono === currentMono && box.x >= run.box.x && Math.abs(box.x - (run.box.x + run.box.width)) < 1.2 && character !== '\t') {
        run.text += character; run.box.width = box.x + box.width - run.box.x;
      } else {
        // Inline Range rectangles use the primary CSS font's line metrics even
        // when a glyph falls back to Noto. Keep one baseline for that visual line.
        run = { text: character === '\t' ? ' ' : character, box, baseline: box.y + ascent, size, color: color(css.color) ?? rgb(.14, .21, .18), bold, italic, mono: currentMono };
        runs.push(run);
      }
      if (++inspected % 512 === 0) await tick(options.signal);
    }
    range.detach();
  }
  canvas.width = 0; canvas.height = 0;
  return runs;
}

async function picture(pdf: PDFDocument, element: HTMLImageElement, options: DocumentPdfOptions): Promise<PDFImage> {
  const width = element.naturalWidth, height = element.naturalHeight;
  if (!width || !height || width * height > LIMITS.maxImagePixels) throw new ConversionError('文档图片尺寸无效或超过 1600 万像素，请缩小后重试。');
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  try {
    const context = canvas.getContext('2d');
    if (!context) throw new ConversionError('图片转换初始化失败。');
    context.drawImage(element, 0, 0);
    const blob = await abortable(new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new ConversionError('本地图片转换失败。')), 'image/png')), options.signal);
    const bytes = await blob.arrayBuffer(); throwIfAborted(options.signal);
    return await pdf.embedPng(bytes);
  } finally { canvas.width = 0; canvas.height = 0; }
}

/** The input is the sanitized fragment returned by renderDocument, never raw HTML. */
export async function htmlToPdf(html: string, options: DocumentPdfOptions): Promise<Uint8Array> {
  throwIfAborted(options.signal);
  const margin = number(options.marginMm, 18, 0, 40) * 72 / 25.4;
  const paper = options.paper === 'Letter' ? [612, 792] : [595.2756, 841.8898];
  const width = options.landscape ? paper[1]! : paper[0]!;
  const height = options.landscape ? paper[0]! : paper[1]!;
  const contentWidth = (width - margin * 2) / POINTS_PER_PIXEL;
  const contentHeight = (height - margin * 2) / POINTS_PER_PIXEL;
  const bytes = await loadDocumentFont(options.signal);
  const pdf = await PDFDocument.create(); pdf.registerFontkit(fontkit);
  pdf.setTitle(options.title || '近译文档'); pdf.setCreator('近译 · 本地文档转换'); pdf.setProducer('近译 / pdf-lib');
  const font = await pdf.embedFont(bytes, { subset: true, features: { liga: false, kern: false } });
  const courier = await pdf.embedFont(StandardFonts.Courier);
  throwIfAborted(options.signal);
  const frame = await layoutFrame(html, { ...options, fontSize: number(options.fontSize, 11, 8, 24) }, bytes, contentWidth);
  try {
    const doc = frame.contentDocument!, main = doc.querySelector('main')!;
    const origin = main.getBoundingClientRect();
    const text = await collectText(doc, font, origin, options);
    await tick(options.signal);
    // Missing glyph replacement may change wrapping; collectText measures after
    // replacing all nodes, so all surfaces use the same settled layout.
    const surfaces: Surface[] = [], links: Link[] = [], checkboxes: Array<{ box: Box; checked: boolean }> = [];
    const boxes: Box[] = text.map(run => run.box), headings: Box[] = [];
    const pictures: Picture[] = [], imageCache = new Map<string, PDFImage>();
    const imageElements = [...doc.images];
    for (const element of main.querySelectorAll('*')) {
      const rect = relativeBox(element.getBoundingClientRect(), origin);
      const css = doc.defaultView!.getComputedStyle(element);
      const borders = ['Top', 'Right', 'Bottom', 'Left'].map(side => ({ width: parseFloat(css.getPropertyValue(`border-${side.toLowerCase()}-width`)) || 0, color: color(css.getPropertyValue(`border-${side.toLowerCase()}-color`)) }));
      const fill = color(css.backgroundColor);
      if (fill || borders.some(border => border.width && border.color)) surfaces.push({ box: rect, fill, borders });
      if (/^(TR|IMG|H[1-6])$/.test(element.tagName)) boxes.push(rect);
      if (/^H[1-6]$/.test(element.tagName)) headings.push(rect);
      if (element.tagName === 'A') {
        const href = element.getAttribute('href') ?? '';
        if (/^(https?:|mailto:|#)/i.test(href)) for (const linkRect of element.getClientRects()) links.push({ box: relativeBox(linkRect, origin), href });
      }
      if (element.tagName === 'INPUT') checkboxes.push({ box: rect, checked: (element as HTMLInputElement).checked });
    }
    // Keep headings with the first following text line when both fit one page.
    for (const heading of headings) {
      const next = text.find(run => run.box.y >= heading.y + heading.height - .1);
      if (next && next.box.y + next.box.height - heading.y <= contentHeight) boxes.push({ ...heading, height: next.box.y + next.box.height - heading.y });
    }
    // The shared document stylesheet limits tall images to one printable page.
    for (const image of imageElements) {
      const rect = relativeBox(image.getBoundingClientRect(), origin);
      if (rect.height > contentHeight) {
        throw new ConversionError('图片高于一页，请缩小图片尺寸或改用横向页面后重试。');
      }
      let embedded = imageCache.get(image.src);
      if (!embedded) { embedded = await picture(pdf, image, options); imageCache.set(image.src, embedded); }
      pictures.push({ box: rect, image: embedded });
      await tick(options.signal);
    }
    const maxHeight = boxes.reduce((maximum, box) => Math.max(maximum, box.y + box.height), Math.max(main.getBoundingClientRect().height, 1));
    const starts = paginateDocument(maxHeight, contentHeight, boxes);
    const pages = starts.map(() => pdf.addPage([width, height]));
    const pageIndex = (y: number) => { let index = 0; while (index + 1 < starts.length && starts[index + 1]! <= y + .15) index++; return index; };
    const xy = (box: Box, index: number) => ({ x: margin + box.x * POINTS_PER_PIXEL, y: height - margin - (box.y - starts[index]!) * POINTS_PER_PIXEL });
    const segment = (box: Box, index: number): Box | undefined => {
      const top = Math.max(box.y, starts[index]!);
      const bottom = Math.min(box.y + box.height, starts[index + 1] ?? starts[index]! + contentHeight);
      if (bottom <= top) return undefined;
      return { ...box, y: top, height: bottom - top };
    };
    options.onProgress?.(0, pages.length);
    for (let index = 0; index < pages.length; index++) {
      await tick(options.signal);
      const page = pages[index]!;
      for (const surface of surfaces) {
        const box = segment(surface.box, index); if (!box) continue;
        const position = xy(box, index), w = box.width * POINTS_PER_PIXEL, h = box.height * POINTS_PER_PIXEL;
        if (surface.fill) page.drawRectangle({ x: position.x, y: position.y - h, width: w, height: h, color: surface.fill });
        const points = [
          [position.x, position.y, position.x + w, position.y], [position.x + w, position.y, position.x + w, position.y - h],
          [position.x, position.y - h, position.x + w, position.y - h], [position.x, position.y, position.x, position.y - h],
        ];
        surface.borders.forEach((border, side) => {
          const coordinates = points[side]!;
          if (border.width && border.color) page.drawLine({ start: { x: coordinates[0]!, y: coordinates[1]! }, end: { x: coordinates[2]!, y: coordinates[3]! }, thickness: border.width * POINTS_PER_PIXEL, color: border.color });
        });
      }
      for (const run of text) if (pageIndex(run.box.y) === index) {
        const position = xy(run.box, index);
        page.pushOperators(pushGraphicsState());
        if (run.bold) page.pushOperators(setTextRenderingMode(TextRenderingMode.FillAndOutline), setLineWidth(run.size * .018 * POINTS_PER_PIXEL), setStrokingRgbColor(run.color.red, run.color.green, run.color.blue));
        page.drawText(run.text, { x: position.x, y: height - margin - (run.baseline - starts[index]!) * POINTS_PER_PIXEL, size: run.size * POINTS_PER_PIXEL,
          font: run.mono ? courier : font, color: run.color, ySkew: run.italic ? degrees(12) : undefined });
        page.pushOperators(popGraphicsState());
      }
      for (const image of pictures) if (pageIndex(image.box.y) === index) {
        const position = xy(image.box, index); page.drawImage(image.image, { x: position.x, y: position.y - image.box.height * POINTS_PER_PIXEL, width: image.box.width * POINTS_PER_PIXEL, height: image.box.height * POINTS_PER_PIXEL });
      }
      for (const checkbox of checkboxes) if (pageIndex(checkbox.box.y) === index) {
        const p = xy(checkbox.box, index), w = checkbox.box.width * POINTS_PER_PIXEL, h = checkbox.box.height * POINTS_PER_PIXEL;
        page.drawRectangle({ x: p.x, y: p.y - h, width: w, height: h, borderWidth: .7, borderColor: rgb(.2, .4, .3) });
        if (checkbox.checked) {
          page.drawLine({ start: { x: p.x + w * .18, y: p.y - h * .5 }, end: { x: p.x + w * .42, y: p.y - h * .76 }, thickness: 1, color: rgb(.1, .4, .3) });
          page.drawLine({ start: { x: p.x + w * .42, y: p.y - h * .76 }, end: { x: p.x + w * .84, y: p.y - h * .2 }, thickness: 1, color: rgb(.1, .4, .3) });
        }
      }
      for (const link of links) {
        const box = segment(link.box, index); if (!box) continue;
        const p = xy(box, index);
        const annotation = pdf.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [p.x, p.y - box.height * POINTS_PER_PIXEL, p.x + box.width * POINTS_PER_PIXEL, p.y], Border: [0, 0, 0] });
        if (link.href.startsWith('#')) {
          const target = doc.getElementById(link.href.slice(1)); if (!target) continue;
          const targetBox = relativeBox(target.getBoundingClientRect(), origin), targetPage = pageIndex(targetBox.y);
          annotation.set(PDFName.of('Dest'), pdf.context.obj([pages[targetPage]!.ref, PDFName.of('XYZ'), margin, xy(targetBox, targetPage).y, null]));
        } else annotation.set(PDFName.of('A'), pdf.context.obj({ Type: 'Action', S: 'URI', URI: PDFString.of(link.href) }));
        page.node.addAnnot(pdf.context.register(annotation));
      }
      options.onProgress?.(index + 1, pages.length);
    }
    await tick(options.signal);
    const output = await pdf.save({ objectsPerTick: 25 });
    throwIfAborted(options.signal);
    if (output.byteLength > LIMITS.maxOutputBytes) throw new ConversionError('生成的 PDF 超过 128 MB，请减少图片或拆分文档。');
    return output;
  } finally { frame.remove(); }
}
