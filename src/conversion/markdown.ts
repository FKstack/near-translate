import { Marked } from 'marked';
import { ConversionError, LIMITS } from './types';

export interface DocumentImage {
  name: string;
  /** A caller-owned blob URL or a base64 raster data URL. Never a network URL. */
  url: string;
}

export interface RenderDocumentOptions {
  title?: string;
  images?: DocumentImage[];
}

export interface PrintDocumentOptions {
  title: string;
  paper: 'A4' | 'Letter';
  landscape: boolean;
  /** Page margins in millimetres. */
  marginMm: number;
  /** Body type size in points. */
  fontSize: number;
}

const MAX_SOURCE_BYTES = LIMITS.maxMarkdownBytes;
const MAX_OUTPUT_BYTES = Math.min(LIMITS.maxOutputBytes, 64 * 1024 * 1024);
const MAX_DOCUMENT_NODES = 150_000;
const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const ANCHOR_PREFIX = 'near-document-';
const htmlEscapes: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  '\u00a0': '&nbsp;',
};
const markdown = new Marked({ gfm: true, breaks: false, async: false });
const encoder = new TextEncoder();
const allowedElements = new Set([
  'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'code', 'dd', 'del', 'div',
  'dl', 'dt', 'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr', 'i', 'img', 'input', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 's', 'samp',
  'small', 'span', 'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th',
  'thead', 'tr', 'u', 'ul',
]);
const discardedElements = new Set([
  'applet', 'audio', 'base', 'button', 'canvas', 'embed', 'frame', 'frameset',
  'head', 'iframe', 'link', 'math', 'meta', 'noscript', 'object', 'option',
  'script', 'select', 'source', 'style', 'svg', 'template', 'textarea', 'title', 'track',
  'video',
]);

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => htmlEscapes[character]!);
}

function outputTooLarge(): never {
  throw new ConversionError('转换结果过大，请减少图片引用或拆分文档后再转换。');
}

function checkOutputHtml(html: string): string {
  // The length check avoids allocating a second huge byte buffer for oversized
  // serialized documents. UTF-8 is checked too, including Chinese body text.
  if (html.length > MAX_OUTPUT_BYTES || encoder.encode(html).byteLength > MAX_OUTPUT_BYTES) outputTooLarge();
  return html;
}

