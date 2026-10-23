import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { layoutPdfPage } from '../../src/conversion/pdf-layout';
import type { PdfTextRun } from '../../src/conversion/pdf-layout';
import { pdfToImages, pdfToText } from '../../src/conversion/pdf-read';

const pdf = vi.hoisted(() => ({ getDocument: vi.fn() }));
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {}, getDocument: pdf.getDocument,
  Util: { transform: (first: number[], second: number[]) => [
    first[0]! * second[0]! + first[2]! * second[1]!,
    first[1]! * second[0]! + first[3]! * second[1]!,
    first[0]! * second[2]! + first[2]! * second[3]!,
    first[1]! * second[2]! + first[3]! * second[3]!,
    first[0]! * second[4]! + first[2]! * second[5]! + first[4]!,
    first[1]! * second[4]! + first[3]! * second[5]! + first[5]!,
  ] },
}));

function run(text: string, x = 40, y = 40, width = text.length * 6, size = 12, fontFamily = 'Arial'): PdfTextRun {
  return { text, x, y, width, size, fontFamily };
}
const markdown = (runs: PdfTextRun[], width = 600) => layoutPdfPage(runs, { format: 'markdown', width });

describe('PDF geometry reconstruction', () => {
  it('restores visual order and spaces between independently encoded words', () => {
    const result = markdown([run('world.', 77), run('Hello', 40, 40, 30), run('Next line.', 40, 54)]);
    expect(result.text).toBe('Hello world. Next line.');
  });

  it('keeps nearby CJK runs and lines joined without invented spaces', () => {
    const result = markdown([run('自然', 40, 40, 24), run('阅读', 68, 40, 24), run('中文', 40, 54, 24)]);
    expect(result.text).toBe('自然阅读中文');
  });

  it('separates paragraphs and joins a word hyphenated at a line boundary', () => {
    const result = markdown([run('A simple docu-', 40, 40), run('ment reads well.', 40, 54), run('Another paragraph.', 40, 88)]);
    expect(result.text).toBe('A simple document reads well.\n\nAnother paragraph.');
  });

  it('infers headings from size against text-weighted body fonts', () => {
    const result = markdown([run('Reading notes', 40, 40, 220, 24), run('This is a longer body sentence with normal text size.', 40, 75), run('The second body line uses the same font.', 40, 89)]);
    expect(result.text).toBe('# Reading notes\n\nThis is a longer body sentence with normal text size. The second body line uses the same font.');
  });

  it('preserves bullet and ordered list structure', () => {
    expect(markdown([run('• First task', 40, 40), run('• Second task', 40, 58), run('1. Next task', 40, 76)]).text)
      .toBe('- First task\n- Second task\n1. Next task');
  });

  it('creates a simple aligned Markdown table and escapes literal cell pipes', () => {
    const result = markdown([
      run('Format', 40, 40, 50), run('Purpose', 240, 40, 80),
      run('MD | TXT', 40, 58, 70), run('Notes', 240, 58, 50),
      run('PDF', 40, 76, 30), run('Sharing', 240, 76, 70),
    ]);
    expect(result.text).toBe('| Format | Purpose |\n| --- | --- |\n| MD \\| TXT | Notes |\n| PDF | Sharing |');
    expect(result.warnings).toEqual([]);
  });

  it('uses tabs for plain-text tables without Markdown syntax', () => {
    expect(layoutPdfPage([run('Name', 40), run('Value', 240), run('Scale', 40, 58), run('1.5', 240, 58)], { format: 'text', width: 600 }).text)
      .toBe('Name\tValue\nScale\t1.5');
  });

  it('preserves monospace code blocks and indentation', () => {
    const result = markdown([run('function hello() {', 40, 40, 130, 12, 'Courier New'), run('return 42;', 54.4, 55, 80, 12, 'Courier New'), run('}', 40, 70, 8, 12, 'Courier New')]);
    expect(result.text).toBe('```\nfunction hello() {\n  return 42;\n}\n```');
  });

  it('chooses a long enough fence if extracted code contains backticks', () => {
    expect(markdown([run('console.log("```");', 40, 40, 150, 12, 'monospace')]).text).toBe('````\nconsole.log("```");\n````');
  });

  it('reads a two-column document down each column instead of alternating rows', () => {
    const result = markdown([
      run('A page title', 40, 20, 520, 24),
      run('Left column first paragraph has enough words.', 40, 60, 205), run('Right column begins with another paragraph.', 330, 60, 210),
      run('Left column carries on in this second line.', 40, 75, 205), run('Right column carries on in its second line.', 330, 75, 210),
      run('Left column ends after this final line.', 40, 90, 205), run('Right column ends after this final line.', 330, 90, 210),
    ]);
    expect(result.text.indexOf('Left column ends')).toBeLessThan(result.text.indexOf('Right column begins'));
    expect(result.text).toContain('# A page title');
    expect(result.warnings[0]).toContain('双栏');
  });

  it('keeps an aligned table above a two-column section as a table', () => {
    const result = markdown([
      run('Format', 40, 20, 45), run('Purpose', 330, 20, 60),
      run('PDF', 40, 36, 25), run('Sharing', 330, 36, 60),
      run('Left column first paragraph has enough words.', 40, 80, 200), run('Right column begins with another paragraph.', 330, 80, 210),
      run('Left column carries on in this second line.', 40, 95, 200), run('Right column carries on in its second line.', 330, 95, 210),
      run('Left column ends after this final line.', 40, 110, 200), run('Right column ends after this final line.', 330, 110, 210),
    ]);
    expect(result.text).toContain('| Format | Purpose |\n| --- | --- |\n| PDF | Sharing |');
    expect(result.text.indexOf('Left column ends')).toBeLessThan(result.text.indexOf('Right column begins'));
  });

  it('does not classify ordinary CJK Type0 fallback monospace text as code', () => {
    expect(markdown([run('中文阅读，自然清晰。', 40, 40, 200, 20, 'monospace')]).text).toBe('中文阅读，自然清晰。');
  });

  it('does not promote slightly larger ordinary body text to H3', () => {
    const result = markdown([
      run('A normal introduction in eleven point type.', 40, 40, 250, 11),
      run('Longer normal nine point text appears in a dense column.', 40, 70, 250, 9),
      run('More normal nine point body text supplies the baseline.', 40, 84, 250, 9),
    ]);
    expect(result.text).not.toContain('###');
  });

  it('retains safe annotation links and groups fragments with one destination', () => {
    const result = layoutPdfPage([run('Read', 40, 40, 24), run('the guide', 69, 40, 54)], {
      format: 'markdown', width: 600,
      links: [{ x: 38, y: 26, width: 88, height: 18, url: 'https://example.com/guide_(one)' }],
    });
    expect(result.text).toBe('[Read the guide](https://example.com/guide_%28one%29)');
  });

  it('does not create executable or local-file Markdown links', () => {
    for (const url of ['javascript:alert(1)', 'file:///secret.txt', 'data:text/html,hello']) {
      expect(layoutPdfPage([run('Read', 40, 40, 24)], { format: 'markdown', width: 600, links: [{ x: 35, y: 25, width: 40, height: 20, url }] }).text).toBe('Read');
    }
  });

  it('escapes document text that happens to resemble active Markdown', () => {
    expect(markdown([run('value * [link] <tag>', 40)]).text).toBe('value \\* \\[link\\] \\<tag\\>');
  });

  it('ignores empty and invalid runs without returning fabricated text', () => {
    expect(markdown([run('  '), { ...run('invalid'), x: Number.NaN }])).toEqual({ text: '', warnings: [] });
  });
});

