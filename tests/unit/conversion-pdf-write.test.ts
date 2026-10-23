import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodePDFRawStream, degrees, PageSizes, PDFArray, PDFDocument, PDFHexString, PDFName, PDFRawStream } from 'pdf-lib';
import { imagesToPdf, mergePdfs, splitPdf, validateImageFile } from '../../src/conversion/pdf-write';
import { LIMITS } from '../../src/conversion/types';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function pdfFile(widths = [101, 202, 303], name = 'notes.pdf'): Promise<File> {
  const pdf = await PDFDocument.create();
  for (const width of widths) {
    const page = pdf.addPage([width, 400]);
    page.drawText(`Page-${width}`, { x: 8, y: 100, size: 9 });
    page.drawRectangle({ x: 1, y: 2, width: 5, height: 6 });
    page.setCropBox(1, 2, width - 3, 390);
    page.setRotation(degrees(width === 202 ? 90 : 0));
  }
  return new File([Uint8Array.from(await pdf.save())], name, { type: 'application/pdf' });
}

function contents(pdf: PDFDocument, index: number): string {
  const raw = pdf.getPage(index).node.Contents();
  const streams = raw instanceof PDFArray ? raw.asArray().map(ref => pdf.context.lookup(ref)) : [raw];
  return streams.map(stream => {
    if (!(stream instanceof PDFRawStream)) throw new Error('Expected a preserved PDF content stream');
    return new TextDecoder().decode(decodePDFRawStream(stream).decode());
  }).join('\n');
}

