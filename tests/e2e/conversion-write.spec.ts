import type { Page, TestInfo } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import {
  decodePDFRawStream, degrees, PageSizes, PDFArray, PDFDict, PDFDocument,
  PDFName, PDFNumber, PDFRawStream, StandardFonts,
} from 'pdf-lib';
import { test, expect } from './conversion-browser-fixture';

type Upload = { name: string; mimeType: string; buffer: Buffer };
type SourcePage = { text: string; width: number; height: number; rotation?: number };
type ZipEntry = { name: string; bytes: Buffer };

async function makePdf(name: string, pages: SourcePage[]): Promise<Upload> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const source of pages) {
    const page = pdf.addPage([source.width, source.height]);
    page.drawText(source.text, { font, size: 18, x: 24, y: source.height - 50 });
    page.drawRectangle({ x: 24, y: 32, width: 60, height: 20 });
    page.setCropBox(2, 3, source.width - 4, source.height - 6);
    if (source.rotation) page.setRotation(degrees(source.rotation));
  }
  return { name, mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) };
}

async function sources(): Promise<{ alpha: Upload; beta: Upload }> {
  const [alpha, beta] = await Promise.all([
    makePdf('alpha.pdf', [
      { text: 'ALPHA ONE - original selectable text', width: 300, height: 500 },
      { text: 'ALPHA TWO - second source page', width: 400, height: 600, rotation: 90 },
    ]),
    makePdf('beta.pdf', [{ text: 'BETA ONE - another document', width: 500, height: 700 }]),
  ]);
  return { alpha, beta };
}

function pageContent(pdf: PDFDocument, index: number): string {
  const contents = pdf.getPage(index).node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray().map(ref => pdf.context.lookup(ref)) : [contents];
  return streams.map(stream => {
    if (!(stream instanceof PDFRawStream)) throw new Error('PDF page lost its original text/vector content stream');
    return new TextDecoder().decode(decodePDFRawStream(stream).decode());
  }).join('\n');
}

function embeddedImageDimensions(pdf: PDFDocument, index: number): Array<{ width: number; height: number }> {
  const resources = pdf.getPage(index).node.Resources();
  if (!resources) throw new Error('Image PDF page has no resources');
  const objects = resources.lookup(PDFName.of('XObject'), PDFDict);
  return objects.entries().flatMap(([, ref]) => {
    const stream = pdf.context.lookup(ref);
    if (!(stream instanceof PDFRawStream) || stream.dict.get(PDFName.of('Subtype')) !== PDFName.of('Image')) return [];
    return [{
      width: stream.dict.lookup(PDFName.of('Width'), PDFNumber).asNumber(),
      height: stream.dict.lookup(PDFName.of('Height'), PDFNumber).asNumber(),
    }];
  });
}

async function chooseTool(page: Page, title: string): Promise<void> {
  await page.getByRole('navigation', { name: '转换工具' }).getByRole('button', { name: title }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
}

async function downloadOutput(page: Page, info: TestInfo, artifact: string): Promise<{ name: string; bytes: Buffer }> {
  const link = page.getByRole('link', { name: /^下载 / });
  await expect(link).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
  const name = download.suggestedFilename();
  const destination = info.outputPath(`${artifact}-${name}`);
  await download.saveAs(destination);
  expect(await download.failure()).toBeNull();
  await info.attach(artifact, { path: destination, contentType: name.endsWith('.zip') ? 'application/zip' : 'application/pdf' });
  return { name, bytes: await readFile(destination) };
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}

/** Parse the converter's stored ZIP format; verify entry CRCs and the directory boundary. */
function storedZip(buffer: Buffer): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    expect(offset + 30).toBeLessThanOrEqual(buffer.length);
    const flags = buffer.readUInt16LE(offset + 6), method = buffer.readUInt16LE(offset + 8);
    expect(flags & 0x800).toBe(0x800); // UTF-8 names, including Chinese filenames.
    expect(flags & 0x08).toBe(0); // Sizes are in the local header, with no data descriptor.
    expect(method).toBe(0);
    const checksum = buffer.readUInt32LE(offset + 14);
    const compressed = buffer.readUInt32LE(offset + 18), size = buffer.readUInt32LE(offset + 22);
    expect(compressed).toBe(size);
    const nameLength = buffer.readUInt16LE(offset + 26), extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30, start = nameStart + nameLength + extraLength, end = start + size;
    expect(end).toBeLessThanOrEqual(buffer.length);
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString('utf8');
    const bytes = buffer.subarray(start, end);
    expect(crc32(bytes)).toBe(checksum);
    expect(entries.some(entry => entry.name === name)).toBe(false);
    entries.push({ name, bytes });
    offset = end;
  }
  expect(buffer.readUInt32LE(offset)).toBe(0x02014b50);
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(end).toBeGreaterThanOrEqual(offset);
  expect(end + 22).toBe(buffer.length);
  expect(buffer.readUInt16LE(end + 10)).toBe(entries.length);
  expect(buffer.readUInt32LE(end + 16)).toBe(offset);
  expect(buffer.readUInt32LE(end + 12)).toBe(end - offset);
  return entries;
}

