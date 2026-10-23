import { Readability } from '@mozilla/readability';
import type { ReadingArticle, ReadingOutlineItem } from './types';

const HTML_NS = 'http://www.w3.org/1999/xhtml';
const SOURCE_ATTRIBUTE = 'data-near-reader-source';
const IMAGE_ATTRIBUTE = 'data-near-reader-image-src';
// Bound work by DOM complexity, not by a short article character limit.
const MAX_NODES = 80_000;
const MAX_ELEMENTS = 40_000;
const MAX_TEXT = 4_000_000;
const MAX_DEPTH = 160;
const OWN_SELECTOR = 'near-translate,near-page-translate,near-reading-mode,'
  + '[data-near-translate],[data-near-page-ui],[data-near-page-translation],[data-near-translation]';
const OMIT_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED',
  'FORM', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'BUTTON', 'SVG', 'CANVAS', 'VIDEO', 'AUDIO',
  'LINK', 'META', 'BASE', 'NAV', 'ASIDE', 'FOOTER']);
const SAFE_TAGS = new Set(['A', 'ABBR', 'ARTICLE', 'B', 'BDI', 'BDO', 'BLOCKQUOTE', 'BR', 'CAPTION',
  'CITE', 'CODE', 'COL', 'COLGROUP', 'DD', 'DEL', 'DFN', 'DIV', 'DL', 'DT', 'EM', 'FIGCAPTION',
  'FIGURE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'I', 'IMG', 'INS', 'KBD', 'LI',
  'MAIN', 'MARK', 'OL', 'P', 'PRE', 'Q', 'RP', 'RT', 'RUBY', 'S', 'SAMP', 'SECTION', 'SMALL',
  'SPAN', 'STRONG', 'SUB', 'SUP', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TIME', 'TR', 'U', 'UL', 'VAR', 'WBR']);
const SOURCE_TAGS = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'H1', 'H2', 'H3', 'H4', 'H5',
  'H6', 'PRE', 'BLOCKQUOTE', 'LI', 'DD', 'DT', 'TD', 'TH', 'FIGCAPTION', 'TABLE', 'FIGURE']);
const METADATA = new Set(['author', 'description', 'og:title', 'og:description', 'og:site_name',
  'twitter:title', 'twitter:description', 'dc.creator', 'dcterm.creator']);

