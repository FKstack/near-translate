import { describe, expect, it, vi } from 'vitest';
import type { PageSegment } from '../../src/page/segments';
import { snapshotViewportPriorities } from '../../src/page/viewport';

const prose = 'This paragraph contains enough original English words to explain the design and its useful behavior in a normal article.';
type Box = { left: number; top: number; right: number; bottom: number; width: number; height: number };
const box = (left = 10, top = 20, width = 500, height = 30): Box => ({ left, top, width, height, right: left + width, bottom: top + height });
const hiddenStyles: Record<string, string>[] = [
  { display: 'none' }, { visibility: 'hidden' }, { visibility: 'collapse' }, { opacity: '0' },
];

function fixture() {
  const rects = new Map<Text, Box[]>();
  const styles = new Map<object, Record<string, string>>();
  const measured: Text[] = [];
  let selected: Text;
  const detach = vi.fn();
  const doc = { visibilityState: 'visible', documentElement: { clientWidth: 800, clientHeight: 600 },
    defaultView: { innerWidth: 800, innerHeight: 600, getComputedStyle: vi.fn((element: object) => ({
      display: 'block', visibility: 'visible', opacity: '1', ...styles.get(element),
    })) },
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
  it('reads each shared ancestor once across 251 paragraphs and their original text ranges', () => {
    const f = fixture();
    const html = f.element('HTML');
    const body = f.element('BODY', html);
    const article = f.element('ARTICLE', body);
    const passages = Array.from({ length: 251 }, () => {
      const paragraph = f.segment(prose, [box()], f.element('P', article));
      const additional = f.segment(' Additional original English text.', [box()], paragraph.container);
      paragraph.nodes.push(additional.nodes[0]!); paragraph.text += additional.text;
      return paragraph;
    });
    const snapshot = snapshotViewportPriorities(passages);
    expect([...snapshot.values()].every(value => value.visibleProse && value.tier === 0 && value.distance === 0)).toBe(true);
    expect(f.doc.defaultView.getComputedStyle).toHaveBeenCalledTimes(254);
    expect(new Set(f.doc.defaultView.getComputedStyle.mock.calls.map(([element]) => element)).size).toBe(254);
    expect(f.measured).toHaveLength(502);
    expect(f.detach).toHaveBeenCalledTimes(502);
  });

  it.each(hiddenStyles)('shares hidden-ancestor results without hiding a visible sibling branch (%j)', style => {
    const f = fixture();
    const article = f.element('ARTICLE');
    const hiddenParent = f.element('DIV', article);
    f.styles.set(hiddenParent, style);
    const visible = f.segment(prose, [box()], f.element('P', article));
    const hidden = [f.segment(prose, [box()], f.element('P', hiddenParent)),
      f.segment(prose, [box()], f.element('P', hiddenParent))];
    const sibling = f.segment(prose, [box()], f.element('P', article));
    const snapshot = snapshotViewportPriorities([visible, ...hidden, sibling]);
    expect(snapshot.get(visible)?.visibleProse).toBe(true);
    expect(snapshot.get(sibling)?.visibleProse).toBe(true);
    expect(hidden.every(segment => snapshot.get(segment)?.tier === 4)).toBe(true);
    expect(f.measured).toEqual([visible.nodes[0], sibling.nodes[0]]);
    expect(f.doc.defaultView.getComputedStyle.mock.calls.filter(([element]) => element === hiddenParent)).toHaveLength(1);
  });

  it('keeps hidden child elements and aria-hidden text parents separate from cached visible ancestors', () => {
    const f = fixture();
    const article = f.element('ARTICLE');
    const visible = f.segment(prose, [box()], f.element('P', article));
    const hidden = f.segment(prose, [box()], f.element('P', article));
    hidden.container.hidden = true;
    const hiddenText = f.segment(prose, [box()], f.element('P', article));
    const parent = f.element('SPAN', hiddenText.container);
    Object.assign(parent, { getAttribute: (name: string) => name === 'aria-hidden' ? 'true' : null });
    Object.assign(hiddenText.nodes[0]!, { parentElement: parent });
    const sibling = f.segment(prose, [box()], f.element('P', article));
    const snapshot = snapshotViewportPriorities([visible, hidden, hiddenText, sibling]);
    expect(snapshot.get(hidden)?.tier).toBe(4);
    expect(snapshot.get(hiddenText)?.tier).toBe(4);
    expect(snapshot.get(visible)?.visibleProse).toBe(true);
    expect(snapshot.get(sibling)?.visibleProse).toBe(true);
    expect(f.measured).toEqual([visible.nodes[0], sibling.nodes[0]]);
  });

  it('rechecks style changes in each later snapshot instead of retaining visible or hidden results', () => {
    const f = fixture();
    const ancestor = f.element('ARTICLE');
    const paragraph = f.segment(prose, [box()], f.element('P', ancestor));
    expect(snapshotViewportPriorities([paragraph]).get(paragraph)?.visibleProse).toBe(true);
    expect(f.doc.defaultView.getComputedStyle).toHaveBeenCalledTimes(2);
    f.styles.set(ancestor, { opacity: '0' });
    expect(snapshotViewportPriorities([paragraph]).get(paragraph)?.tier).toBe(4);
    expect(f.doc.defaultView.getComputedStyle).toHaveBeenCalledTimes(4);
    f.styles.set(ancestor, { opacity: '1' });
    expect(snapshotViewportPriorities([paragraph]).get(paragraph)?.visibleProse).toBe(true);
    expect(f.doc.defaultView.getComputedStyle).toHaveBeenCalledTimes(6);
  });

  it('uses each source document window and keeps their independent visibility results', () => {
    const first = fixture();
    const second = fixture();
    const firstAncestor = first.element('ARTICLE');
    const secondAncestor = second.element('ARTICLE');
    const firstParagraph = first.segment(prose, [box()], first.element('P', firstAncestor));
    const secondParagraph = second.segment(prose, [box()], second.element('P', secondAncestor));
    second.styles.set(secondAncestor, { opacity: '0' });
    const snapshot = snapshotViewportPriorities([firstParagraph, secondParagraph]);
    expect(snapshot.get(firstParagraph)?.visibleProse).toBe(true);
    expect(snapshot.get(secondParagraph)?.tier).toBe(4);
    expect(first.doc.defaultView.getComputedStyle.mock.calls.every(([element]) =>
      (element as HTMLElement).ownerDocument === (first.doc as unknown as Document))).toBe(true);
    expect(second.doc.defaultView.getComputedStyle.mock.calls.every(([element]) =>
      (element as HTMLElement).ownerDocument === (second.doc as unknown as Document))).toBe(true);
  });

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
