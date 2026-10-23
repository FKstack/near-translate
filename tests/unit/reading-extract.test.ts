import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { describe, expect, it, vi } from 'vitest';
import { extractReadingArticle } from '../../src/reading/extract';

const paragraph = 'A reader should preserve the complete article, including technical explanations, examples, '
  + 'and useful links. This paragraph supplies enough meaningful prose to distinguish the article from navigation. ';

function fixture(body: string, head = '') {
  return new JSDOM(`<!doctype html><html lang="en"><head><title>Example article</title>${head}</head><body>${body}</body></html>`, {
    url: 'https://example.test/articles/reader',
  }).window.document;
}

describe('local reading article extraction', () => {
  it('extracts metadata, headings and stable references without moving or modifying source nodes', () => {
    const page = fixture(`<nav><a href="/">Navigation</a></nav><main><article>
      <h1>Example article</h1><p id="opening">${paragraph.repeat(3)}</p>
      <h2 id="details">Implementation details</h2><p>${paragraph.repeat(2)}</p>
      <h3>Ownership</h3><p>${paragraph}</p></article></main>`,
    '<meta name="author" content="A. Reader"><meta property="og:site_name" content="Example Journal">');
    const before = page.documentElement.outerHTML;
    const original = page.querySelector('#opening')!;
    const article = extractReadingArticle(page);
    expect(article.title).toBe('Example article');
    expect(article.byline).toBe('A. Reader');
    expect(article.siteName).toBe('Example Journal');
    expect(article.lang).toBe('en');
    expect(article.strategy).toBe('readability');
    expect(article.content.ownerDocument).toBe(page);
    expect(article.content.isConnected).toBe(false);
    expect(article.outline.map(item => [item.text, item.level])).toEqual([
      ['Implementation details', 2], ['Ownership', 3],
    ]);
    expect(article.outline.every(item => article.content.querySelector(`#${item.id}`))).toBe(true);
    const mapped = [...article.content.querySelectorAll('[data-near-reader-source]')]
      .find(element => article.sourceMap.get(element.getAttribute('data-near-reader-source')!) === original);
    expect(mapped?.textContent).toContain(paragraph.trim());
    expect(article.wordCount).toBeGreaterThan(100);
    expect(article.readingMinutes).toBeGreaterThanOrEqual(1);
    expect(article.truncated).toBe(false);
    expect(page.documentElement.outerHTML).toBe(before);
    expect(page.querySelector('#opening')).toBe(original);
  });

  it('uses a strict output allowlist for scripts, events, unsafe URLs and foreign markup', () => {
    const page = fixture(`<article><h1>Example article</h1><p>${paragraph.repeat(4)}</p>
      <p onclick="alert(1)" style="background:url(https://evil.test/x)" class="evil" data-evil="1">
        <a href="javascript:alert(1)" onmouseover="alert(1)">Unsafe link</a>
        <a href="data:text/html,hello">Unsafe data</a><a href="file:///etc/passwd">Local file</a>
        <a href="https://safe.test/path" ping="https://evil.test/ping">Safe link</a>
        <img src="javascript:alert(1)" onerror="alert(1)"><img src="data:image/svg+xml,bad">
        <script>window.readerInjected=true</script><iframe src="https://evil.test/frame"></iframe>
        <form><p>Private form content</p></form><svg><foreignObject>Foreign content</foreignObject></svg>
      </p><p>${paragraph.repeat(3)}</p></article>`);
    const article = extractReadingArticle(page);
    expect(article.content.querySelector('script,style,iframe,form,svg,object,embed,link')).toBe(null);
    expect(article.content.textContent).not.toContain('Private form content');
    expect(article.content.textContent).not.toContain('Foreign content');
    expect(article.content.querySelector('[onclick],[onerror],[onmouseover],[style],[ping],[data-evil],.evil')).toBe(null);
    const anchors = [...article.content.querySelectorAll('a')];
    for (const label of ['Unsafe link', 'Unsafe data', 'Local file']) {
      expect(anchors.find(anchor => anchor.textContent === label)?.hasAttribute('href')).toBe(false);
    }
    const safe = anchors.find(anchor => anchor.textContent === 'Safe link');
    expect(safe?.href).toBe('https://safe.test/path');
    expect(safe?.rel).toBe('noopener noreferrer');
    expect(safe?.target).toBe('_blank');
    expect(article.content.querySelector('img')).toBe(null);
  });

  it('retains code whitespace, lists, data tables and safe images with deferred loading', () => {
    const code = 'function add(a, b) {\n  return a + b;\n}\n';
    const page = fixture(`<main><article><h1>Example article</h1><p>${paragraph.repeat(3)}</p>
      <pre><code>${code}</code></pre><ul><li>First useful explanation</li><li>Second useful explanation</li></ul>
      <table><caption>Measured results</caption><thead><tr><th scope="col">Test</th><th scope="col">Time</th></tr></thead>
        <tbody><tr><td rowspan="2">Reader</td><td>15 ms</td></tr><tr><td>16 ms</td></tr></tbody></table>
      <figure><img src="../images/diagram.png" alt="Reader diagram" width="600" onload="alert(1)">
        <figcaption>A useful diagram.</figcaption></figure><p>${paragraph.repeat(2)}</p></article></main>`);
    const network = vi.spyOn(globalThis, 'fetch');
    try {
      const article = extractReadingArticle(page);
      expect(article.content.querySelector('pre code')?.textContent).toBe(code);
      expect(article.content.querySelectorAll('li')).toHaveLength(2);
      expect(article.content.querySelector('table caption')?.textContent).toBe('Measured results');
      expect(article.content.querySelector('th')?.getAttribute('scope')).toBe('col');
      expect(article.content.querySelector('td')?.getAttribute('rowspan')).toBe('2');
      const image = article.content.querySelector('img')!;
      expect(image.getAttribute('data-near-reader-image-src')).toBe('https://example.test/images/diagram.png');
      expect(image.hasAttribute('src')).toBe(false);
      expect(image.hasAttribute('srcset')).toBe(false);
      expect(image.getAttribute('loading')).toBe('lazy');
      expect(image.getAttribute('referrerpolicy')).toBe('no-referrer');
      expect(image.getAttribute('alt')).toBe('Reader diagram');
      expect(image.getAttribute('onload')).toBe(null);
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });

  it('preserves SVG and raster article images without depending on code or table fallback', () => {
    const page = fixture(`<article><h1>Example article</h1><p>${paragraph.repeat(3)}</p>
      <figure><img src="http://127.0.0.1:4173/reading-diagram.svg" alt="A local reading diagram" width="640" height="160">
        <figcaption>A local technical illustration.</figcaption></figure>
      <figure><img src="/photo.webp" alt="Article photograph"></figure><p>${paragraph.repeat(2)}</p></article>`);
    const before = page.body.innerHTML;
    const inertDocuments: Document[] = [];
    const create = page.implementation.createHTMLDocument.bind(page.implementation);
    const creation = vi.spyOn(page.implementation, 'createHTMLDocument').mockImplementation(title => {
      const copy = create(title); inertDocuments.push(copy); return copy;
    });
    try {
      const article = extractReadingArticle(page);
      expect(article.content.querySelector('pre,table')).toBe(null);
      expect([...article.content.querySelectorAll('img')].map(image => image.getAttribute('data-near-reader-image-src')))
        .toEqual(['http://127.0.0.1:4173/reading-diagram.svg', 'https://example.test/photo.webp']);
      expect(article.content.querySelector('img')?.alt).toBe('A local reading diagram');
      expect(article.content.querySelector('figcaption')?.textContent).toBe('A local technical illustration.');
      expect(article.content.querySelector('img[src],img[srcset]')).toBe(null);
      expect(inertDocuments).toHaveLength(1);
      expect(inertDocuments[0]!.defaultView).toBe(null);
      expect(page.body.innerHTML).toBe(before);
    } finally { creation.mockRestore(); }
  });

  it('lets Readability retain SVG news photographs without an article or main semantic fallback', () => {
    const page = fixture(`<div class="story-body"><h1>Example article</h1><p>${paragraph.repeat(4)}</p>
      <figure><img src="/news-diagram.svg" alt="News diagram"><figcaption>Explaining the news.</figcaption></figure>
      <p>${paragraph.repeat(3)}</p><img src="/news-photo.jpg" alt="News photograph"><p>${paragraph.repeat(2)}</p></div>`);
    const article = extractReadingArticle(page);
    expect(article.strategy).toBe('readability');
    expect([...article.content.querySelectorAll('img')].map(image => image.getAttribute('data-near-reader-image-src')))
      .toEqual(['https://example.test/news-diagram.svg', 'https://example.test/news-photo.jpg']);
    expect(article.content.querySelector('img[src],img[srcset]')).toBe(null);
  });

  it('uses the intact semantic article when Readability would discard a content image or caption', () => {
    const page = fixture(`<article><h1>Example article</h1><p>${paragraph.repeat(4)}</p>
      <figure class="comment"><img src="/article-diagram.svg" alt="Essential article diagram">
        <figcaption>Essential explanatory caption.</figcaption></figure><p>${paragraph.repeat(3)}</p></article>`);
    const article = extractReadingArticle(page);
    expect(article.strategy).toBe('semantic');
    expect(article.content.querySelector('img')?.getAttribute('data-near-reader-image-src'))
      .toBe('https://example.test/article-diagram.svg');
    expect(article.content.querySelector('figcaption')?.textContent).toBe('Essential explanatory caption.');
    expect(article.content.querySelector('img[src]')).toBe(null);
  });

  it('preserves a safe lazy SVG URL when the original src is a data placeholder', () => {
    const page = fixture(`<article><h1>Example article</h1><p>${paragraph.repeat(3)}</p>
      <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-src="/lazy-diagram.svg" alt="Lazy article diagram">
      <p>${paragraph.repeat(2)}</p></article>`);
    const article = extractReadingArticle(page);
    expect(article.content.querySelector('img')?.getAttribute('data-near-reader-image-src'))
      .toBe('https://example.test/lazy-diagram.svg');
    expect(article.content.querySelector('img[src]')).toBe(null);
  });

  it('resolves relative URLs against the page base and remaps local heading links', () => {
    const page = fixture(`<article><h1>Example article</h1><p>${paragraph.repeat(3)}
      <a href="#details">Jump to details</a><a href="../reference">Reference</a></p>
      <h2 id="details">Details</h2><p>${paragraph.repeat(2)}</p></article>`);
    const article = extractReadingArticle(page);
    const jump = [...article.content.querySelectorAll('a')].find(anchor => anchor.textContent === 'Jump to details')!;
    expect(jump.getAttribute('href')).toBe(`#${article.outline[0]!.id}`);
    expect(jump.hasAttribute('target')).toBe(false);
    expect([...article.content.querySelectorAll('a')].find(anchor => anchor.textContent === 'Reference')?.href)
      .toBe('https://example.test/reference');
  });

  it('excludes hidden drafts, editable content and already inserted extension UI/translations', () => {
    const page = fixture(`<main><article class="draft"><p>Hidden CSS draft. ${paragraph.repeat(5)}</p></article>
      <article hidden><p>Hidden attribute draft. ${paragraph.repeat(4)}</p></article>
      <article><h1>Example article</h1><p>${paragraph.repeat(3)}</p>
        <p aria-hidden="true">Aria hidden draft</p><div style="visibility:hidden"><p>Invisible draft</p></div>
        <div contenteditable="true"><p>Editable secret</p></div>
        <div data-near-page-translation>Already translated text</div>
        <near-page-translate>Extension control</near-page-translate>
        <div data-near-page-ui><p>Reader UI and duplicated article ${paragraph.repeat(4)}</p></div>
        <p>${paragraph.repeat(2)}</p></article></main>`, '<style>.draft{display:none}</style>');
    const article = extractReadingArticle(page);
    for (const removed of ['Hidden CSS draft', 'Hidden attribute draft', 'Aria hidden draft', 'Invisible draft',
      'Editable secret', 'Already translated text', 'Extension control', 'Reader UI and duplicated article']) {
      expect(article.content.textContent).not.toContain(removed);
    }
  });

  it('finds the real article in a complex main region and excludes surrounding navigation', () => {
    const page = fixture(`<header><nav>Home Products Documentation</nav></header><main>
      <aside><p>Related links ${paragraph.repeat(5)}</p></aside>
      <section><h1>Example article</h1><div><p>${paragraph.repeat(3)}</p></div>
        <h2>Architecture</h2><p>${paragraph.repeat(4)}</p></section>
      <footer><p>Site legal footer ${paragraph.repeat(3)}</p></footer></main>`);
    const article = extractReadingArticle(page);
    expect(article.content.textContent).toContain(paragraph.trim());
    expect(article.content.textContent).not.toContain('Related links');
    expect(article.content.textContent).not.toContain('Site legal footer');
    expect(article.outline.some(item => item.text === 'Architecture')).toBe(true);
  });

  it('falls back to one meaningful semantic region when the upstream parser rejects or fails', () => {
    const page = fixture(`<main><article><h1>Semantic article</h1><p>${paragraph.repeat(3)}</p>
      <h2>A complete section</h2><p>${paragraph.repeat(2)}</p></article></main>`);
    const parser = vi.spyOn(Readability.prototype, 'parse');
    try {
      for (const failed of [false, true]) {
        if (failed) parser.mockImplementation(() => { throw new Error('Upstream parse failure'); });
        else parser.mockReturnValue(null);
        const article = extractReadingArticle(page);
        expect(article.strategy).toBe('semantic');
        expect(article.title).toBe('Semantic article');
        expect(article.outline.map(item => item.text)).toEqual(['A complete section']);
        expect(article.content.textContent).toContain(paragraph.trim());
      }
    } finally { parser.mockRestore(); }
  });

  it('supports Chinese prose and estimates CJK reading time without requiring English words', () => {
    const chinese = '阅读模式应当保留完整的文章内容，并清除菜单、广告和隐藏草稿。正文提取在本地完成，只有主动翻译的内容才会发送到翻译服务。';
    const page = fixture(`<article><h1>中文阅读文章</h1><p>${chinese.repeat(5)}</p><h2>本地提取</h2><p>${chinese.repeat(3)}</p></article>`);
    page.documentElement.lang = 'zh-CN';
    page.title = '中文阅读文章';
    const article = extractReadingArticle(page);
    expect(article.title).toBe('中文阅读文章');
    expect(article.lang).toBe('zh-CN');
    expect(article.wordCount).toBeGreaterThan(300);
    expect(article.readingMinutes).toBeGreaterThanOrEqual(2);
    expect(article.content.textContent).toContain(chinese);
    expect([...article.content.querySelectorAll('h1,h2,h3,h4,h5,h6')]
      .filter(heading => heading.textContent?.trim() === article.title)).toHaveLength(0);
    expect(article.outline.map(item => item.text)).toEqual(['本地提取']);
  });

  it('removes a leading duplicated H2 title and short known byline before generating the outline', () => {
    const page = fixture(`<article><h2>Example article</h2><p>By Ada Reader</p>
      <p>${paragraph.repeat(4)}</p><h2>Implementation</h2><p>${paragraph.repeat(3)}</p></article>`,
    '<meta name="author" content="Ada Reader">');
    const before = page.body.innerHTML;
    const article = extractReadingArticle(page);
    expect(article.title).toBe('Example article');
    expect(article.byline).toBe('Ada Reader');
    expect(article.content.textContent).not.toContain('By Ada Reader');
    expect([...article.content.querySelectorAll('h1,h2')].some(heading => heading.textContent === article.title)).toBe(false);
    expect(article.outline.map(item => item.text)).toEqual(['Implementation']);
    expect(article.outline[0]!.id).toBe('near-reader-heading-1');
    expect(page.body.innerHTML).toBe(before);
  });

  it('retains later same-name chapters and ordinary prose beginning with an author name', () => {
    const authorSentence = `By Ada Reader, this article explains the design in full. ${paragraph.repeat(2)}`;
    const page = fixture(`<article><h1>Example article</h1><p>Ada Reader</p><p>${authorSentence}</p>
      <h2>Example article</h2><p>${paragraph.repeat(4)}</p><h2>Final chapter</h2><p>${paragraph.repeat(2)}</p></article>`,
    '<meta name="author" content="Ada Reader">');
    const article = extractReadingArticle(page);
    expect(article.byline).toBe('Ada Reader');
    expect(article.content.textContent).toContain(authorSentence.trim());
    expect([...article.content.querySelectorAll('h1,h2')].filter(heading => heading.textContent?.trim() === article.title)).toHaveLength(1);
    expect(article.outline.map(item => item.text)).toEqual(['Example article', 'Final chapter']);
    expect([...article.content.querySelectorAll('p')].some(node => node.textContent?.trim() === 'Ada Reader')).toBe(false);
  });

  it('does not remove a title-like chapter after preceding substantive media or prose', () => {
    const page = fixture(`<article><figure><img src="/opening.svg" alt="Opening illustration"></figure>
      <h2>Example article</h2><p>${paragraph.repeat(4)}</p><h2>Later section</h2><p>${paragraph.repeat(3)}</p></article>`);
    const parser = vi.spyOn(Readability.prototype, 'parse').mockReturnValue(null);
    try {
      const article = extractReadingArticle(page);
      expect(article.content.querySelector('img')?.getAttribute('data-near-reader-image-src')).toBe('https://example.test/opening.svg');
      expect([...article.content.querySelectorAll('h1,h2')].some(heading => heading.textContent?.trim() === article.title)).toBe(true);
      expect(article.outline.map(item => item.text)).toContain('Example article');
    } finally { parser.mockRestore(); }
  });

  it('prefers the semantic article title over a browser title with a site suffix', () => {
    const page = fixture(`<article><h1>A technical article</h1><p>${paragraph.repeat(3)}</p>
      <h2 id="details">Details<a href="#details">¶</a></h2><p>${paragraph.repeat(3)}</p></article>`);
    page.title = 'A technical article - Example Technical Journal';
    const before = page.body.innerHTML;
    const article = extractReadingArticle(page);
    expect(article.title).toBe('A technical article');
    expect(article.content.textContent).not.toContain('A technical article');
    expect(article.outline.map(item => item.text)).toEqual(['Details']);
    expect(page.body.innerHTML).toBe(before);
  });

  it('removes only decorative self-permalinks from headings and preserves meaningful symbols and links', () => {
    const page = fixture(`<article><h1>Example article</h1><p>${paragraph.repeat(3)}</p>
      <h2 id="one">First section <a href="#one">¶</a></h2><p>${paragraph}</p>
      <h2 id="two">Second section <a href="#two">#</a></h2><p>${paragraph}</p>
      <h2 id="three">Third section <a href="#one">¶</a> <a href="#three">Meaningful self-link</a></h2>
      <p>Preserve <code>#</code> and <code>¶</code> in real prose. <a href="#one">¶</a> ${paragraph}</p>
      <pre><code># A real code comment\nprint("¶")</code></pre></article>`);
    const before = page.body.innerHTML;
    const article = extractReadingArticle(page);
    expect(article.outline[0]!.text).toBe('First section');
    expect(article.outline[1]!.text).toBe('Second section');
    expect(article.outline[2]!.text).toBe('Third section ¶ Meaningful self-link');
    expect(article.content.querySelectorAll('h2 a')).toHaveLength(2);
    expect(article.content.querySelector('pre code')?.textContent).toBe('# A real code comment\nprint("¶")');
    expect([...article.content.querySelectorAll('p code')].map(code => code.textContent)).toEqual(['#', '¶']);
    expect(article.content.querySelector('p a')?.textContent).toBe('¶');
    expect(page.body.innerHTML).toBe(before);
  });

  it('removes an explicitly labelled hash-link contents table while preserving data tables', () => {
    const links = '<a href="#one">First</a><a href="#two">Second</a><a href="#three">Third</a>';
    const page = fixture(`<article><h1>Example article</h1>
      <table><tbody><tr><th colspan="2">Table of Contents</th></tr><tr><td><dl><dt>${links}</dt></dl></td><td></td></tr></tbody></table>
      <table><caption>Contents</caption><tbody><tr><td>${links}</td></tr></tbody></table>
      <p>${paragraph.repeat(3)}</p><h2 id="one">First</h2><p>${paragraph}</p>
      <h2 id="two">Second</h2><p>${paragraph}</p><h2 id="three">Third</h2><p>${paragraph}</p>
      <table><caption>Measured data</caption><tbody><tr><td>${links}</td></tr></tbody></table>
      <table><caption>Contents</caption><tbody><tr><th>Item</th><th>Bytes</th></tr><tr><td>${links}</td><td>1024</td></tr></tbody></table>
      <table><caption>Contents</caption><tbody><tr><td><a href="#one">First</a><a href="#two">Second</a></td></tr></tbody></table>
      <pre><code># Preserve code</code></pre><img src="/diagram.svg" alt="Preserved figure"></article>`);
    const before = page.body.innerHTML;
    const article = extractReadingArticle(page);
    expect(article.content.querySelectorAll('table')).toHaveLength(3);
    expect([...article.content.querySelectorAll('caption')].map(caption => caption.textContent)).toEqual(['Measured data', 'Contents', 'Contents']);
    expect(article.content.querySelector('pre code')?.textContent).toBe('# Preserve code');
    expect(article.content.querySelector('img')?.getAttribute('data-near-reader-image-src')).toBe('https://example.test/diagram.svg');
    expect(article.outline.map(item => item.text)).toEqual(['First', 'Second', 'Third']);
    expect(page.body.innerHTML).toBe(before);
  });

  it('removes only an explicitly named heading with an adjacent all-hash navigation list', () => {
    const links = '<li><a href="#one">First</a></li><li><a href="#two">Second</a></li><li><a href="#three">Third</a></li>';
    const page = fixture(`<article><h1>Example article</h1><h2>目录</h2><ul>${links}</ul>
      <p>${paragraph.repeat(3)}</p><h2 id="one">First</h2><p>${paragraph}</p>
      <h2 id="two">Second</h2><p>${paragraph}</p><h2 id="three">Third</h2><p>${paragraph}</p>
      <h2>Contents</h2><p>This paragraph makes the later list ordinary article content.</p><ul>${links}</ul>
      <h2>Table of Contents</h2><ol><li>A meaningful explanation</li><li>Another explanation</li><li>A final explanation</li></ol>
      <p>${paragraph.repeat(2)}</p></article>`);
    const article = extractReadingArticle(page);
    expect(article.content.querySelectorAll('ul')).toHaveLength(1);
    expect(article.content.querySelectorAll('ol')).toHaveLength(1);
    expect(article.outline.map(item => item.text)).toEqual(['First', 'Second', 'Third', 'Contents', 'Table of Contents']);
    expect(article.content.textContent).toContain('A meaningful explanation');
  });

  it('omits standalone URL tokens from author metadata without changing author names or article links', () => {
    const page = fixture(`<article><h1>Example article</h1><p>${paragraph.repeat(4)}</p>
      <p>Visit <a href="https://publisher.test">https://publisher.test</a> for the references.</p></article>`,
    '<meta name="author" content="Ada Reader Example, Inc. https://publisher.test">');
    const article = extractReadingArticle(page);
    expect(article.byline).toBe('Ada Reader Example, Inc.');
    expect(article.content.querySelector('a')?.href).toBe('https://publisher.test/');
    expect(article.content.textContent).toContain('https://publisher.test');
  });

  it('preserves an entire long technical article and all 28 code samples', () => {
    const sections = Array.from({ length: 28 }, (_, index) => `<h2>Section ${index + 1}</h2>
      <p>${paragraph.repeat(10)}</p><pre><code>sample_${index}\n  preserve indentation\n</code></pre>`).join('');
    const page = fixture(`<main><article><h1>Example article</h1>${sections}<p>ARTICLE_END_MARKER ${paragraph}</p></article></main>`);
    const before = page.body.innerHTML;
    const article = extractReadingArticle(page);
    expect(article.content.textContent!.length).toBeGreaterThan(53_000);
    expect(article.content.textContent).toContain('ARTICLE_END_MARKER');
    expect(article.content.querySelectorAll('pre')).toHaveLength(28);
    expect(article.outline).toHaveLength(28);
    expect(article.truncated).toBe(false);
    expect(page.body.innerHTML).toBe(before);
  });

  it('keeps math as inert text without foreign namespaces or executable annotations', () => {
    const page = fixture(`<article><h1>Example article</h1><p>${paragraph.repeat(3)}</p>
      <p>The formula is <math><semantics><mrow><mi>x</mi><mo>+</mo><mn>1</mn></mrow>
        <annotation encoding="application/x-tex">x + 1</annotation></semantics></math>.</p>
      <p>${paragraph.repeat(2)}</p></article>`);
    const article = extractReadingArticle(page);
    expect(article.content.querySelector('math,annotation')).toBe(null);
    expect(article.content.querySelector('.near-reader-math')?.textContent).toBe('x + 1');
  });

  it('fails clearly for navigation-only, empty or link directory pages', () => {
    for (const body of ['', '<nav><p>Home About Products Contact</p></nav>',
      `<main>${Array.from({ length: 80 }, (_, index) => `<a href="/${index}">Navigation destination ${index}</a>`).join('')}</main>`,
      '<article><p>Too short.</p></article>']) {
      expect(() => extractReadingArticle(fixture(body))).toThrow(/没有找到/);
    }
  });

  it('rejects unsupported or credential-bearing source URLs', () => {
    const page = fixture(`<article><p>${paragraph.repeat(4)}</p></article>`);
    for (const url of ['file:///tmp/article.html', 'javascript:alert(1)', 'data:text/html,article', 'https://user:password@example.test/']) {
      expect(() => extractReadingArticle(page, url)).toThrow(/HTTP/);
    }
  });

  it('does not extract a body hidden by an ancestor', () => {
    const page = fixture(`<article><p>${paragraph.repeat(4)}</p></article>`);
    page.documentElement.style.display = 'none';
    expect(() => extractReadingArticle(page)).toThrow(/可见/);
  });

  it('bounds pathological document depth and text without silently truncating an article', () => {
    const deep = fixture(`${'<div>'.repeat(170)}<article><p>${paragraph.repeat(4)}</p></article>${'</div>'.repeat(170)}`);
    expect(() => extractReadingArticle(deep)).toThrow(/复杂/);
    const huge = fixture(`<article><p>${'x'.repeat(4_000_001)}</p></article>`);
    expect(() => extractReadingArticle(huge)).toThrow(/上限/);
  });
});
