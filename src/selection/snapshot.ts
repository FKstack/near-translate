import type { TranslationInput } from '../shared/contracts';
import { boundedContext, classifySelection, isEnglishSelection, type Point } from './helpers';

export interface SelectionSnapshot {
  input: TranslationInput;
  signature: string;
  anchor: Point;
  range?: Range;
}

const BLOCKS = 'p,li,blockquote,pre,td,th,article,section,h1,h2,h3,h4,h5,h6,div';

function elementFrom(node: Node | null): Element | null {
  return node instanceof Element ? node : node?.parentElement ?? null;
}

function nearbyBlock(node: Node | null): Element | null {
  return elementFrom(node)?.closest(BLOCKS) ?? elementFrom(node);
}

function selectionInPath(path: EventTarget[]): Selection | null {
  for (const target of path) {
    if (!(target instanceof Node)) continue;
    const root = target.getRootNode();
    if (root instanceof ShadowRoot) {
      const shadowSelection = (root as ShadowRoot & { getSelection?: () => Selection | null }).getSelection?.();
      if (shadowSelection && !shadowSelection.isCollapsed) return shadowSelection;
    }
  }
  return document.getSelection();
}

function editableInPath(path: EventTarget[]): HTMLInputElement | HTMLTextAreaElement | undefined {
  return path.find((node): node is HTMLInputElement | HTMLTextAreaElement =>
    node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement);
}

export function takeSelectionSnapshot(options: {
  path?: EventTarget[];
  pointer?: Point;
  includeContext: boolean;
  root: HTMLElement | Document;
}): SelectionSnapshot | undefined {
  const path = options.path ?? [document.activeElement].filter((node): node is Element => !!node);
  const editable = editableInPath(path);
  if (editable) {
    if (editable instanceof HTMLInputElement && ['password', 'hidden'].includes(editable.type)) return;
    if (options.root instanceof HTMLElement && !options.root.contains(editable)) return;
    let start: number | null;
    let end: number | null;
    try { start = editable.selectionStart; end = editable.selectionEnd; } catch { return; }
    if (start === null || end === null || start === end) return;
    const raw = editable.value.slice(start, end);
    const text = raw.trim();
    if (!text || !isEnglishSelection(text)) return;
    const kind = classifySelection(text);
    const rect = editable.getBoundingClientRect();
    return {
      input: { text, kind, context: options.includeContext ? boundedContext(editable.value, raw, kind, start) : undefined },
      signature: `input:${start}:${end}:${raw}`,
      anchor: options.pointer ?? { x: Math.min(rect.right, rect.left + 36), y: rect.bottom },
    };
  }
  const selection = selectionInPath(path);
  if (!selection || selection.isCollapsed || !selection.rangeCount) return;
  const range = selection.getRangeAt(0).cloneRange();
  if (options.root instanceof HTMLElement && (!options.root.contains(range.startContainer) || !options.root.contains(range.endContainer))) return;
  const raw = selection.toString();
  const text = raw.trim();
  if (!text || !isEnglishSelection(text)) return;
  const kind = classifySelection(text);
  let context: string | undefined;
  if (options.includeContext) {
    const startBlock = nearbyBlock(range.startContainer);
    const endBlock = nearbyBlock(range.endContainer);
    if (startBlock && startBlock === endBlock) {
      let offset: number | undefined;
      try {
        const prefix = document.createRange();
        prefix.selectNodeContents(startBlock);
        prefix.setEnd(range.startContainer, range.startOffset);
        offset = prefix.toString().length;
      } catch { /* A detached selection can still translate without context. */ }
      context = boundedContext(startBlock.textContent ?? '', raw, kind, offset);
    } else {
      const before = startBlock?.textContent ?? '';
      const after = endBlock?.textContent ?? '';
      // A multi-block selection uses only its boundary blocks, never the whole page.
      const local = `${before}\n${after}`;
      context = boundedContext(local, raw, kind);
    }
  }
  const rects = Array.from(range.getClientRects());
  const rect = rects.at(-1) ?? range.getBoundingClientRect();
  return {
    input: { text, kind, context },
    signature: `range:${range.startOffset}:${range.endOffset}:${raw}`,
    anchor: options.pointer ?? { x: rect.right, y: rect.bottom },
    range,
  };
}