describe('PDF read resource ownership and limits', () => {
  beforeEach(() => {
    pdf.getDocument.mockReset();
    vi.stubGlobal('window', { location: { href: 'chrome-extension://sample/conversion.html' } });
  });
  afterEach(() => vi.unstubAllGlobals());

  function session(text = 'Extracted document text.') {
    const cleanup = vi.fn();
    const getTextContent = vi.fn(async () => ({
      items: text ? [{ str: text, transform: [12, 0, 0, 12, 40, 800], height: 12, width: 180, fontName: 'body', dir: 'ltr' }] : [],
      styles: { body: { fontFamily: 'Arial' } },
    }));
    const page = { cleanup, getTextContent, getAnnotations: vi.fn(async () => []), getViewport: vi.fn(() => ({ width: 600, height: 840, transform: [1, 0, 0, -1, 0, 840] })) };
    const getPage = vi.fn(async () => page);
    const destroy = vi.fn(async () => {});
    pdf.getDocument.mockReturnValue({ promise: Promise.resolve({ numPages: 2, getPage }), destroy });
    return { page, getPage, destroy, cleanup, getTextContent };
  }

  it('releases each page and the worker after ordered selected-page extraction', async () => {
    const loaded = session();
    const onProgress = vi.fn();
    const result = await pdfToText(new Uint8Array([1, 2, 3]), { format: 'markdown', pages: '2,1', onProgress });
    expect(result.text).toContain('Extracted document text.\n\n---\n\nExtracted document text.');
    expect(result.pageCount).toBe(2);
    expect(loaded.getPage.mock.calls).toEqual([[2], [1]]);
    expect(loaded.cleanup).toHaveBeenCalledTimes(2);
    expect(loaded.destroy).toHaveBeenCalledTimes(1);
    expect(onProgress.mock.calls).toEqual([[0, 2], [1, 2], [2, 2]]);
    expect(pdf.getDocument.mock.calls[0]![0]).toMatchObject({
      cMapUrl: 'chrome-extension://sample/pdfjs/cmaps/',
      standardFontDataUrl: 'chrome-extension://sample/pdfjs/standard_fonts/', enableXfa: false,
    });
  });

  it('copies caller bytes before PDF.js may transfer the underlying buffer', async () => {
    session();
    const bytes = new Uint8Array([1, 2, 3]);
    await pdfToText(bytes, { format: 'text', pages: '1' });
    expect(pdf.getDocument.mock.calls[0]![0].data).not.toBe(bytes);
    expect([...bytes]).toEqual([1, 2, 3]);
  });

  it('scales fragment widths with UserUnit so adjacent glyph runs remain one word', async () => {
    const loaded = session();
    loaded.page.getViewport.mockReturnValue({ width: 1200, height: 1680, transform: [2, 0, 0, -2, 0, 1680] });
    loaded.getTextContent.mockResolvedValueOnce({
      items: [
        { str: 'Con', transform: [12, 0, 0, 12, 40, 800], width: 18, height: 12, fontName: 'body', dir: 'ltr' },
        { str: 'version', transform: [12, 0, 0, 12, 58, 800], width: 42, height: 12, fontName: 'body', dir: 'ltr' },
      ], styles: { body: { fontFamily: 'Arial' } },
    });
    const result = await pdfToText(new Uint8Array([1]), { format: 'text', pages: '1' });
    expect(result.text).toBe('Conversion');
  });

  it('rejects scanned documents instead of downloading an empty success', async () => {
    const loaded = session('');
    await expect(pdfToText(new Uint8Array([1]), { format: 'markdown' })).rejects.toThrow('不支持 OCR');
    expect(loaded.cleanup).toHaveBeenCalledTimes(2);
    expect(loaded.destroy).toHaveBeenCalledTimes(1);
  });

  it('keeps readable pages while warning about a scanned or blank page', async () => {
    const loaded = session();
    loaded.getTextContent.mockResolvedValueOnce({ items: [], styles: { body: { fontFamily: 'Arial' } } });
    const result = await pdfToText(new Uint8Array([1]), { format: 'text' });
    expect(result.text).toBe('Extracted document text.');
    expect(result.warnings.some((warning) => warning.includes('第 1 页'))).toBe(true);
  });

  it('releases the worker when loading fails and reports password errors', async () => {
    const destroy = vi.fn(async () => {});
    const error = Object.assign(new Error('Password'), { name: 'PasswordException' });
    pdf.getDocument.mockReturnValue({ promise: Promise.reject(error), destroy });
    await expect(pdfToText(new Uint8Array([1]), { format: 'text', password: 'wrong' })).rejects.toThrow('正确的密码');
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('does not create a worker for a previously cancelled operation', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(pdfToText(new Uint8Array([1]), { format: 'text', signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(pdf.getDocument).not.toHaveBeenCalled();
  });

  it('releases a page and destroys its worker exactly once when cancelled during extraction', async () => {
    const loaded = session();
    const controller = new AbortController();
    loaded.getTextContent.mockImplementationOnce(async () => { controller.abort(); return { items: [], styles: { body: { fontFamily: 'Arial' } } }; });
    await expect(pdfToText(new Uint8Array([1]), { format: 'text', signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(loaded.cleanup).toHaveBeenCalledTimes(1);
    expect(loaded.destroy).toHaveBeenCalledTimes(1);
  });

  it('bounds canvas pixels before allocating or rendering large pages', async () => {
    const loaded = session();
    const canvas = { width: 0, height: 0 };
    vi.stubGlobal('window', { location: { href: 'chrome-extension://sample/conversion.html' }, document: { createElement: vi.fn(() => canvas) } });
    loaded.page.getViewport.mockReturnValue({ width: 9000, height: 9000, transform: [1, 0, 0, -1, 0, 9000] });
    await expect(pdfToImages(new Uint8Array([1]), { format: 'png', pages: '1' })).rejects.toThrow('图片尺寸过大');
    expect(canvas).toEqual({ width: 0, height: 0 });
    expect(loaded.cleanup).toHaveBeenCalledTimes(1);
    expect(loaded.destroy).toHaveBeenCalledTimes(1);
  });
});
