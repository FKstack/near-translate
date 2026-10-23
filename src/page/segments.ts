import { MAX_TEXT_LENGTH } from '../shared/contracts';
import { isTranslatableText, resolveLanguagePair, type LanguageOptions, type LanguagePair } from '../shared/languages';

/** A paragraph snapshot. Original nodes remain owned by the website. */
export interface PageSegment {
  nodes: Text[];
  text: string;
  anchor: Node;
  container: HTMLElement;
}

export const MAX_PAGE_SEGMENTS = 1_500;
// One extra intact segment lets the session keep its existing limitReached signal.
const MAX_COLLECTED_SEGMENTS = MAX_PAGE_SEGMENTS + 1;

const BLOCK_TAGS = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT', 'FIGCAPTION',
  'FIGURE', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'LI', 'MAIN', 'NAV', 'P', 'SECTION', 'TD', 'TH']);
const EXCLUDED_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'PRE', 'TEXTAREA', 'INPUT', 'SELECT',
  'OPTION', 'BUTTON', 'SVG', 'MATH', 'CANVAS', 'VIDEO', 'AUDIO', 'IFRAME', 'OBJECT', 'EMBED']);
const OWN_SELECTOR = 'near-translate,near-page-translate,[data-near-translate],[data-near-page-ui],'
  + '[data-near-page-translation],[data-near-translation]';
const CODE_SELECTOR = '.monaco-editor,.CodeMirror,.cm-editor,.ace_editor,.code-block,.codehilite,'
  + '.highlight,.syntaxhighlighter,.rouge-code,[data-code-block]';
const snapshots = new WeakMap<PageSegment, { values: string[]; languages: Readonly<LanguagePair> }>();

function excludedElement(element: Element, styleOf: (element: Element) => CSSStyleDeclaration | undefined): boolean {
  if (EXCLUDED_TAGS.has(element.tagName) || element.matches(OWN_SELECTOR) || element.matches(CODE_SELECTOR)) return true;
  if (element.hasAttribute('hidden') || element.getAttribute('aria-hidden') === 'true'
    || element.getAttribute('translate')?.toLowerCase() === 'no'
    || element.classList.contains('notranslate') || element.getAttribute('role') === 'textbox') return true;
  const editable = element.getAttribute('contenteditable');
  if (editable !== null && editable.toLowerCase() !== 'false') return true;
  const style = styleOf(element);
  return style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse'
    || style?.contentVisibility === 'hidden'
    || (element.tagName === 'CODE' && ['block', 'flex', 'grid'].includes(style?.display ?? ''));
}

/** Prefer one visible article, then one main region; ambiguous layouts retain full-page coverage. */
export function selectPageTranslationRoot(page: Document = document): HTMLElement {
  const styleOf = (element: Element) => page.defaultView?.getComputedStyle(element);
  const eligible = (element: Element) => {
    for (let current: Element | null = element; current; current = current.parentElement) {
      if (excludedElement(current, styleOf)) return false;
    }
    return true;
  };
  for (const tag of ['article', 'main']) {
    const candidates = [...page.querySelectorAll<HTMLElement>(tag)].filter(eligible);
    if (candidates.length === 1) return candidates[0]!;
  }
  return page.body;
}

/** Avoid adding a second Chinese copy to pages that are already mostly Chinese. */
export function isTranslatablePageText(text: string, languages: LanguageOptions = {}, languageHint?: string): boolean {
  return (text.match(/\p{L}/gu)?.length ?? 0) >= 2 && isTranslatableText(text, languages, languageHint);
}