test('merges two uploaded PDFs and preserves page text, vector streams and original directions', async ({ conversionPage: page }, info) => {
  const { alpha, beta } = await sources();
  const alphaPdf = await PDFDocument.load(alpha.buffer), betaPdf = await PDFDocument.load(beta.buffer);
  await chooseTool(page, '合并与整理 PDF');
  await page.locator('#cv-files').setInputFiles([alpha, beta]);
  await expect(page.locator('.cv-file-list > li')).toHaveCount(2);
  await page.getByLabel('导出文件名', { exact: true }).fill('merged-local');
  await page.getByRole('button', { name: '开始转换', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('PDF 已整理');
  const download = await downloadOutput(page, info, 'merged');
  expect(download.name).toBe('merged-local-整理.pdf');
  const output = await PDFDocument.load(download.bytes);
  expect(output.getPageCount()).toBe(3);
  expect(output.getPages().map(value => value.getWidth())).toEqual([300, 400, 500]);
  expect(output.getPages().map(value => value.getRotation().angle)).toEqual([0, 90, 0]);
  expect([0, 1, 2].map(index => pageContent(output, index))).toEqual([
    pageContent(alphaPdf, 0), pageContent(alphaPdf, 1), pageContent(betaPdf, 0),
  ]);
  expect(output.getPage(0).getCropBox()).toEqual(alphaPdf.getPage(0).getCropBox());
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('applies custom page order, repeated pages, file reordering and relative rotation through the UI', async ({ conversionPage: page }, info) => {
  const { alpha, beta } = await sources();
  const alphaPdf = await PDFDocument.load(alpha.buffer), betaPdf = await PDFDocument.load(beta.buffer);
  await chooseTool(page, '合并与整理 PDF');
  await page.locator('#cv-files').setInputFiles([alpha, beta]);
  await expect(page.locator('.cv-file-list > li')).toHaveCount(2);
  await page.getByLabel('这个文件的页码范围', { exact: true }).nth(0).fill('2,1,2');
  await page.getByLabel('这个文件的页码范围', { exact: true }).nth(1).fill('1');
  await page.getByRole('button', { name: '上移文件 2', exact: true }).click();
  await expect(page.locator('.cv-file-list > li').first()).toContainText('beta.pdf');
  await page.getByLabel('页面旋转').selectOption('90');
  await page.getByLabel('导出文件名', { exact: true }).fill('reordered');
  await page.getByRole('button', { name: '开始转换', exact: true }).click();
  const download = await downloadOutput(page, info, 'reordered-rotated');
  const output = await PDFDocument.load(download.bytes);
  expect(output.getPageCount()).toBe(4);
  expect(output.getPages().map(value => value.getWidth())).toEqual([500, 400, 300, 400]);
  expect(output.getPages().map(value => value.getRotation().angle)).toEqual([90, 180, 90, 180]);
  expect([0, 1, 2, 3].map(index => pageContent(output, index))).toEqual([
    pageContent(betaPdf, 0), pageContent(alphaPdf, 1), pageContent(alphaPdf, 0), pageContent(alphaPdf, 1),
  ]);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('splits selected and repeated pages into a valid UTF-8 ZIP of independently readable PDFs', async ({ conversionPage: page }, info) => {
  const { alpha } = await sources();
  const source = await PDFDocument.load(alpha.buffer);
  await chooseTool(page, '拆分 PDF');
  await page.locator('#cv-files').setInputFiles({ ...alpha, name: '阅读笔记.pdf' });
  await page.getByLabel('页码范围').fill('2,1,2');
  await page.getByLabel('导出文件名', { exact: true }).fill('selected');
  await page.getByRole('button', { name: '开始转换', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已拆分为 3 份单页 PDF');
  const download = await downloadOutput(page, info, 'split');
  expect(download.name).toBe('selected-拆页.zip');
  const entries = storedZip(download.bytes);
  expect(entries.map(value => value.name)).toEqual([
    '阅读笔记-page-002.pdf', '阅读笔记-page-001.pdf', '阅读笔记-page-002-copy-2.pdf',
  ]);
  const documents = await Promise.all(entries.map(entry => PDFDocument.load(entry.bytes)));
  expect(documents.map(pdf => pdf.getPageCount())).toEqual([1, 1, 1]);
  expect(documents.map(pdf => pdf.getPage(0).getWidth())).toEqual([400, 300, 400]);
  expect(documents.map(pdf => pdf.getPage(0).getRotation().angle)).toEqual([90, 0, 90]);
  expect(documents.map(pdf => pageContent(pdf, 0))).toEqual([
    pageContent(source, 1), pageContent(source, 0), pageContent(source, 1),
  ]);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('combines real PNG, JPEG and WebP files in chosen order using original and A4 page sizes', async ({ conversionPage: page }, info) => {
  const images = await page.evaluate(() => {
    const samples = [
      { name: 'landscape.png', mimeType: 'image/png', width: 320, height: 160, color: '#1a7b69' },
      { name: 'portrait.jpg', mimeType: 'image/jpeg', width: 100, height: 200, color: '#e6ba68' },
      { name: 'square.webp', mimeType: 'image/webp', width: 180, height: 180, color: '#86b79a' },
    ];
    return samples.map(sample => {
      const canvas = document.createElement('canvas');
      canvas.width = sample.width; canvas.height = sample.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Browser cannot generate test images');
      context.fillStyle = sample.color;
      context.fillRect(0, 0, sample.width, sample.height);
      context.fillStyle = '#ffffff'; context.font = '16px sans-serif';
      context.fillText(sample.name, 5, 25);
      const data = canvas.toDataURL(sample.mimeType, 0.94);
      if (!data.startsWith(`data:${sample.mimeType};base64,`)) throw new Error(`Browser encoder unavailable: ${sample.mimeType}`);
      canvas.width = 0; canvas.height = 0;
      return { ...sample, data: data.slice(data.indexOf(',') + 1) };
    });
  });
  const files: Upload[] = images.map(image => ({ name: image.name, mimeType: image.mimeType, buffer: Buffer.from(image.data, 'base64') }));
  await chooseTool(page, '图片 → PDF');
  await page.locator('#cv-files').setInputFiles(files);
  await expect(page.locator('.cv-file-list > li')).toHaveCount(3);
  await page.getByRole('button', { name: '上移文件 2', exact: true }).click();
  await expect(page.locator('.cv-file-list > li').first()).toContainText('portrait.jpg');
  await page.getByLabel('导出文件名', { exact: true }).fill('image-bundle');
  await page.getByLabel('PDF 页面').selectOption('original');
  await page.getByRole('button', { name: '开始转换', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('3 张图片按列表顺序合成 PDF');
  const originalDownload = await downloadOutput(page, info, 'images-original');
  expect(originalDownload.name).toBe('image-bundle.pdf');
  const original = await PDFDocument.load(originalDownload.bytes);
  expect(original.getPageCount()).toBe(3);
  // Original uses 96 px/inch, plus 24 pt of white margin on each side.
  expect(original.getPages().map(value => value.getSize())).toEqual([
    { width: 123, height: 198 }, { width: 288, height: 168 }, { width: 183, height: 183 },
  ]);
  expect([0, 1, 2].map(index => embeddedImageDimensions(original, index))).toEqual([
    [{ width: 100, height: 200 }], [{ width: 320, height: 160 }], [{ width: 180, height: 180 }],
  ]);

  await page.getByLabel('PDF 页面').selectOption('a4');
  await expect(page.getByRole('link', { name: /^下载 / })).toHaveCount(0);
  await page.getByRole('button', { name: '开始转换', exact: true }).click();
  const a4Download = await downloadOutput(page, info, 'images-a4');
  const a4 = await PDFDocument.load(a4Download.bytes);
  expect(a4.getPageCount()).toBe(3);
  for (const outputPage of a4.getPages()) {
    expect(outputPage.getWidth()).toBeCloseTo(PageSizes.A4[0], 2);
    expect(outputPage.getHeight()).toBeCloseTo(PageSizes.A4[1], 2);
  }
  expect([0, 1, 2].map(index => embeddedImageDimensions(a4, index))).toEqual([
    [{ width: 100, height: 200 }], [{ width: 320, height: 160 }], [{ width: 180, height: 180 }],
  ]);
  await expect(page.getByRole('alert')).toHaveCount(0);
});
