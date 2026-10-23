import { describe, expect, it, vi } from 'vitest';
import type { PageSegment } from '../../src/page/segments';
import { snapshotViewportPriorities } from '../../src/page/viewport';

const prose = 'This paragraph contains enough original English words to explain the design and its useful behavior in a normal article.';
type Box = { left: number; top: number; right: number; bottom: number; width: number; height: number };
const box = (left = 10, top = 20, width = 500, height = 30): Box => ({ left, top, width, height, right: left + width, bottom: top + height });

function fixture() {
  const rects = new Map<Text, Box[]>();
  const styles = new Map<object, Record<string, string>>();
  const measured: Text[] = [];
  let selected: Text;
  const detach = vi.fn();
  const doc = { visibilityState: 'visible', documentElement: { clientWidth: 800, clientHeight: 600 },
    defaultView: { innerWidth: 800, innerHeight: 600, getComputedStyle: (element: object) => ({
      display: 'block', visibility: 'visible', opacity: '1', ...styles.get(element),
    }) },
    createRange: () => ({
      setStart: (node: Text, offset: number) => { expect(offset).toBe(0); selected = node; measured.push(node); },
      setEnd: (node: Text, offset: number) => { expect(node).toBe(selected); expect(offset).toBe(node.data.length); },
      getClientRects: () => rects.get(selected) ?? [], detach,
    }),
  };
  function element(tagName = 'P', parentElement: HTMLElement | null = null): HTMLElement {
    const result = { tagName, parentElement, isConnected: true, hidden: false, ownerDocument: doc,
      getAttribute: () => null,
      closest: (selector: string): HTMLElement | null => {
        if (selector === 'a') return tagName === 'A' ? result as unknown as HTMLElement : parentElement?.closest(selector) ?? null;
        if (['H1', 'H2', 'H3', 'NAV', 'HEADER', 'FOOTER', 'ASIDE'].includes(tagName)) return result as unknown as HTMLElement;
        return parentElement?.closest(selector) ?? null;
      },
    };
    return result as unknown as HTMLElement;
  }
  function segment(text = prose, rectangles = [box()], container = element()): PageSegment {
    const node = { data: text, parentElement: container, isConnected: true } as unknown as Text;
    rects.set(node, rectangles);
    return { text, nodes: [node], anchor: node, container };
  }
  return { doc, rects, styles, measured, detach, element, segment };
}

describe('original-source viewport snapshots', () => {
  it('prioritizes visible prose over headings and short brand names without excluding either source', () => {
    const f = fixture();
    const paragraph = f.segment();
    const heading = f.segment(prose, [box()], f.element('H2'));
    const brand = f.segment('BBC Worldwide');
    const below = f.segment(prose, [box(10, 900)]);
    const snapshot = snapshotViewportPriorities([heading, brand, below, paragraph]);
    expect(snapshot.size).toBe(4);
    expect(snapshot.get(paragraph)).toEqual({ tier: 0, distance: 0, visibleProse: true });
    expect(snapshot.get(heading)).toMatchObject({ tier: 1, visibleProse: false });
    expect(snapshot.get(brand)).toMatchObject({ tier: 1, visibleProse: false });
    expect(snapshot.get(below)).toEqual({ tier: 2, distance: 300, visibleProse: false });
  });

  it('checks both viewport axes and accepts genuinely intersecting original lines', () => {
    const f = fixture();
    const left = f.segment(prose, [box(-600, 20, 500)]);
    const right = f.segment(prose, [box(850, 20)]);
    const crossing = f.segment(prose, [box(-100, -10, 300, 30)]);
    const snapshot = snapshotViewportPriorities([left, right, crossing]);
    expect(snapshot.get(left)).toMatchObject({ distance: 100, visibleProse: false });
    expect(snapshot.get(right)).toMatchObject({ distance: 50, visibleProse: false });
    expect(snapshot.get(crossing)?.visibleProse).toBe(true);
  });

  it('rejects hidden ancestors, transparent sources and background-document viewport claims', () => {
    const f = fixture();
    const ancestor = f.element('DIV');
    const hidden = f.segment(prose, [box()], f.element('P', ancestor));
    f.styles.set(ancestor, { display: 'none' });
    const transparent = f.segment(); f.styles.set(transparent.container, { opacity: '0' });
    const snapshot = snapshotViewportPriorities([hidden, transparent]);
    expect([...snapshot.values()].every(value => value.tier === 4 && !value.visibleProse)).toBe(true);
    f.doc.visibilityState = 'hidden';
    expect(snapshotViewportPriorities([f.segment()]).values().next().value?.visibleProse).toBe(false);
  });

  it('does not promote a link-heavy table of contents to prose', () => {
    const f = fixture();
    const item = f.segment(prose, [box()], f.element('LI'));
    Object.assign(item.nodes[0]!, { parentElement: f.element('A', item.container) });
    expect(snapshotViewportPriorities([item]).get(item)).toMatchObject({ tier: 1, visibleProse: false });
  });

  it('measures each original text range rather than container or inserted translation geometry', () => {
    const f = fixture();
    const original = f.segment(prose, [box(10, 900)]);
    const second = f.segment(' Additional original source words.', [box(10, 930)], original.container);
    original.nodes.push(second.nodes[0]!); original.text += second.text;
    Object.assign(original.container, { getBoundingClientRect: () => box(), textContent: prose + ' 可见的新译文' });
    const snapshot = snapshotViewportPriorities([original]);
    expect(snapshot.get(original)).toMatchObject({ distance: 300, visibleProse: false });
    expect(f.measured).toEqual(original.nodes);
    expect(f.detach).toHaveBeenCalledTimes(2);
  });
});
