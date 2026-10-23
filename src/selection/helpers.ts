import { MAX_CONTEXT_LENGTH, MAX_TEXT_LENGTH, type TranslationKind } from '../shared/contracts';
import { isTranslatableText, supportsWordDetails, type LanguageOptions } from '../shared/languages';

export interface Point { x: number; y: number }
export interface RectLike { left: number; top: number; right: number; bottom: number }

export function classifySelection(text: string, languages: LanguageOptions = {}): TranslationKind {
  return supportsWordDetails(languages) && /^[A-Za-z]+(?:['’\-][A-Za-z]+)*$/.test(text.trim()) ? 'word' : 'text';
}

export function isTranslatableSelection(text: string, languages: LanguageOptions = {}, languageHint?: string): boolean {
  return isTranslatableText(text, languages, languageHint);
}

export function isEnglishSelection(text: string): boolean {
  return /[A-Za-z]/.test(text);
}

export function selectionError(text: string): string | undefined {
  return text.length > MAX_TEXT_LENGTH
    ? `选中的内容超过 ${MAX_TEXT_LENGTH.toLocaleString('en-US')} 个字符，请分段翻译。`
    : undefined;
}

/** Context is kept separate from the translation target; no target is truncated. */
export function boundedContext(
  block: string,
  selection: string,
  kind: TranslationKind,
  startOffset?: number,
): string | undefined {
  if (!selection.trim() || typeof Intl.Segmenter !== 'function') return undefined;
  const found = startOffset ?? block.indexOf(selection);
  if (found < 0 || block.slice(found, found + selection.length) !== selection) return undefined;
  // Repeated text without a DOM offset does not identify which surrounding sentence is relevant.
  if (startOffset === undefined && block.indexOf(selection, found + selection.length) >= 0) return undefined;
  const leading = selection.length - selection.trimStart().length;
  const trailing = selection.length - selection.trimEnd().length;
  const start = found + leading;
  const end = found + selection.length - trailing;
  const sentences = Array.from(new Intl.Segmenter('en', { granularity: 'sentence' }).segment(block))
    .map(({ index, segment }) => ({
      start: index + segment.length - segment.trimStart().length,
      end: index + segment.trimEnd().length,
      text: segment.trim(),
    })).filter((sentence) => sentence.text);
  const first = sentences.findIndex((sentence) => sentence.end > start);
  const last = sentences.findLastIndex((sentence) => sentence.start < end);
  if (first < 0 || last < first) return undefined;
  const containing = sentences[first]!;
  const isPartialSentence = first === last && (start > containing.start || end < containing.end);
  if (kind === 'word' || isPartialSentence) {
    if (first !== last || containing.text === selection.trim()) return undefined;
    // Center a long containing sentence on the selected word or phrase.
    const selectedLength = end - start;
    if (selectedLength > MAX_CONTEXT_LENGTH) return undefined;
    const offset = Math.max(0, start - containing.start - Math.floor((MAX_CONTEXT_LENGTH - selectedLength) / 2));
    return containing.text.slice(offset, offset + MAX_CONTEXT_LENGTH);
  }
  // A complete sentence or paragraph receives exactly one adjacent sentence.
  const previous = sentences[first - 1];
  if (previous) return previous.text.slice(-MAX_CONTEXT_LENGTH);
  return sentences[last + 1]?.text.slice(0, MAX_CONTEXT_LENGTH);
}

export function placeOverlay(
  anchor: Point,
  width: number,
  height: number,
  viewport: { width: number; height: number },
  gap = 10,
): Point {
  const margin = 10;
  const maxX = Math.max(margin, viewport.width - width - margin);
  const maxY = Math.max(margin, viewport.height - height - margin);
  let y = anchor.y + gap;
  if (y + height + margin > viewport.height) y = anchor.y - height - gap;
  return {
    x: Math.min(maxX, Math.max(margin, anchor.x + gap)),
    y: Math.min(maxY, Math.max(margin, y)),
  };
}