function text(value: string | null | undefined, maximum = 500): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function httpUrl(value: string | null | undefined, base?: string): string | undefined {
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  try {
    const url = new URL(value.trim(), base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
    return url.href;
  } catch { return undefined; }
}

function omitted(element: Element, page: Document): boolean {
  if (OMIT_TAGS.has(element.tagName) || element.matches(OWN_SELECTOR)
    || element.hasAttribute('hidden') || element.getAttribute('aria-hidden')?.toLowerCase() === 'true'
    || element.getAttribute('role') === 'textbox') return true;
  const editable = element.getAttribute('contenteditable');
  if (editable !== null && editable.toLowerCase() !== 'false') return true;
  try {
    const style = page.defaultView?.getComputedStyle(element);
    return style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse'
      || style?.contentVisibility === 'hidden';
  } catch { return false; }
}

interface Snapshot {
  document: Document;
  sources: Map<string, Element>;
}

/** An inert, bounded copy keeps Readability's mutations and URL handling off the website. */
function snapshot(page: Document, sourceUrl: string): Snapshot {
  if (!page.body) throw new Error('页面还没有可供阅读的正文，请等待页面加载后重试。');
  if (omitted(page.body, page) || omitted(page.documentElement, page)) {
    throw new Error('没有找到可见的文章正文。请等待页面加载后重试。');
  }
  const document = page.implementation.createHTMLDocument(text(page.title));
  const base = document.createElement('base');
  base.href = httpUrl(page.baseURI, sourceUrl) ?? sourceUrl;
  document.head.append(base);
  let metadataCount = 0;
  for (const meta of page.head?.querySelectorAll('meta[name],meta[property]') ?? []) {
    if (++metadataCount > 64) break;
    const name = (meta.getAttribute('name') ?? meta.getAttribute('property') ?? '').toLowerCase();
    if (!METADATA.has(name)) continue;
    const copy = document.createElement('meta');
    copy.setAttribute(meta.hasAttribute('property') ? 'property' : 'name', name);
    copy.content = text(meta.getAttribute('content'), 2_000);
    document.head.append(copy);
  }
  document.documentElement.lang = page.documentElement.lang;
  const sources = new Map<string, Element>();
  const stack: Array<{ source: Node; parent: Node; depth: number }> = [];
  if (page.body.firstChild) stack.push({ source: page.body.firstChild, parent: document.body, depth: 1 });
  let nodes = 0;
  let elements = 0;
  let characters = 0;
  while (stack.length) {
    const { source, parent, depth } = stack.pop()!;
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) {
      throw new Error('页面结构过于复杂，暂时无法完整提取正文。请打开文章详情页后重试。');
    }
    // Queue only one sibling at a time, so even a huge untrusted body cannot
    // allocate an unbounded traversal stack before reaching the node limit.
    if (source.nextSibling) stack.push({ source: source.nextSibling, parent, depth });
    if (source.nodeType === 3) {
      const value = source.nodeValue ?? '';
      characters += value.length;
      if (characters > MAX_TEXT) throw new Error('文章超过当前阅读模式的完整提取上限。');
      parent.appendChild(document.createTextNode(value));
      continue;
    }
    if (source.nodeType !== 1) continue;
    const element = source as Element;
    if (omitted(element, page)) continue;
    if (++elements > MAX_ELEMENTS) throw new Error('页面元素过多，暂时无法完整提取正文。');
    if (element.localName === 'math') {
      const math = document.createElement('span');
      math.className = 'near-reader-math';
      const value = element.querySelector('annotation[encoding="application/x-tex"]')?.textContent
        ?? element.textContent ?? '';
      characters += value.length;
      if (characters > MAX_TEXT) throw new Error('文章超过当前阅读模式的完整提取上限。');
      math.textContent = value;
      parent.appendChild(math);
      continue;
    }
    if (element.namespaceURI !== HTML_NS) continue;
    const tag = SAFE_TAGS.has(element.tagName) ? element.localName : 'span';
    const copy = document.createElement(tag);
    // Class/id help Readability score content; neither survives the final allowlist.
    for (const name of ['class', 'id', 'lang', 'dir', 'role', 'title']) {
      const value = element.getAttribute(name);
      if (value !== null) copy.setAttribute(name, value.slice(0, 1_000));
    }
    if (SOURCE_TAGS.has(element.tagName)) {
      const id = `r${sources.size + 1}`;
      sources.set(id, element);
      copy.setAttribute(SOURCE_ATTRIBUTE, id);
    }
    if (tag === 'a') {
      const href = httpUrl(element.getAttribute('href'), base.href);
      if (href) copy.setAttribute('href', href);
    }
    if (tag === 'img') {
      // Readability must see a real image, including SVG URLs it does not treat
      // as lazy-image data. This document has no browsing context; only the
      // final live-ownerDocument output defers src until the user opens it.
      const original = element as HTMLImageElement;
      const href = [original.currentSrc, element.getAttribute('src'), element.getAttribute('data-src'),
        element.getAttribute('data-original')].map(value => httpUrl(value, base.href)).find(Boolean);
      if (href) {
        copy.setAttribute(IMAGE_ATTRIBUTE, href);
        copy.setAttribute('src', href);
      }
      copy.setAttribute('alt', text(element.getAttribute('alt'), 2_000));
      for (const name of ['width', 'height']) {
        const value = element.getAttribute(name);
        if (value && /^\d{1,5}$/.test(value)) copy.setAttribute(name, value);
      }
    }
    if (['td', 'th'].includes(tag)) {
      for (const name of ['colspan', 'rowspan', 'scope']) {
        const value = element.getAttribute(name);
        if (value) copy.setAttribute(name, value);
      }
    }
    if (tag === 'ol' && /^-?\d{1,6}$/.test(element.getAttribute('start') ?? '')) {
      copy.setAttribute('start', element.getAttribute('start')!);
    }
    parent.appendChild(copy);
    if (element.firstChild) stack.push({ source: element.firstChild, parent: copy, depth: depth + 1 });
  }
  removeSourceNavigation(document.body, sourceUrl);
  return { document, sources };
}

function localFragment(value: string | null, sourceUrl: string): string | undefined {
  const href = httpUrl(value, sourceUrl);
  if (!href) return undefined;
  const url = new URL(href);
  const source = new URL(sourceUrl);
  if (url.origin !== source.origin || url.pathname !== source.pathname || url.search !== source.search || !url.hash) return undefined;
  try { return decodeURIComponent(url.hash.slice(1)); } catch { return undefined; }
}

