import { describe, expect, it } from 'vitest';
import { MAX_PAGE_SEGMENTS, isTranslatablePageText, selectPageTranslationRoot, splitPageText, collectPageSegments, segmentIsCurrent } from '../../src/page/segments';
import { MAX_TEXT_LENGTH } from '../../src/shared/contracts';
import { JSDOM } from 'jsdom';
import type { LanguagePair } from '../../src/shared/languages';

describe('language-aware asynchronous segment validity', () => {
  it('retains the collected Chinese-to-English policy when validating a later result', () => {
    const dom = new JSDOM('<!doctype html><html lang="zh-CN"><body><article><p>图书馆每天早晨开放，欢迎读者前来阅读。</p></article></body></html>');
    try {
      const article = dom.window.document.querySelector('article')!;
      const pair: LanguagePair = { sourceLanguage: 'zh-Hans', targetLanguage: 'en' };
      expect(collectPageSegments(article)).toHaveLength(0);
      const segments = collectPageSegments(article, pair);
      expect(segments).toHaveLength(1);
      expect(segmentIsCurrent(segments[0]!)).toBe(true);
      pair.targetLanguage = 'zh-Hans';
      expect(segmentIsCurrent(segments[0]!)).toBe(true);
      segments[0]!.nodes[0]!.data += '原文已发生变化。';
      expect(segmentIsCurrent(segments[0]!)).toBe(false);
    } finally { dom.window.close(); }
  });

  it('still rejects hidden or changed non-Latin passages instead of relaxing DOM safety', () => {
    const dom = new JSDOM('<!doctype html><html lang="ja"><body><article><p>情報処理学会</p></article></body></html>');
    try {
      const article = dom.window.document.querySelector('article')!;
      const segment = collectPageSegments(article, { sourceLanguage: 'ja', targetLanguage: 'zh-Hans' })[0]!;
      expect(segmentIsCurrent(segment)).toBe(true);
      segment.container.hidden = true;
      expect(segmentIsCurrent(segment)).toBe(false);
    } finally { dom.window.close(); }
  });
});

describe('bounded page segment collection', () => {
  it('stops traversing after one overflow segment while preserving whole paragraphs', () => {
    const dom = new JSDOM('<!doctype html><html lang="en"><body><article></article></body></html>');
    try {
      const article = dom.window.document.querySelector('article')!;
      for (let index = 0; index < MAX_PAGE_SEGMENTS + 10; index++) {
        const paragraph = dom.window.document.createElement('p');
        paragraph.textContent = index === MAX_PAGE_SEGMENTS ? 'whole paragraph '.repeat(2_000) : `Paragraph number ${index} is complete.`;
        article.append(paragraph);
      }
      const expected = article.children[MAX_PAGE_SEGMENTS]!.textContent;
      const styleOf = dom.window.getComputedStyle.bind(dom.window);
      const visited = new Set<Element>();
      dom.window.getComputedStyle = element => { visited.add(element); return styleOf(element); };
      const segments = collectPageSegments(article);
      expect(segments).toHaveLength(MAX_PAGE_SEGMENTS + 1);
      expect(segments.at(-1)!.text).toBe(expected!.trim());
      expect(visited.has(article.children[MAX_PAGE_SEGMENTS + 1]!)).toBe(false);
    } finally { dom.window.close(); }
  });

  it('keeps all paragraphs on an ordinary thousand-paragraph page', () => {
    const dom = new JSDOM('<!doctype html><html lang="en"><body><article></article></body></html>');
    try {
      const article = dom.window.document.querySelector('article')!;
      for (let index = 0; index < 1_000; index++) {
        const paragraph = dom.window.document.createElement('p'); paragraph.textContent = `Complete paragraph number ${index}.`;
        article.append(paragraph);
      }
      const segments = collectPageSegments(article);
      expect(segments).toHaveLength(1_000);
      expect(segments.at(-1)!.text).toBe('Complete paragraph number 999.');
    } finally { dom.window.close(); }
  });
});

function pageFixture() {
  const elements: HTMLElement[] = [];
  const styles = new WeakMap<Element, Partial<CSSStyleDeclaration>>();
  const add = (tag: string, parent: HTMLElement | null = null, attributes: Record<string, string> = {}, style: Partial<CSSStyleDeclaration> = {}) => {
    const element = {
      tagName: tag.toUpperCase(), parentElement: parent,
      hasAttribute: (name: string) => name in attributes,
      getAttribute: (name: string) => attributes[name] ?? null,
      classList: { contains: (name: string) => (attributes.class ?? '').split(' ').includes(name) },
      matches: (selector: string) => Object.keys(attributes).some(name => selector.includes(`[${name}]`)),
    } as unknown as HTMLElement;
    styles.set(element, { display: 'block', visibility: 'visible', ...style }); elements.push(element);
    return element;
  };
  const body = add('body');
  const page = { body, querySelectorAll: (tag: string) => elements.filter(element => element.tagName.toLowerCase() === tag),
    defaultView: { getComputedStyle: (element: Element) => styles.get(element) },
  } as unknown as Document;
  return { page, body, add };
}

