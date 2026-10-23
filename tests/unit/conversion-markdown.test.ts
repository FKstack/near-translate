import { JSDOM, requestInterceptor } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildPrintDocument, renderDocument } from '../../src/conversion/markdown';

const png = 'data:image/png;base64,iVBORw0KGgo=';
const otherPng = 'data:image/png;base64,YWJj';
const blob = 'blob:https://extension.test/97bdca5f-e84b-4b37-83a5-f2bd8f2512ca';
const request = vi.fn(() => new Response(null, { status: 204 }));
const browser = new JSDOM('', {
  url: 'https://extension.test/', resources: { interceptors: [requestInterceptor(request)] },
});

beforeAll(() => vi.stubGlobal('DOMParser', browser.window.DOMParser));
afterAll(() => { vi.unstubAllGlobals(); browser.window.close(); });

function fragment(html: string): DocumentFragment {
  const template = browser.window.document.createElement('template');
  template.innerHTML = html;
  return template.content;
}

describe('local document rendering', () => {
  it('renders GFM tables, checked tasks, headings and fenced code with preserved escaping', async () => {
    const source = '# 中文说明\n\n[跳到说明](#中文说明)\n\n'
      + '| Name | Value |\n| :--- | ---: |\n| 近译 | `<tag>` |\n\n'
      + '- [x] 已完成\n- [ ] 待处理\n\n```ts\nconst html = "<script>alert(1)</script>";\n```';
    const result = await renderDocument(source, 'markdown');
    const content = fragment(result.html);
    expect(content.querySelector('h1')?.textContent).toBe('中文说明');
    expect(content.querySelector('h1')?.id).toBe('near-document-中文说明');
    expect(content.querySelector('a')?.getAttribute('href')).toBe('#near-document-中文说明');
    expect(content.querySelectorAll('table thead th')).toHaveLength(2);
    expect(content.querySelector('th:last-child')?.className).toBe('conversion-align-right');
    expect(content.querySelector('td code')?.textContent).toBe('<tag>');
    const tasks = [...content.querySelectorAll('input')];
    expect(tasks).toHaveLength(2);
    expect(tasks.every(task => task.disabled && task.type === 'checkbox')).toBe(true);
    expect(tasks.map(task => task.checked)).toEqual([true, false]);
    expect(content.querySelector('pre code')?.textContent).toBe('const html = "<script>alert(1)</script>";\n');
    expect(content.querySelector('pre code')?.className).toBe('language-ts');
    expect(content.querySelector('script')).toBe(null);
    expect(result.warnings).toEqual([]);
  });

  it('keeps text literal, including blank lines, markup, quotes and ampersands', async () => {
    const source = '<img src=x onerror="bad()"> & \'quote\'\n\n第二段\n  缩进';
    const result = await renderDocument(source, 'text');
    const content = fragment(result.html);
    expect(content.querySelector('pre')?.textContent).toBe(source);
    expect(content.querySelector('pre')?.className).toBe('conversion-plain-text');
    expect(content.querySelector('img')).toBe(null);
    expect(result.warnings).toEqual([]);
  });

  it('drops executable elements, foreign namespaces, attributes and form controls', async () => {
    const result = await renderDocument(`<div style="background:url(https://bad.test/css)" onclick="bad()" class="injected">
      <script>secretScript()</script><style>@import 'https://bad.test/style';</style>
      <iframe src="https://bad.test/frame"></iframe><object data="https://bad.test/object"></object>
      <svg><foreignObject><p>foreign payload</p></foreignObject></svg><math><mi>bad math</mi></math>
      <template><img src="https://bad.test/template"></template><a href="https://safe.test/a?x=1&amp;y=2" ping="https://bad.test/ping" target="bad" download="steal">阅读</a>
      <form action="https://bad.test/form"><input name="password" value="secret"><textarea>private input</textarea></form>
      <p id="__proto__" data-test="bad">正文 <b>加粗</b></p></div>`, 'html');
    const content = fragment(result.html);
    expect(content.querySelector('script,style,iframe,object,svg,math,template,form,textarea')).toBe(null);
    expect(content.querySelector('[onclick],[style],[ping],[target="bad"],[download],[name],[value],[data-test],.injected')).toBe(null);
    expect(content.querySelector('input')).toBe(null);
    expect(content.textContent).not.toMatch(/secretScript|foreign payload|bad math|private input/);
    expect(content.textContent).toContain('正文 加粗');
    const link = content.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('https://safe.test/a?x=1&y=2');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(content.querySelector('p')?.id).toBe('near-document-__proto__');
    expect(result.warnings.join(' ')).toContain('脚本');
  });

  it('allows only absolute http, https, mailto and document anchors', async () => {
    const allowed = ['https://example.test/中文', 'http://localhost:8080/', 'mailto:reader@example.test', '#section'];
    const blocked = [
      'javascript:alert(1)', 'jav&#x61;script:bad()', 'java&#10;script:bad()', 'data:text/html,hi',
      'file:///C:/private.txt', 'vbscript:bad()', '//example.test/relative', './local.html',
    ];
    const html = [...allowed, ...blocked].map((href, index) => `<a href="${href}">${index}</a>`).join('');
    const content = fragment((await renderDocument(html, 'html')).html);
    const links = [...content.querySelectorAll('a')];
    expect(links.slice(0, allowed.length).every(link => link.hasAttribute('href'))).toBe(true);
    expect(links.slice(allowed.length).every(link => !link.hasAttribute('href'))).toBe(true);
    expect(links[0]?.getAttribute('href')).toBe('https://example.test/%E4%B8%AD%E6%96%87');
    expect(links[3]?.getAttribute('href')).toBe('#near-document-section');
    expect(links.slice(0, 3).every(link => link.getAttribute('target') === '_blank')).toBe(true);
    expect(links[3]?.hasAttribute('target')).toBe(false);
  });

  it('does not load remote images or embed raw source data/SVG/blob URLs', async () => {
    request.mockClear();
    const parser = vi.spyOn(browser.window.DOMParser.prototype, 'parseFromString');
    try {
      const result = await renderDocument(`<img src="https://bad.test/remote.png" alt="远程图">
        <img src="${png}" alt="原始 data 图"><img src="${blob}" alt="原始 blob 图">
        <img src="data:image/svg+xml,%3Csvg%20onload=bad()%3E" alt="SVG 图">
        <picture><source srcset="https://bad.test/alternate.png"><img src="missing.png" alt="本地图"></picture>`, 'html');
      const content = fragment(result.html);
      expect(content.querySelector('img,source')).toBe(null);
      expect(content.querySelectorAll('.conversion-missing-image')).toHaveLength(5);
      expect(result.warnings.join(' ')).toContain('不会自动加载网络图片');
      expect(request).not.toHaveBeenCalled();
      // Only a fixed blank document is passed directly to DOMParser; source
      // markup is kept in template content so resource loading remains inert.
      expect(parser.mock.calls.every(([html]) => !html.includes('bad.test'))).toBe(true);
    } finally { parser.mockRestore(); }
  });

  it('resolves attachments by decoded relative path or a unique basename', async () => {
    const result = await renderDocument('![图一](./images/%E7%A4%BA%E6%84%8F%20%E5%9B%BE.png)\n\n![图二](another.png?version=1)\n\n![图三](hash%231.png)', 'markdown', {
      images: [
        { name: 'images/示意 图.png', url: png },
        { name: 'assets/another.png', url: blob },
        { name: 'hash#1.png', url: png },
      ],
    });
    const content = fragment(result.html);
    expect([...content.querySelectorAll('img')].map(image => image.getAttribute('src'))).toEqual([png, blob, png]);
    expect([...content.querySelectorAll('img')].map(image => image.alt)).toEqual(['图一', '图二', '图三']);
    expect(result.warnings).toEqual([]);
  });

  it('does not replace network images merely because a local basename happens to match', async () => {
    const result = await renderDocument('![远程图](https://example.test/photo.png)', 'markdown', {
      images: [{ name: 'photo.png', url: png }],
    });
    expect(fragment(result.html).querySelector('img')).toBe(null);
    expect(result.warnings).toHaveLength(1);
  });

  it('uses only exact caller-provided safe image URLs and removes image side channels', async () => {
    const result = await renderDocument(`<img src="${blob}" srcset="https://bad.test/high.png 2x" onerror="bad()" style="width:900px" alt="本地附件">`, 'html', {
      images: [{ name: 'photo.png', url: blob }],
    });
    const image = fragment(result.html).querySelector('img')!;
    expect(image.getAttribute('src')).toBe(blob);
    expect(image.alt).toBe('本地附件');
    expect(image.hasAttribute('onerror')).toBe(false);
    expect(image.hasAttribute('srcset')).toBe(false);
    expect(image.hasAttribute('style')).toBe(false);
  });

  it('rejects unsafe attachment URLs and does not silently choose duplicate basenames', async () => {
    const result = await renderDocument('![歧义](same.png)\n\n![精确](left/same.png)\n\n![SVG](vector.svg)\n\n![外部](remote.png)', 'markdown', {
      images: [
        { name: 'left/same.png', url: png }, { name: 'right/same.png', url: otherPng },
        { name: 'vector.svg', url: 'data:image/svg+xml;base64,PHN2Zz4=' },
        { name: 'remote.png', url: 'https://bad.test/remote.png' },
      ],
    });
    const content = fragment(result.html);
    expect(content.querySelectorAll('img')).toHaveLength(1);
    expect(content.querySelector('img')?.alt).toBe('精确');
    expect(content.querySelectorAll('.conversion-missing-image')).toHaveLength(3);
  });

  it('escapes missing-image labels rather than interpreting alt text as HTML', async () => {
    const result = await renderDocument('<img src="missing.png" alt="&lt;script&gt;bad()&lt;/script&gt;">', 'html');
    const content = fragment(result.html);
    expect(content.querySelector('script')).toBe(null);
    expect(content.textContent).toBe('[图片未包含：<script>bad()</script>]');
    expect(result.warnings).toHaveLength(1);
  });

  it('preserves table structure while bounding cell spans and keeping generated ids unique', async () => {
    const result = await renderDocument('<h2>说明</h2><h2>说明</h2><table><caption>数据</caption><thead><tr><th scope="col" colspan="999">列</th></tr></thead><tbody><tr><td rowspan="0" align="center">内容</td></tr></tbody></table>', 'html');
    const content = fragment(result.html);
    expect([...content.querySelectorAll('h2')].map(heading => heading.id)).toEqual(['near-document-说明', 'near-document-说明-2']);
    expect(content.querySelector('th')?.getAttribute('colspan')).toBe('100');
    expect(content.querySelector('th')?.getAttribute('scope')).toBe('col');
    expect(content.querySelector('td')?.getAttribute('rowspan')).toBe('1');
    expect(content.querySelector('td')?.className).toBe('conversion-align-center');
    expect(content.querySelector('caption')?.textContent).toBe('数据');
  });

  it('handles empty and malformed input without interpreting escaped text as nodes', async () => {
    expect(await renderDocument('', 'markdown')).toEqual({ html: '', warnings: [] });
    const result = await renderDocument('<p>unfinished &lt;img src=x&gt;<b>bold', 'html');
    const content = fragment(result.html);
    expect(content.querySelector('img')).toBe(null);
    expect(content.textContent).toBe('unfinished <img src=x>bold');
    expect(content.querySelector('b')?.textContent).toBe('bold');
    await expect(renderDocument('data', 'other' as 'html')).rejects.toThrow('不支持');
  });

  it('enforces the 5 MB limit by UTF-8 bytes as well as character count', async () => {
    await expect(renderDocument('x'.repeat(5 * 1024 * 1024 + 1), 'text')).rejects.toThrow('5 MB');
    await expect(renderDocument('中'.repeat(2 * 1024 * 1024), 'markdown')).rejects.toThrow('5 MB');
  });

  it('bounds repeated attachment expansion, text escaping and multibyte output before appending clones', async () => {
    vi.resetModules();
    vi.doMock('../../src/conversion/types', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../src/conversion/types')>();
      return { ...actual, LIMITS: { ...actual.LIMITS, maxOutputBytes: 16_384 } };
    });
    try {
      const { renderDocument: renderLimited, buildPrintDocument: printLimited } = await import('../../src/conversion/markdown');
      const largePng = `data:image/png;base64,${'A'.repeat(10_000)}`;
      const images = [{ name: 'same.png', url: largePng }];
      const single = await renderLimited('<img src="same.png" alt="单张">', 'html', { images });
      expect(new TextEncoder().encode(single.html).byteLength).toBeLessThan(16_384);
      expect(fragment(single.html).querySelectorAll('img')).toHaveLength(1);
      const attributes = vi.spyOn(browser.window.Element.prototype, 'setAttribute');
      try {
        await expect(renderLimited('<img src="same.png"><img src="same.png">', 'html', { images })).rejects.toThrow('转换结果过大');
        // The second URL is rejected before it is copied into another img.
        expect(attributes.mock.calls.filter(([name]) => name === 'src')).toHaveLength(1);
      } finally { attributes.mockRestore(); }
      await expect(renderLimited(`<p>${'中'.repeat(6_000)}</p>`, 'html')).rejects.toThrow('转换结果过大');
      await expect(renderLimited('&'.repeat(4_000), 'text')).rejects.toThrow('转换结果过大');
      await expect(renderLimited('中'.repeat(1_000), 'text')).resolves.toMatchObject({ warnings: [] });
      expect(() => printLimited('中'.repeat(6_000), {
        title: '输出', paper: 'A4', landscape: false, marginMm: 12, fontSize: 11,
      })).toThrow('转换结果过大');
    } finally {
      vi.doUnmock('../../src/conversion/types');
      vi.resetModules();
    }
  });
});