/** Remove only explicit navigation that the reader's own outline replaces. */
function removeSourceNavigation(root: HTMLElement, sourceUrl: string): void {
  const headings = 'h1,h2,h3,h4,h5,h6';
  for (const anchor of root.querySelectorAll('a[href]')) {
    const heading = anchor.closest(headings);
    if (!heading || !/^[¶#§🔗]+$/u.test(text(anchor.textContent)) || anchor.querySelector('code,kbd,samp,pre')) continue;
    const fragment = localFragment(anchor.getAttribute('href'), sourceUrl);
    const target = fragment ? root.ownerDocument.getElementById(fragment) : null;
    if (target && (target === heading || heading.contains(target))) anchor.remove();
  }
  const isContentsTitle = (element: Element) => /^(?:table of contents|contents|目录)$/i.test(text(element.textContent));
  const isLinkNavigation = (container: Element, labels: Element[] = []): boolean => {
    const links = [...container.querySelectorAll('a')];
    if (links.length < 3 || links.some(link => !localFragment(link.getAttribute('href'), sourceUrl))
      || container.querySelector('img,pre,figure')) return false;
    const walker = root.ownerDocument.createTreeWalker(container, 4);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (!node.nodeValue?.trim()) continue;
      if (labels.some(label => label.contains(node))) continue;
      const anchor = node.parentElement?.closest('a');
      if (!anchor || !container.contains(anchor)) return false;
    }
    return true;
  };
  for (const table of root.querySelectorAll('table')) {
    const labels = [...table.querySelectorAll('caption,th')]
      .filter(label => label.closest('table') === table && isContentsTitle(label));
    if (labels.length && isLinkNavigation(table, labels)) table.remove();
  }
  for (const heading of root.querySelectorAll(headings)) {
    const list = heading.nextElementSibling;
    if (isContentsTitle(heading) && list?.matches('ul,ol,dl') && isLinkNavigation(list)) {
      list.remove(); heading.remove();
    }
  }
}

function articleText(root: Element): string {
  return (root.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function isArticle(root: Element): boolean {
  const prose = articleText(root);
  const letters = prose.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
  if (letters < 100) return false;
  let linked = 0;
  for (const anchor of root.querySelectorAll('a')) linked += articleText(anchor).length;
  return linked < prose.length * 0.6;
}

/** Semantic fallback is limited to explicit article/main regions, never the whole body. */
function semanticCandidate(document: Document): HTMLElement | undefined {
  let best: HTMLElement | undefined;
  let bestScore = 0;
  let candidates = 0;
  let characters = 0;
  for (const candidate of document.body.querySelectorAll<HTMLElement>('article,main,[role="main"]')) {
    if (++candidates > 128) break;
    characters += candidate.textContent?.length ?? 0;
    if (characters > MAX_TEXT * 2) break;
    if (!isArticle(candidate)) continue;
    const length = articleText(candidate).length;
    let linked = 0;
    for (const anchor of candidate.querySelectorAll('a')) linked += articleText(anchor).length;
    const score = (length - linked) * (candidate.tagName === 'ARTICLE' ? 1.1 : 1);
    if (score > bestScore) { bestScore = score; best = candidate; }
  }
  return best;
}

function lostImages(original: Element, extracted: Element): boolean {
  const remaining = new Map<string, number>();
  for (const image of extracted.querySelectorAll(`img[${IMAGE_ATTRIBUTE}]`)) {
    const url = image.getAttribute(IMAGE_ATTRIBUTE)!;
    remaining.set(url, (remaining.get(url) ?? 0) + 1);
  }
  for (const image of original.querySelectorAll(`img[${IMAGE_ATTRIBUTE}]`)) {
    const url = image.getAttribute(IMAGE_ATTRIBUTE)!;
    const count = remaining.get(url) ?? 0;
    if (!count) return true;
    remaining.set(url, count - 1);
  }
  return false;
}

interface Sanitized {
  content: HTMLElement;
  outline: ReadingOutlineItem[];
  sourceMap: Map<string, Element>;
}

/** Remove metadata only before the first substantive article content. */
function removeLeadingMetadata(content: HTMLElement, title: string, byline: string): void {
  const normalize = (value: string | null) => (value ?? '').replace(/\s+/g, ' ').trim();
  const author = normalize(byline).replace(/^by\s+/i, '');
  const substantive = 'img,pre,code,table,figure,hr,ul,ol,dl,blockquote,h1,h2,h3,h4,h5,h6';
  const stack: Node[] = content.firstChild ? [content.firstChild] : [];
  let titleRemoved = false;
  while (stack.length) {
    const node = stack.pop()!;
    if (node.nextSibling) stack.push(node.nextSibling);
    if (node.nodeType === 3) {
      if (normalize(node.nodeValue)) return;
      continue;
    }
    if (node.nodeType !== 1) continue;
    const element = node as HTMLElement;
    if (element.matches('h1,h2')) {
      if (titleRemoved || normalize(element.textContent) !== title) return;
      element.remove(); titleRemoved = true; continue;
    }
    if (element.matches(substantive)) return;
    if (author && author.length <= 160 && element.matches('p,div,span,header')
      && !element.querySelector(substantive)) {
      const value = normalize(element.textContent);
      if (value.length <= 160 && value.replace(/^by\s+/i, '') === author) {
        element.remove(); continue;
      }
    }
    if (element.firstChild) stack.push(element.firstChild);
  }
}

function sanitize(root: Node, page: Document, sourceUrl: string, sources: Map<string, Element>, title: string, byline: string): Sanitized {
  const content = page.createElement('article');
  const sourceMap = new Map<string, Element>();
  const anchors = new Map<string, HTMLElement>();
  const links: Array<{ element: HTMLAnchorElement; url: URL }> = [];
  const outline: ReadingOutlineItem[] = [];
  const stack: Array<{ source: Node; parent: Node }> = [{ source: root, parent: content }];
  let anchorCount = 0;
  while (stack.length) {
    const { source, parent } = stack.pop()!;
    if (source.nodeType === 3) {
      parent.appendChild(page.createTextNode(source.nodeValue ?? ''));
      continue;
    }
    if (source.nodeType !== 1) continue;
    const element = source as Element;
    if (OMIT_TAGS.has(element.tagName) || element.namespaceURI !== HTML_NS) continue;
    let tag = SAFE_TAGS.has(element.tagName) ? element.localName : undefined;
    if (tag === 'h1') tag = 'h2';
    const copy = tag ? page.createElement(tag) : undefined;
    const container = copy ?? parent;
    if (copy) {
      const sourceId = element.getAttribute(SOURCE_ATTRIBUTE);
      const original = sourceId ? sources.get(sourceId) : undefined;
      if (sourceId && original) {
        copy.setAttribute(SOURCE_ATTRIBUTE, sourceId);
        sourceMap.set(sourceId, original);
      }
      const oldId = element.getAttribute('id');
      if (oldId && !anchors.has(oldId)) {
        copy.id = `near-reader-anchor-${++anchorCount}`;
        anchors.set(oldId, copy);
      }
      const dir = element.getAttribute('dir');
      if (dir && ['ltr', 'rtl', 'auto'].includes(dir)) copy.dir = dir;
      const lang = element.getAttribute('lang');
      if (lang && /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/i.test(lang)) copy.lang = lang;
      if (tag === 'a') {
        const href = httpUrl(element.getAttribute('href'), sourceUrl);
        if (href) {
          const anchor = copy as HTMLAnchorElement;
          anchor.href = href;
          anchor.rel = 'noopener noreferrer';
          anchor.target = '_blank';
          links.push({ element: anchor, url: new URL(href) });
        }
      }
      if (tag === 'img') {
        const href = httpUrl(element.getAttribute(IMAGE_ATTRIBUTE), sourceUrl);
        if (!href) continue;
        copy.setAttribute(IMAGE_ATTRIBUTE, href);
        copy.setAttribute('alt', text(element.getAttribute('alt'), 2_000));
        copy.setAttribute('loading', 'lazy');
        copy.setAttribute('decoding', 'async');
        copy.setAttribute('referrerpolicy', 'no-referrer');
        for (const name of ['width', 'height']) {
          const value = element.getAttribute(name);
          if (value && /^\d{1,5}$/.test(value)) copy.setAttribute(name, value);
        }
      }
      if (tag === 'td' || tag === 'th') {
        for (const name of ['colspan', 'rowspan']) {
          const value = element.getAttribute(name);
          if (value && /^\d{1,3}$/.test(value) && Number(value) > 0) copy.setAttribute(name, value);
        }
        const scope = element.getAttribute('scope');
        if (scope && ['row', 'col', 'rowgroup', 'colgroup'].includes(scope)) copy.setAttribute('scope', scope);
      }
      if (tag === 'ol' && /^-?\d{1,6}$/.test(element.getAttribute('start') ?? '')) {
        copy.setAttribute('start', element.getAttribute('start')!);
      }
      if (element.classList.contains('near-reader-math')) copy.className = 'near-reader-math';
      parent.appendChild(copy);
    }
    for (let child = element.lastChild; child; child = child.previousSibling) stack.push({ source: child, parent: container });
  }
  removeLeadingMetadata(content, title, byline);
  const retainedSources = new Set([...content.querySelectorAll(`[${SOURCE_ATTRIBUTE}]`)]
    .map(element => element.getAttribute(SOURCE_ATTRIBUTE)!));
  for (const id of sourceMap.keys()) if (!retainedSources.has(id)) sourceMap.delete(id);
  for (const heading of content.querySelectorAll<HTMLElement>('h2,h3,h4,h5,h6')) {
    const label = text(heading.textContent, 300);
    if (!label) continue;
    heading.id = `near-reader-heading-${outline.length + 1}`;
    outline.push({ id: heading.id, text: label, level: Number(heading.tagName.slice(1)) });
  }
  const origin = new URL(sourceUrl);
  for (const { element, url } of links) {
    if (url.origin !== origin.origin || url.pathname !== origin.pathname || url.search !== origin.search || !url.hash) continue;
    let fragment: string;
    try { fragment = decodeURIComponent(url.hash.slice(1)); } catch { continue; }
    const destination = anchors.get(fragment);
    if (destination?.id && content.contains(destination)) {
      element.setAttribute('href', `#${destination.id}`);
      element.removeAttribute('target');
    }
  }
  return { content, outline, sourceMap };
}

/** Local-only extraction: no source mutations, HTML injection, translation, or network requests. */
export function extractReadingArticle(page: Document = document, url = page.location?.href): ReadingArticle {
  const sourceUrl = httpUrl(url);
  if (!sourceUrl) throw new Error('阅读模式目前仅支持 HTTP 或 HTTPS 文章页面。');
  const { document: copy, sources } = snapshot(page, sourceUrl);
  const semantic = semanticCandidate(copy);
  // Readability mutates its input; retain the inert semantic candidate for a safe fallback.
  const semanticCopy = semantic?.cloneNode(true) as HTMLElement | undefined;
  let result: ReturnType<Readability<Node>['parse']> = null;
  try {
    result = new Readability<Node>(copy, {
      serializer: node => node,
      maxElemsToParse: MAX_ELEMENTS + 100,
      charThreshold: 200,
      disableJSONLD: true,
      keepClasses: false,
      classesToPreserve: ['near-reader-math'],
    }).parse();
  } catch {
    // An upstream parser failure may still have an intact, explicit article.
  }
  let extracted = result?.content?.nodeType === 1 ? result.content as HTMLElement : undefined;
  let strategy: ReadingArticle['strategy'] = 'readability';
  const lostArticleDetails = semanticCopy && extracted && (['pre', 'table', 'figcaption'].some(tag =>
    semanticCopy.querySelectorAll(tag).length > extracted!.querySelectorAll(tag).length)
    || lostImages(semanticCopy, extracted));
  if (!extracted || !isArticle(extracted) || lostArticleDetails) {
    extracted = semanticCopy;
    strategy = 'semantic';
  }
  if (!extracted || !isArticle(extracted)) throw new Error('没有找到适合阅读的文章正文。请打开文章详情页后重试。');
  const articleHeadings = semanticCopy?.querySelectorAll('h1');
  const semanticTitle = articleHeadings?.length === 1 ? text(articleHeadings[0]!.textContent) : '';
  const title = semanticTitle || text(result?.title) || text(page.title) || '未命名文章';
  const rawByline = text(result?.byline);
  const byline = rawByline.split(/\s+/).filter(part => !/^https?:\/\//i.test(part) || !httpUrl(part)).join(' ');
  const { content, outline, sourceMap } = sanitize(extracted, page, sourceUrl, sources, title, rawByline);
  const prose = articleText(content);
  const cjk = prose.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length ?? 0;
  const words = prose.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? [];
  const otherWords = words.filter(word => /[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(word)).length;
  const lang = text(result?.lang || page.documentElement.lang, 80);
  return {
    title,
    byline,
    siteName: text(result?.siteName) || new URL(sourceUrl).hostname,
    sourceUrl,
    lang: /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/i.test(lang) ? lang : '',
    excerpt: text(result?.excerpt, 240) || text(prose, 240),
    wordCount: cjk + otherWords,
    readingMinutes: Math.max(1, Math.ceil(cjk / 350 + otherWords / 220)),
    content,
    outline,
    strategy,
    truncated: false,
    sourceMap,
  };
}