describe('local PDF page operations', () => {
  it('merges selected pages in file/range order, repeats pages and preserves vector/text streams and crop boxes', async () => {
    const first = await pdfFile(), second = await pdfFile([404], 'second.pdf');
    const original = await PDFDocument.load(await first.arrayBuffer());
    const progress = vi.fn();
    const result = await PDFDocument.load(await mergePdfs([
      { file: first, pages: '3,1,1' }, { file: second },
    ], { onProgress: progress }));
    expect(result.getPages().map(page => page.getWidth())).toEqual([303, 101, 101, 404]);
    expect(contents(result, 0)).toBe(contents(original, 2));
    expect(contents(result, 1)).toBe(contents(original, 0));
    expect(contents(result, 2)).toBe(contents(original, 0));
    expect(result.getPage(0).getCropBox()).toEqual(original.getPage(2).getCropBox());
    expect(progress.mock.calls).toEqual([[0, 4], [1, 4], [2, 4], [3, 4], [4, 4]]);
  });

  it('adds rotation to existing rotations without rotating a repeated page twice', async () => {
    const file = await pdfFile();
    const result = await PDFDocument.load(await mergePdfs([{ file, pages: '2,1,2' }], { rotation: -90 }));
    expect(result.getPages().map(page => page.getRotation().angle)).toEqual([0, 270, 0]);
    const source = await PDFDocument.load(await file.arrayBuffer());
    expect(source.getPage(1).getRotation().angle).toBe(90);
  });

  it('keeps one shared real PNG across twelve source pages while repeated output pages have independent leaves', async () => {
    const source = await PDFDocument.create();
    const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/aTkwAAAAASUVORK5CYII=', 'base64'));
    const image = await source.embedPng(png);
    for (let index = 0; index < 12; index++) {
      source.addPage([200, 300]).drawImage(image, { x: 24, y: 40, width: 100, height: 100 });
    }
    const countImages = (pdf: PDFDocument) => pdf.context.enumerateIndirectObjects().filter(([, object]) =>
      object instanceof PDFRawStream && object.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')).length;
    const file = new File([Uint8Array.from(await source.save())], 'shared-template.pdf', { type: 'application/pdf' });
    const original = await PDFDocument.load(await file.arrayBuffer());
    expect(countImages(original)).toBe(1);
    const output = await PDFDocument.load(await mergePdfs([{ file, pages: '1-12,1' }], { rotation: 90 }));
    expect(output.getPageCount()).toBe(13);
    expect(countImages(output)).toBe(1);
    expect(output.getPages().map(page => page.getRotation().angle)).toEqual(Array.from({ length: 13 }, () => 90));
    expect(output.getPage(0).node).not.toBe(output.getPage(12).node);
    expect(output.getPage(0).ref.toString()).not.toBe(output.getPage(12).ref.toString());
    expect(contents(output, 0)).toBe(contents(output, 12));
    output.getPage(0).setRotation(degrees(180));
    expect(output.getPage(12).getRotation().angle).toBe(90);
    expect(original.getPage(0).getRotation().angle).toBe(0);
  });

  it('splits selected pages into one-page files with safe unique names', async () => {
    const file = await pdfFile([101, 202, 303], 'folder/bad:name.pdf');
    const results = await splitPdf(file, { pages: '3,1,3' });
    expect(results.map(item => item.name)).toEqual([
      'folder-bad-name-page-003.pdf', 'folder-bad-name-page-001.pdf', 'folder-bad-name-page-003-copy-2.pdf',
    ]);
    const documents = await Promise.all(results.map(item => PDFDocument.load(item.bytes)));
    expect(documents.map(pdf => pdf.getPageCount())).toEqual([1, 1, 1]);
    expect(documents.map(pdf => pdf.getPage(0).getWidth())).toEqual([303, 101, 303]);
    const source = await PDFDocument.load(await file.arrayBuffer());
    expect(contents(documents[0]!, 0)).toBe(contents(source, 2));
  });

  it('rejects invalid ranges, empty input, invalid PDF bytes and non-right-angle rotations', async () => {
    const file = await pdfFile();
    await expect(mergePdfs([])).rejects.toThrow('选择文件');
    await expect(mergePdfs([{ file, pages: '0,1' }])).rejects.toThrow('范围');
    await expect(splitPdf(file, { pages: '4' })).rejects.toThrow('范围');
    await expect(mergePdfs([{ file }], { rotation: 45 })).rejects.toThrow('90°');
    await expect(mergePdfs([{ file }], { rotation: Infinity })).rejects.toThrow('90°');
    await expect(splitPdf(new File(['bad PDF'], 'broken.pdf'))).rejects.toThrow('完整有效');
    await expect(splitPdf(new File([], 'empty.pdf'))).rejects.toThrow('空文件');
  });

  it('refuses encrypted PDFs rather than ignoring encryption and returning corrupt pages', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    // A document marked encrypted must always be refused, before any page copy.
    pdf.context.trailerInfo.Encrypt = pdf.context.register(pdf.context.obj({
      Filter: 'Standard', V: 1, R: 2, P: -4,
      O: PDFHexString.of('00'.repeat(32)), U: PDFHexString.of('00'.repeat(32)),
    }));
    const file = new File([Uint8Array.from(await pdf.save({ useObjectStreams: false }))], 'encrypted.pdf');
    await expect(mergePdfs([{ file }])).rejects.toThrow('加密 PDF');
    await expect(splitPdf(file)).rejects.toThrow('加密 PDF');
  });

  it('checks bytes before reading and bounds aggregate selected page counts', async () => {
    const arrayBuffer = vi.fn();
    const tooLarge = { name: 'huge.pdf', size: LIMITS.maxInputBytes + 1, arrayBuffer } as unknown as File;
    await expect(splitPdf(tooLarge)).rejects.toThrow('100 MB');
    expect(arrayBuffer).not.toHaveBeenCalled();
    const file = await pdfFile([101]);
    await expect(mergePdfs([{ file, pages: Array.from({ length: LIMITS.maxPages }, () => '1').join(',') }, { file }])).rejects.toThrow('最多处理');
    await expect(mergePdfs(Array.from({ length: LIMITS.maxFiles + 1 }, () => ({ file })))).rejects.toThrow('最多选择');
  });

  it('stops on cancellation before work and while copying/splitting pages', async () => {
    const file = await pdfFile(), before = new AbortController();
    before.abort();
    await expect(mergePdfs([{ file }], { signal: before.signal })).rejects.toMatchObject({ name: 'AbortError' });
    const duringMerge = new AbortController(), mergeProgress = vi.fn((done: number) => { if (done === 1) duringMerge.abort(); });
    await expect(mergePdfs([{ file }], { signal: duringMerge.signal, onProgress: mergeProgress })).rejects.toMatchObject({ name: 'AbortError' });
    expect(mergeProgress.mock.calls.map(call => call[0])).toEqual([0, 1]);
    const duringSplit = new AbortController(), splitProgress = vi.fn((done: number) => { if (done === 1) duringSplit.abort(); });
    await expect(splitPdf(file, { signal: duringSplit.signal, onProgress: splitProgress })).rejects.toMatchObject({ name: 'AbortError' });
    expect(splitProgress.mock.calls.map(call => call[0])).toEqual([0, 1]);
  });

  it('rejects oversized generated files and aggregate split output before returning partial results', async () => {
    const file = await pdfFile();
    const huge = new Uint8Array(1);
    Object.defineProperty(huge, 'byteLength', { value: LIMITS.maxOutputBytes + 1 });
    const save = vi.spyOn(PDFDocument.prototype, 'save').mockResolvedValueOnce(huge);
    await expect(mergePdfs([{ file }])).rejects.toThrow('超过 128 MB');
    const half = new Uint8Array(1);
    Object.defineProperty(half, 'byteLength', { value: Math.floor(LIMITS.maxOutputBytes / 2) + 1 });
    save.mockResolvedValue(half);
    await expect(splitPdf(file, { pages: '1,2' })).rejects.toThrow('合计超过');
  });
});