describe('passive print document', () => {
  it('uses selected paper, orientation, local fonts and wrapping/page-break rules', async () => {
    const rendered = await renderDocument('# 输出\n\n正文', 'markdown');
    const html = buildPrintDocument(rendered.html, {
      title: '输出', paper: 'Letter', landscape: true, marginMm: 12, fontSize: 13,
    });
    const page = new JSDOM(html).window.document;
    expect(page.title).toBe('输出');
    expect(page.querySelector('main h1')?.textContent).toBe('输出');
    expect(html).toContain('size: Letter landscape; margin: 12mm;');
    expect(html).toContain('font: 13pt/1.7');
    expect(html).toContain('"Microsoft YaHei"');
    expect(html).toContain('table-header-group');
    expect(html).toContain('white-space: pre-wrap');
    expect(html).toContain('overflow-wrap: anywhere');
    expect(html).toContain('widows: 3');
    expect(html).toContain('@media print');
    expect(page.querySelector('script,iframe,link')).toBe(null);
    expect(html).not.toContain('@import');
    expect(page.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')).toContain("connect-src 'none'");
  });

  it('escapes document titles and validates every interpolated CSS option', () => {
    const html = buildPrintDocument('<p>正文</p>', {
      title: '</title><script>alert(1)</script>&"',
      paper: 'A4; } @import "https://bad.test"; {' as 'A4',
      landscape: 'landscape' as unknown as boolean,
      marginMm: '10; color:red' as unknown as number,
      fontSize: Number.POSITIVE_INFINITY,
    });
    const page = new JSDOM(html).window.document;
    expect(page.title).toBe('</title><script>alert(1)</script>&"');
    expect(page.querySelector('script')).toBe(null);
    expect(html).not.toContain('bad.test');
    expect(html).not.toContain('color:red');
    expect(html).toContain('size: A4 portrait; margin: 16mm;');
    expect(html).toContain('font: 11pt/1.7');
  });

  it('clamps numeric margins and font sizes at both ends', () => {
    const minimum = buildPrintDocument('', { title: '', paper: 'A4', landscape: false, marginMm: -10, fontSize: -10 });
    const maximum = buildPrintDocument('', { title: '', paper: 'A4', landscape: false, marginMm: 999, fontSize: 999 });
    expect(minimum).toContain('margin: 0mm');
    expect(minimum).toContain('font: 8pt/1.7');
    expect(maximum).toContain('margin: 40mm');
    expect(maximum).toContain('font: 24pt/1.7');
    expect(minimum).toContain('<title>近译 · 文档转换</title>');
  });
});