/** Upper bound for text/attribute serialization without allocating escaped HTML. */
function escapedBytes(value: string): number {
  let bytes = encoder.encode(value).byteLength;
  for (const match of value.matchAll(/[&<>"'\u00a0]/g)) bytes += htmlEscapes[match[0]]!.length - 1;
  return bytes;
}

function decodePath(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

function attachmentPath(value: string, isSource = true): string | undefined {
  const withoutQuery = isSource ? value.trim().split(/[?#]/, 1)[0] ?? '' : value.trim();
  const decoded = decodePath(withoutQuery).replace(/\\/g, '/');
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(decoded)) return undefined;
  return decoded.replace(/^(?:\.\/)+/, '').replace(/^\/+/, '');
}

function basename(value: string): string {
  return value.slice(value.lastIndexOf('/') + 1);
}

function isTrustedImageUrl(value: string): boolean {
  if (/^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,[a-z\d+/=\s]+$/i.test(value)) {
    return true;
  }
  if (!value.startsWith('blob:') || /[\s\u0000-\u001f\u007f]/.test(value)) return false;
  try { return new URL(value).protocol === 'blob:'; } catch { return false; }
}

function imageResolver(images: DocumentImage[]) {
  const trustedUrls = new Set<string>();
  const paths = new Map<string, string | null>();
  const names = new Map<string, string | null>();
  const add = (map: Map<string, string | null>, key: string, value: string) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, value);
    else if (map.get(key) !== value) map.set(key, null);
  };
  for (const image of images) {
    if (!isTrustedImageUrl(image.url)) continue;
    trustedUrls.add(image.url);
    const key = attachmentPath(image.name, false);
    if (key) {
      add(paths, key, image.url);
      add(names, basename(key), image.url);
    }
  }
  return (source: string): string | undefined => {
    if (trustedUrls.has(source)) return source;
    const key = attachmentPath(source);
    if (!key) return undefined;
    // Ambiguous exact or basename matches must not silently choose an attachment.
    if (paths.has(key)) return paths.get(key) ?? undefined;
    return names.get(basename(key)) ?? undefined;
  };
}

function anchorSuffix(value: string): string {
  return decodePath(value).normalize('NFKC').toLowerCase()
    .replace(/[^\p{L}\p{N}_:.-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 128) || 'section';
}

function safeLink(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === '#') return '#';
  if (trimmed.startsWith('#')) return `#${ANCHOR_PREFIX}${anchorSuffix(trimmed.slice(1))}`;
  try {
    const url = new URL(trimmed);
    if (['https:', 'http:', 'mailto:'].includes(url.protocol)) return url.href;
  } catch { /* Relative links and malformed URLs remain plain text. */ }
  return undefined;
}

function imageLabel(alt: string, source: string): string {
  return (alt.trim() || decodePath(source).replace(/[\u0000-\u001f]/g, '') || '未命名图片').slice(0, 160);
}

function sanitizeHtml(source: string, images: DocumentImage[]): { html: string; warnings: string[] } {
  // Parse untrusted markup inside an inert template. Parsing it directly as the
  // DOMParser document body can initiate img/iframe resource requests in browsers.
  const document = new DOMParser().parseFromString('<!doctype html><html><body></body></html>', 'text/html');
  const input = document.createElement('template');
  input.innerHTML = source;
  const output = document.createElement('template');
  const resolveImage = imageResolver(images);
  const warnings = new Set<string>();
  const ids = new Set<string>();
  let removedContent = false;
  let removedLinks = false;
  let visited = 0;
  let outputBytes = 0;
  const imageBytes = new Map<string, number>();
  const reserveBytes = (bytes: number) => {
    if (outputBytes + bytes > MAX_OUTPUT_BYTES) outputTooLarge();
    outputBytes += bytes;
  };
  const pending: Array<{ source: Node; target: Node }> = [];
  const enqueueChildren = (from: Node, target: Node) => {
    for (let index = from.childNodes.length - 1; index >= 0; index--) {
      const child = from.childNodes[index];
      if (child) pending.push({ source: child, target });
    }
  };
  enqueueChildren(input.content, output.content);
  while (pending.length) {
    const task = pending.pop()!;
    if (++visited > MAX_DOCUMENT_NODES) throw new ConversionError('文档结构过于复杂，请拆分后再转换。');
    if (task.source.nodeType === 3) {
      const text = task.source.textContent ?? '';
      reserveBytes(escapedBytes(text));
      task.target.appendChild(document.createTextNode(text));
      continue;
    }
    if (task.source.nodeType !== 1) continue;
    const original = task.source as Element;
    const tag = original.localName;
    if (original.namespaceURI !== HTML_NAMESPACE || discardedElements.has(tag)) {
      removedContent = true;
      continue;
    }
    if (!allowedElements.has(tag)) {
      enqueueChildren(original, task.target);
      continue;
    }
    if (Array.from(original.attributes).some(({ name }) => name === 'style' || /^on/i.test(name))) {
      removedContent = true;
    }
    if (tag === 'img') {
      const sourceUrl = original.getAttribute('src') ?? '';
      const alt = original.getAttribute('alt') ?? '';
      const url = resolveImage(sourceUrl);
      if (!url) {
        const label = imageLabel(alt, sourceUrl);
        const placeholder = document.createElement('span');
        placeholder.className = 'conversion-missing-image';
        placeholder.setAttribute('role', 'note');
        placeholder.textContent = `[图片未包含：${label}]`;
        reserveBytes(encoder.encode(placeholder.outerHTML).byteLength);
        task.target.appendChild(placeholder);
        warnings.add(`图片未载入：${label}。请添加对应的本地图片；不会自动加载网络图片。`);
      } else {
        const title = original.getAttribute('title');
        let urlBytes = imageBytes.get(url);
        if (urlBytes === undefined) {
          urlBytes = escapedBytes(url);
          imageBytes.set(url, urlBytes);
        }
        // Charge every reference, even when all of them point to one attachment.
        // Reserve before setting src or creating another serialized data URL.
        reserveBytes(urlBytes + escapedBytes(alt) + escapedBytes(title ?? '') + 96);
        const image = document.createElement('img');
        image.setAttribute('src', url);
        image.setAttribute('alt', alt);
        image.setAttribute('loading', 'eager');
        if (title) image.setAttribute('title', title);
        task.target.appendChild(image);
      }
      continue;
    }
    if (tag === 'input' && original.getAttribute('type')?.toLowerCase() !== 'checkbox') {
      removedContent = true;
      continue;
    }
    const element = document.createElement(tag);
    const title = original.getAttribute('title');
    if (title) element.setAttribute('title', title);
    const dir = original.getAttribute('dir');
    if (dir && ['ltr', 'rtl', 'auto'].includes(dir)) element.setAttribute('dir', dir);
    const language = original.getAttribute('lang');
    if (language && /^[a-z\d-]{1,35}$/i.test(language)) element.setAttribute('lang', language);
    const originalId = original.getAttribute('id');
    if (originalId || /^h[1-6]$/.test(tag)) {
      const baseId = `${ANCHOR_PREFIX}${anchorSuffix(originalId || original.textContent || 'section')}`;
      let id = baseId;
      let index = 2;
      while (ids.has(id)) id = `${baseId}-${index++}`;
      ids.add(id);
      element.setAttribute('id', id);
    }
    if (tag === 'a' && original.hasAttribute('href')) {
      const href = safeLink(original.getAttribute('href') ?? '');
      if (href) {
        element.setAttribute('href', href);
        element.setAttribute('rel', 'noopener noreferrer');
        if (!href.startsWith('#')) element.setAttribute('target', '_blank');
      } else removedLinks = true;
    }
    if (tag === 'input') {
      element.setAttribute('type', 'checkbox');
      element.setAttribute('disabled', '');
      if (original.hasAttribute('checked')) element.setAttribute('checked', '');
    }
    if (tag === 'ol') {
      const start = original.getAttribute('start');
      if (start && /^-?\d{1,6}$/.test(start)) element.setAttribute('start', start);
    }
    if (tag === 'code') {
      const className = (original.getAttribute('class') ?? '').split(/\s+/)
        .find((name) => /^language-[a-z\d_+.-]{1,64}$/i.test(name));
      if (className) element.className = className;
    }
    if (tag === 'th' || tag === 'td') {
      for (const name of ['colspan', 'rowspan']) {
        const value = original.getAttribute(name) ?? '';
        if (/^\d{1,3}$/.test(value)) element.setAttribute(name, String(Math.max(1, Math.min(100, Number(value)))));
      }
      const align = original.getAttribute('align');
      if (align && ['left', 'center', 'right'].includes(align)) element.className = `conversion-align-${align}`;
      const scope = original.getAttribute('scope');
      if (tag === 'th' && scope && ['row', 'col', 'rowgroup', 'colgroup'].includes(scope)) element.setAttribute('scope', scope);
    }
    reserveBytes(encoder.encode(element.outerHTML).byteLength);
    task.target.appendChild(element);
    enqueueChildren(original, element);
  }
  if (removedContent) warnings.add('已移除脚本、样式和嵌入内容，保留可打印的正文。');
  if (removedLinks) warnings.add('已移除不安全或本地文件链接；仅保留 http、https、mailto 与文内锚点。');
  return { html: checkOutputHtml(output.innerHTML), warnings: [...warnings] };
}

/** Local-only document conversion. Callers retain ownership of attachment URLs. */
export async function renderDocument(
  source: string,
  format: 'markdown' | 'text' | 'html',
  options: RenderDocumentOptions = {},
): Promise<{ html: string; warnings: string[] }> {
  if (typeof source !== 'string') throw new ConversionError('请输入要转换的文档内容。');
  if (source.length > MAX_SOURCE_BYTES || encoder.encode(source).byteLength > MAX_SOURCE_BYTES) {
    throw new ConversionError('文档内容不能超过 5 MB，请拆分后再转换。');
  }
  if (format === 'text') {
    if (escapedBytes(source) + '<pre class="conversion-plain-text"></pre>'.length > MAX_OUTPUT_BYTES) outputTooLarge();
    return { html: checkOutputHtml(`<pre class="conversion-plain-text">${escapeHtml(source)}</pre>`), warnings: [] };
  }
  if (format !== 'markdown' && format !== 'html') throw new ConversionError('不支持的文档格式。');
  const html = format === 'markdown' ? await markdown.parse(source) : source;
  return sanitizeHtml(html, options.images ?? []);
}

function boundedNumber(value: number, fallback: number, minimum: number, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(Math.min(maximum, Math.max(minimum, value)) * 10) / 10
    : fallback;
}

/**
 * Wrap ONLY the sanitized HTML returned by renderDocument. Used for optional
 * HTML preview/export and shared layout styles. Native PDF download is owned
 * by document-pdf; this helper does not invoke a print dialog or load fonts.
 */
export function buildPrintDocument(html: string, options: PrintDocumentOptions): string {
  checkOutputHtml(html);
  const paper = options.paper === 'Letter' ? 'Letter' : 'A4';
  const landscape = options.landscape === true;
  const margin = boundedNumber(options.marginMm, 16, 0, 40);
  const fontSize = boundedNumber(options.fontSize, 11, 8, 24);
  const [shortSide, longSide]: [number, number] = paper === 'A4' ? [210, 297] : [215.9, 279.4];
  const width = landscape ? longSide : shortSide;
  const height = landscape ? shortSide : longSide;
  const title = escapeHtml(String(options.title || '近译 · 文档转换'));
  const fullDocument = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-src 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${title}</title>
<style>
@page { size: ${paper} ${landscape ? 'landscape' : 'portrait'}; margin: ${margin}mm; }
* { box-sizing: border-box; }
html { color-scheme: light; background: #edf2ef; }
body { width: ${width}mm; min-height: ${height}mm; margin: 24px auto; padding: ${margin}mm; background: white; color: #24352e; font: ${fontSize}pt/1.7 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", sans-serif; }
main { min-width: 0; overflow-wrap: anywhere; }
h1, h2, h3, h4, h5, h6 { line-height: 1.35; margin: 1.4em 0 .6em; break-after: avoid; page-break-after: avoid; }
h1 { font-size: 2em; } h2 { font-size: 1.5em; } h3 { font-size: 1.2em; }
p, ul, ol, dl, blockquote, pre, figure, table { margin: .8em 0; }
p, li { orphans: 3; widows: 3; }
li > p { margin: .35em 0; }
a { color: #246b5a; text-decoration: underline; overflow-wrap: anywhere; }
blockquote { padding: .1em 1em; margin-left: 0; margin-right: 0; border-left: 3px solid #a8cdbd; color: #53675c; }
pre, code, kbd, samp { font-family: "Cascadia Code", "SFMono-Regular", Consolas, "Liberation Mono", monospace; font-size: .9em; }
code { white-space: break-spaces; overflow-wrap: anywhere; }
pre { padding: .9em; border: 1px solid #dbe5de; border-radius: 6px; background: #f5f8f5; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; break-inside: auto; page-break-inside: auto; }
pre code { font-size: inherit; white-space: pre-wrap; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: .92em; }
thead { display: table-header-group; } tfoot { display: table-footer-group; }
tbody { break-inside: auto; }
tr { break-inside: avoid; page-break-inside: avoid; }
th, td { padding: .5em .65em; border: 1px solid #ccd9d0; text-align: left; vertical-align: top; white-space: normal; overflow-wrap: anywhere; word-break: break-word; }
th { background: #f0f5f0; font-weight: 600; }
.conversion-align-left { text-align: left; } .conversion-align-center { text-align: center; } .conversion-align-right { text-align: right; }
figure { margin-left: 0; margin-right: 0; break-inside: avoid; }
img { max-width: 100%; max-height: ${Math.max(40, height - margin * 2 - 5)}mm; height: auto; object-fit: contain; }
figcaption, caption { color: #617267; font-size: .9em; }
hr { border: 0; border-top: 1px solid #dbe5de; margin: 1.5em 0; }
input[type="checkbox"] { accent-color: #328670; }
.conversion-missing-image { display: inline-block; padding: .2em .5em; color: #786744; background: #faf5e8; border: 1px dashed #d5c6a4; font-size: .9em; }
.conversion-plain-text { padding: 0; border: 0; border-radius: 0; background: transparent; font: inherit; white-space: pre-wrap; overflow-wrap: anywhere; }
@media screen and (max-width: ${width}mm) { body { width: 100%; min-height: 0; margin: 0; padding: min(${margin}mm, 5vw); } }
@media print {
  html { background: white; }
  body { width: auto; min-height: 0; margin: 0; padding: 0; color: #111; box-shadow: none; }
  a { color: inherit; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
</style>
</head>
<body><main>${html}</main></body>
</html>`;
  return checkOutputHtml(fullDocument);
}
