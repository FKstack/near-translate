import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paginateDocument } from '../../src/conversion/document-pdf';

describe('direct document PDF pagination', () => {
  it('uses one page for empty or exactly fitting content', () => {
    expect(paginateDocument(0, 100, [])).toEqual([0]);
    expect(paginateDocument(100, 100, [])).toEqual([0]);
  });
  it('moves a short table row or image to the next page without dropping its space', () => {
    expect(paginateDocument(220, 100, [{ y: 80, height: 40 }])).toEqual([0, 80, 180]);
  });
  it('splits a very tall row at individual text lines and always makes progress', () => {
    expect(paginateDocument(250, 100, [
      { y: 0, height: 250 }, { y: 95, height: 15 }, { y: 190, height: 15 },
    ])).toEqual([0, 95, 190]);
  });
  it('keeps overlapping protected line boxes together by backing up the cut', () => {
    expect(paginateDocument(150, 100, [{ y: 80, height: 25 }, { y: 70, height: 15 }])).toEqual([0, 70]);
  });
  it('rejects invalid geometry and an output beyond the page limit', () => {
    expect(() => paginateDocument(100, 0, [])).toThrow('尺寸');
    expect(() => paginateDocument(Number.NaN, 100, [])).toThrow('尺寸');
    expect(() => paginateDocument(50_001, 100, [])).toThrow('500');
  });
});

describe('local compressed document font', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('window', { location: { href: 'chrome-extension://sample/convert.html' } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('decodes the complete source font unchanged and caches only its decoded bytes', async () => {
    const compressed = await readFile(new URL('../../third_party/fonts/NearDocumentSans.ttf.gz', import.meta.url));
    const fetchFont = vi.fn(async () => new Response(compressed));
    vi.stubGlobal('fetch', fetchFont);
    const { loadDocumentFont } = await import('../../src/conversion/document-pdf');
    const decoded = await loadDocumentFont();
    expect(decoded.length).toBe(10_642_808);
    expect(createHash('sha256').update(decoded).digest('hex')).toBe('40d7aa23a3cb25765a3b019136fdfe70a9f08f428d8e1042f0d472fde376132a');
    expect(await loadDocumentFont()).toBe(decoded);
    expect(fetchFont).toHaveBeenCalledOnce();
    expect(fetchFont).toHaveBeenCalledWith(
      new URL('chrome-extension://sample/fonts/NearDocumentSans.ttf.gz'),
      expect.objectContaining({ cache: 'force-cache', credentials: 'omit' }),
    );
  });

  it('rejects a corrupt gzip without caching failed font data', async () => {
    const fetchFont = vi.fn()
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])))
      .mockResolvedValueOnce(new Response(gzipSync(new Uint8Array(1024))));
    vi.stubGlobal('fetch', fetchFont);
    const { loadDocumentFont } = await import('../../src/conversion/document-pdf');
    await expect(loadDocumentFont()).rejects.toThrow('字体文件不完整');
    expect((await loadDocumentFont()).length).toBe(1024);
    expect(fetchFont).toHaveBeenCalledTimes(2);
  });

  it('bounds the decoded byte count for short and oversized gzip assets', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(gzipSync(new Uint8Array(999))))
      .mockResolvedValueOnce(new Response(gzipSync(new Uint8Array(32 * 1024 * 1024 + 1)))));
    const { loadDocumentFont } = await import('../../src/conversion/document-pdf');
    await expect(loadDocumentFont()).rejects.toThrow('字体文件不完整');
    await expect(loadDocumentFont()).rejects.toThrow('字体文件不完整');
  });

  it('does not fetch an already cancelled request', async () => {
    const fetchFont = vi.fn();
    vi.stubGlobal('fetch', fetchFont);
    const { loadDocumentFont } = await import('../../src/conversion/document-pdf');
    const controller = new AbortController(); controller.abort();
    await expect(loadDocumentFont(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchFont).not.toHaveBeenCalled();
  });

  it('cancels and releases an unfinished compressed stream', async () => {
    const cancelled = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(gzipSync(new Uint8Array(1024)).subarray(0, 12)); },
      cancel: cancelled,
    }));
    const fetchFont = vi.fn(async () => response);
    vi.stubGlobal('fetch', fetchFont);
    const { loadDocumentFont } = await import('../../src/conversion/document-pdf');
    const controller = new AbortController();
    const pending = loadDocumentFont(controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(response.body?.locked).toBe(true));
    controller.abort();
    await rejected;
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
  });
});
