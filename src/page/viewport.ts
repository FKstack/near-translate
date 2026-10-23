import type { PageSegment } from './segments';

/** A disposable geometry snapshot. It never owns DOM observers or translated text. */
export interface PageViewportPriority {
  readonly tier: number;
  readonly distance: number;
  readonly visibleProse: boolean;
}

const UNAVAILABLE: PageViewportPriority = { tier: 4, distance: Infinity, visibleProse: false };
const NON_PROSE = 'h1,h2,h3,h4,h5,h6,nav,header,footer,aside,[role="navigation"]';

function isProse(segment: PageSegment): boolean {
  if (segment.text.length < 80 || (segment.text.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g)?.length ?? 0) < 12) return false;
  if (segment.container.closest(NON_PROSE)) return false;
  const linked = segment.nodes.reduce((sum, node) => sum + (node.parentElement?.closest('a') ? node.data.length : 0), 0);
  return linked < segment.text.length * 0.6;
}

function hidden(element: HTMLElement, view: Window): boolean {
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (current.hidden || current.getAttribute('aria-hidden') === 'true') return true;
    const style = view.getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return true;
  }
  return false;
}

/**
 * Measures only original Text ranges, so inserted translations cannot make a source
 * paragraph appear visible. The returned map is also the benchmark's viewport policy.
 */
export function snapshotViewportPriorities(segments: readonly PageSegment[]): ReadonlyMap<PageSegment, PageViewportPriority> {
  const priorities = new Map<PageSegment, PageViewportPriority>();
  for (const segment of segments) {
    const doc = segment.container.ownerDocument;
    const view = doc?.defaultView;
    if (!view || doc.visibilityState === 'hidden' || !segment.container.isConnected || hidden(segment.container, view)) {
      priorities.set(segment, UNAVAILABLE); continue;
    }
    const width = view.innerWidth || doc.documentElement.clientWidth;
    const height = view.innerHeight || doc.documentElement.clientHeight;
    let distance = Infinity;
    let visible = false;
    for (const node of segment.nodes) {
      if (!node.isConnected || !node.data.length || !node.parentElement || hidden(node.parentElement, view)) continue;
      const range = doc.createRange();
      try {
        range.setStart(node, 0); range.setEnd(node, node.data.length);
        for (const rect of Array.from(range.getClientRects())) {
          if (rect.width <= 0 || rect.height <= 0) continue;
          const dx = Math.max(0, -rect.right, rect.left - width);
          const dy = Math.max(0, -rect.bottom, rect.top - height);
          distance = Math.min(distance, dx + dy);
          if (rect.right > 0 && rect.left < width && rect.bottom > 0 && rect.top < height) visible = true;
        }
      } catch { /* A concurrent website edit invalidates this range, never the translation session. */ }
      finally { range.detach(); }
    }
    const prose = isProse(segment);
    priorities.set(segment, !Number.isFinite(distance) ? UNAVAILABLE : {
      tier: visible ? (prose ? 0 : 1) : prose ? 2 : 3,
      distance, visibleProse: visible && prose,
    });
  }
  return priorities;
}