/** No character is discarded; request consumers concatenate translated chunks in order. */
export function splitPageText(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > MAX_TEXT_LENGTH) {
    const prefix = remaining.slice(0, MAX_TEXT_LENGTH);
    const minimum = Math.floor(MAX_TEXT_LENGTH / 2);
    let boundary = -1;
    for (const match of prefix.matchAll(/[.!?。！？](?:["'”’)]*)\s+|\n+/g)) {
      const end = match.index! + match[0].length;
      if (end >= minimum) boundary = end;
    }
    if (boundary < minimum) {
      for (const match of prefix.matchAll(/\s+/g)) {
        const end = match.index! + match[0].length;
        if (end >= minimum) boundary = end;
      }
    }
    if (boundary < minimum) boundary = MAX_TEXT_LENGTH;
    // A hard boundary must not divide a UTF-16 surrogate pair.
    const previous = remaining.charCodeAt(boundary - 1);
    const next = remaining.charCodeAt(boundary);
    if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) boundary--;
    chunks.push(remaining.slice(0, boundary));
    remaining = remaining.slice(boundary);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

/** Extract semantic blocks in document order without replacing any website DOM. */
export function collectPageSegments(root: HTMLElement = document.body, languages: LanguageOptions = {}): PageSegment[] {
  if (!root) return [];
  const languageSnapshot = Object.freeze(resolveLanguagePair(languages));
  const segments: PageSegment[] = [];
  const atLimit = () => segments.length >= MAX_COLLECTED_SEGMENTS;
  const view = root.ownerDocument.defaultView;
  const styles = new WeakMap<Element, CSSStyleDeclaration>();
  const styleOf = (element: Element) => {
    let style = styles.get(element);
    if (!style && view) { style = view.getComputedStyle(element); styles.set(element, style); }
    return style;
  };
  const excluded = (element: Element): boolean => excludedElement(element, styleOf);
  for (let ancestor: Element | null = root; ancestor; ancestor = ancestor.parentElement) {
    if (excluded(ancestor)) return [];
  }
  const isBlock = (element: Element): element is HTMLElement => {
    if (['CODE', 'KBD', 'SAMP'].includes(element.tagName)) return false;
    return BLOCK_TAGS.has(element.tagName)
      || ['block', 'flow-root', 'list-item', 'table-cell', 'flex', 'grid'].includes(styleOf(element)?.display ?? '');
  };

  const collectBlock = (container: HTMLElement) => {
    if (atLimit()) return;
    const languageHint = container.closest('[lang]')?.getAttribute('lang') ?? root.ownerDocument.documentElement.lang;
    let nodes: Text[] = [];
    let pieces: string[] = [];
    let prose: string[] = [];
    const flush = () => {
      if (atLimit()) return;
      const text = pieces.join('').replace(/\s+/g, ' ').trim();
      if (nodes.length && isTranslatablePageText(text, languages, languageHint) && isTranslatablePageText(prose.join(''), languages, languageHint)) {
        // Insert after the original inline wrapper, never inside a link or emphasis node.
        let anchor: Node = nodes.at(-1)!;
        while (anchor.parentNode && anchor.parentNode !== container) anchor = anchor.parentNode;
        const segment = { nodes, text, anchor, container };
        snapshots.set(segment, { values: nodes.map(node => node.data), languages: languageSnapshot });
        segments.push(segment);
      }
      nodes = []; pieces = []; prose = [];
    };
    const walk = (node: Node, inCode = false) => {
      if (atLimit()) return;
      if (node.nodeType === 3) {
        const text = node as Text;
        nodes.push(text); pieces.push(text.data);
        if (!inCode) prose.push(text.data);
        return;
      }
      if (node.nodeType !== 1) return;
      const element = node as Element;
      if (excluded(element)) {
        // Keep words on either side of a skipped object separated.
        pieces.push(' '); prose.push(' ');
        return;
      }
      if (element.tagName === 'IMG' || element.tagName === 'PICTURE' || element.tagName === 'BR' || element.tagName === 'HR') {
        pieces.push(' '); prose.push(' ');
        return;
      }
      if (isBlock(element)) {
        flush(); collectBlock(element); return;
      }
      const code = inCode || ['CODE', 'KBD', 'SAMP'].includes(element.tagName);
      for (const child of element.childNodes) { if (atLimit()) break; walk(child, code); }
    };
    for (const child of container.childNodes) { if (atLimit()) break; walk(child); }
    flush();
  };
  collectBlock(root);
  return segments;
}

/** Recheck text, position and eligibility before inserting an asynchronous result. */
export function segmentIsCurrent(segment: PageSegment): boolean {
  if (!segment.container.isConnected || !segment.anchor.isConnected || !segment.nodes.length) return false;
  const original = snapshots.get(segment);
  if (segment.nodes.some((node, index) => !node.isConnected || !segment.container.contains(node)
    || (original && node.data !== original.values[index]))) return false;
  return collectPageSegments(segment.container, original?.languages).some(current => current.text === segment.text
    && current.nodes.length === segment.nodes.length && current.nodes.every((node, index) => node === segment.nodes[index]));
}