/** Fake canvas output: a JPEG SOF header is enough for pdf-lib's embedder. Actual codecs are exercised by browser tests. */
const ENCODED_JPEG = new Uint8Array([255, 216, 255, 192, 0, 17, 8, 0, 1, 0, 1, 3, 1, 17, 0, 2, 17, 1, 3, 17, 1, 255, 217]);

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width); view.setUint32(20, height);
  return bytes;
}

function imageFile(width = 800, height = 400, type = 'image/png', name = 'image.png'): File {
  return new File([new Uint8Array(pngHeader(width, height))], name, { type });
}

function mockImageBrowser(width = 800, height = 400) {
  const close = vi.fn(), bitmap = { width, height, close } as unknown as ImageBitmap;
  const context = { fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn() };
  const canvas = { width: 0, height: 0, getContext: vi.fn(() => context), toBlob: vi.fn((callback: BlobCallback) => callback(new Blob([ENCODED_JPEG], { type: 'image/jpeg' }))) };
  const decode = vi.fn(async () => bitmap);
  vi.stubGlobal('createImageBitmap', decode);
  vi.stubGlobal('document', { createElement: vi.fn(() => canvas) });
  return { close, bitmap, context, canvas, decode };
}

describe('local image to PDF pipeline', () => {
  it('validates local attachment headers without decoding, creating canvases or reading full contents', async () => {
    const decode = vi.fn(), createElement = vi.fn();
    vi.stubGlobal('createImageBitmap', decode);
    vi.stubGlobal('document', { createElement });
    const file = imageFile(), read = vi.spyOn(file, 'arrayBuffer');
    await expect(validateImageFile(file)).resolves.toBeUndefined();
    expect(read).not.toHaveBeenCalled();
    expect(decode).not.toHaveBeenCalled();
    expect(createElement).not.toHaveBeenCalled();
    await expect(validateImageFile(imageFile(5000, 5000))).rejects.toThrow('1600 万像素');
    await expect(validateImageFile(new File(['<svg/>'], 'fake.png', { type: 'image/png' }))).rejects.toThrow('无法识别');
    await expect(validateImageFile(imageFile(1, 1, 'image/svg+xml', 'vector.svg'))).rejects.toThrow('不受支持');
    const tooLarge = { name: 'huge.png', size: LIMITS.maxInputBytes + 1 } as File;
    await expect(validateImageFile(tooLarge)).rejects.toThrow('100 MB');
    const aborted = new AbortController();
    aborted.abort();
    await expect(validateImageFile(file, aborted.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(decode).not.toHaveBeenCalled();
  });

  it('fits landscape images on A4 without stretching, paints white, requests EXIF and releases surfaces', async () => {
    const browser = mockImageBrowser(), file = imageFile();
    const result = await PDFDocument.load(await imagesToPdf([file], { pageSize: 'a4', margin: 24 }));
    expect(result.getPage(0).getWidth()).toBeCloseTo(PageSizes.A4[0]);
    expect(result.getPage(0).getHeight()).toBeCloseTo(PageSizes.A4[1]);
    const stream = contents(result, 0);
    const transforms = [...stream.matchAll(/([\d.]+) 0 0 ([\d.]+) 0 0 cm/g)];
    const transform = transforms.find(match => Number(match[1]) > 1)!;
    expect(Number(transform[1]) / Number(transform[2])).toBeCloseTo(2);
    expect(Number(transform[1])).toBeCloseTo(PageSizes.A4[0] - 48);
    expect(browser.decode).toHaveBeenCalledWith(file, { imageOrientation: 'from-image' });
    expect(browser.context.fillStyle).toBe('#ffffff');
    expect(browser.context.fillRect).toHaveBeenCalledWith(0, 0, 800, 400);
    expect(browser.context.fillRect.mock.invocationCallOrder[0]).toBeLessThan(browser.context.drawImage.mock.invocationCallOrder[0]!);
    expect(browser.close).toHaveBeenCalledOnce();
    expect(browser.canvas.width).toBe(0); expect(browser.canvas.height).toBe(0);
  });

  it('uses original dimensions at 96dpi plus point margins and preserves chosen file order', async () => {
    const browser = mockImageBrowser(400, 800);
    browser.decode.mockResolvedValueOnce({ width: 800, height: 400, close: browser.close } as unknown as ImageBitmap);
    const result = await PDFDocument.load(await imagesToPdf([imageFile(), imageFile(400, 800)], { pageSize: 'original', margin: 12 }));
    expect(result.getPages().map(page => page.getSize())).toEqual([{ width: 624, height: 324 }, { width: 324, height: 624 }]);
    expect(browser.close).toHaveBeenCalledTimes(2);
  });

  it('checks dimensions before decoding, rejects disguised formats and validates margin', async () => {
    const browser = mockImageBrowser();
    await expect(imagesToPdf([imageFile(5000, 5000)], { pageSize: 'a4', margin: 0 })).rejects.toThrow('1600 万像素');
    await expect(imagesToPdf([new File(['<svg/>'], 'fake.png', { type: 'image/png' })], { pageSize: 'a4', margin: 0 })).rejects.toThrow('无法识别');
    await expect(imagesToPdf([imageFile(1, 1, 'image/gif', 'animation.gif')], { pageSize: 'a4', margin: 0 })).rejects.toThrow('不受支持');
    await expect(imagesToPdf([imageFile()], { pageSize: 'a4', margin: NaN })).rejects.toThrow('页边距');
    await expect(imagesToPdf([imageFile()], { pageSize: 'a4', margin: 145 })).rejects.toThrow('页边距');
    expect(browser.decode).not.toHaveBeenCalled();
  });

  it('accepts JPEG and the three WebP image headers, including omitted file-picker MIME types', async () => {
    const browser = mockImageBrowser(1, 1);
    const webp = (kind: string, payload: number[]) => {
      const bytes = new Uint8Array(20 + payload.length + (payload.length % 2));
      bytes.set(new TextEncoder().encode('RIFF'), 0);
      new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true);
      bytes.set(new TextEncoder().encode('WEBP' + kind), 8);
      new DataView(bytes.buffer).setUint32(16, payload.length, true);
      bytes.set(payload, 20);
      return new File([bytes], `${kind.trim()}.webp`, { type: 'image/webp' });
    };
    const files = [
      new File([ENCODED_JPEG], 'photo.jpeg'),
      webp('VP8X', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      webp('VP8L', [0x2f, 0, 0, 0, 0]),
      webp('VP8 ', [0, 0, 0, 0x9d, 1, 0x2a, 1, 0, 1, 0]),
    ];
    const result = await PDFDocument.load(await imagesToPdf(files, { pageSize: 'original', margin: 0 }));
    expect(result.getPageCount()).toBe(4);
    expect(browser.decode).toHaveBeenCalledTimes(4);
    expect(browser.close).toHaveBeenCalledTimes(4);
  });

  it('releases a bitmap on canvas failure and rejects failed encodings', async () => {
    const browser = mockImageBrowser();
    browser.canvas.getContext.mockReturnValueOnce(null as never);
    await expect(imagesToPdf([imageFile()], { pageSize: 'a4', margin: 0 })).rejects.toThrow('画布');
    expect(browser.close).toHaveBeenCalledOnce();
    expect(browser.canvas.width).toBe(0);
    browser.canvas.toBlob.mockImplementationOnce(callback => callback(null));
    await expect(imagesToPdf([imageFile()], { pageSize: 'a4', margin: 0 })).rejects.toThrow('编码失败');
    expect(browser.close).toHaveBeenCalledTimes(2);
    expect(browser.canvas.width).toBe(0);
  });

  it('cancels a pending browser decode and closes the bitmap when it arrives later', async () => {
    const browser = mockImageBrowser(), controller = new AbortController();
    let finishDecode!: (value: ImageBitmap) => void;
    browser.decode.mockImplementationOnce(() => new Promise(resolve => { finishDecode = resolve; }));
    const pending = imagesToPdf([imageFile()], { pageSize: 'a4', margin: 0, signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(browser.decode).toHaveBeenCalledOnce());
    controller.abort();
    await rejected;
    finishDecode(browser.bitmap);
    await Promise.resolve();
    expect(browser.close).toHaveBeenCalledOnce();
    expect(browser.canvas.getContext).not.toHaveBeenCalled();
  });

  it('cancels pending JPEG encoding, clears the backing store and ignores a late codec callback', async () => {
    const browser = mockImageBrowser(), controller = new AbortController();
    let encode!: BlobCallback;
    browser.canvas.toBlob.mockImplementationOnce(callback => { encode = callback; });
    const pending = imagesToPdf([imageFile()], { pageSize: 'a4', margin: 0, signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(browser.canvas.toBlob).toHaveBeenCalledOnce());
    controller.abort();
    await rejected;
    expect(browser.canvas.width).toBe(0); expect(browser.canvas.height).toBe(0);
    expect(browser.close).toHaveBeenCalledOnce();
    encode(new Blob([ENCODED_JPEG], { type: 'image/jpeg' }));
    await Promise.resolve();
    expect(browser.close).toHaveBeenCalledOnce();
  });
});