describe('page translation root', () => {
  it('prefers a unique visible article inside main over navigation and footer', () => {
    const { page, body, add } = pageFixture();
    add('nav', body); const main = add('main', body); const article = add('article', main); add('footer', body);
    expect(selectPageTranslationRoot(page)).toBe(article);
  });

  it('ignores hidden ancestors and editable, opt-out, and extension-owned candidates', () => {
    const { page, body, add } = pageFixture();
    const main = add('main', body);
    add('article', add('section', main, {}, { display: 'none' }));
    add('article', main, { contenteditable: 'true' });
    add('article', main, { translate: 'no' });
    add('article', main, { 'data-near-page-translation': '' });
    add('article', main, { hidden: '' });
    add('article', main, { 'aria-hidden': 'true' });
    expect(selectPageTranslationRoot(page)).toBe(main);
  });

  it('uses the unique main when articles are ambiguous, then falls back to body', () => {
    const { page, body, add } = pageFixture();
    const main = add('main', body); add('article', main); add('article', main);
    expect(selectPageTranslationRoot(page)).toBe(main);
    add('main', body);
    expect(selectPageTranslationRoot(page)).toBe(body);
  });

  it('applies the same preference when a dynamic page gains its article later', () => {
    const { page, body, add } = pageFixture();
    expect(selectPageTranslationRoot(page)).toBe(body);
    const main = add('main', body); expect(selectPageTranslationRoot(page)).toBe(main);
    const article = add('article', main); expect(selectPageTranslationRoot(page)).toBe(article);
  });
});

describe('page translation text policy', () => {
  it('selects English prose and titles while avoiding Chinese copies and bare URLs', () => {
    expect(isTranslatablePageText('Abstract')).toBe(true);
    expect(isTranslatablePageText('Go at Google: Language Design in the Service of Software Engineering')).toBe(true);
    expect(isTranslatablePageText('Go 编程语言是为提高软件开发的效率而设计的。')).toBe(false);
    expect(isTranslatablePageText('这里介绍 DeepSeek 模型的配置与使用方法。')).toBe(false);
    expect(isTranslatablePageText('https://go.dev/doc/')).toBe(false);
    expect(isTranslatablePageText('123 + 456')).toBe(false);
  });

  it('returns ordinary paragraphs as a single complete request', () => {
    expect(splitPageText('Hello, world.')).toEqual(['Hello, world.']);
    expect(splitPageText('')).toEqual([]);
    expect(splitPageText('a'.repeat(MAX_TEXT_LENGTH))).toEqual(['a'.repeat(MAX_TEXT_LENGTH)]);
  });

  it('prefers sentence boundaries and keeps all whitespace and punctuation', () => {
    const first = 'a'.repeat(7_000) + '.\n\n';
    const text = first + 'b'.repeat(7_000) + '! Next sentence.';
    const chunks = splitPageText(text);
    expect(chunks[0]).toBe(first);
    expect(chunks.join('')).toBe(text);
    expect(chunks.every(chunk => chunk.length <= MAX_TEXT_LENGTH)).toBe(true);
  });

  it('uses whitespace then a hard boundary for very long unbroken prose', () => {
    const text = ('word '.repeat(5_000)) + 'x'.repeat(25_000);
    const chunks = splitPageText(text);
    expect(chunks.join('')).toBe(text);
    expect(chunks.every(chunk => chunk.length > 0 && chunk.length <= MAX_TEXT_LENGTH)).toBe(true);
    expect(chunks[0]?.endsWith(' ')).toBe(true);
  });

  it('does not split a surrogate pair at the hard limit', () => {
    const text = 'a'.repeat(MAX_TEXT_LENGTH - 1) + '😀' + 'b'.repeat(MAX_TEXT_LENGTH);
    const chunks = splitPageText(text);
    expect(chunks[0]?.length).toBe(MAX_TEXT_LENGTH - 1);
    expect(chunks[1]?.startsWith('😀')).toBe(true);
    expect(chunks.join('')).toBe(text);
  });
});
