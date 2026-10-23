import type { Page, Request } from '@playwright/test';
import { test, expect } from './conversion-browser-fixture';
import { pdfFixture } from './pdf-fixture';
import { CHINESE_FIXTURE_TEXT, chineseCMapPdfFixture, geometryPdfFixture, mixedLayoutPdfFixture } from './conversion-fixtures';

async function selectPdfTool(page: Page, tool: 'text' | 'images', bytes: Buffer, name = 'document.pdf') {
  await page.getByRole('button', { name: tool === 'text' ? /^PDF → Markdown/ : /^PDF → 图片/ }).click();
  await page.locator('#cv-files').setInputFiles({ name, mimeType: 'application/pdf', buffer: bytes });
  await expect(page.getByRole('button', { name: '开始转换', exact: true })).toBeEnabled();
}

async function convert(page: Page) {
  await page.getByRole('button', { name: '开始转换', exact: true }).click();
}

async function outputBytes(page: Page): Promise<{ name: string; mime: string; bytes: Buffer }> {
  const link = page.locator('.cv-download');
  await expect(link).toBeVisible();
  const value = await link.evaluate(async element => {
    const anchor = element as HTMLAnchorElement;
    const response = await fetch(anchor.href);
    if (!response.ok) throw new Error(`Cannot read local conversion result: ${response.status}`);
    return { name: anchor.download, mime: response.headers.get('Content-Type') ?? '', bytes: Array.from(new Uint8Array(await response.arrayBuffer())) };
  });
  return { ...value, bytes: Buffer.from(value.bytes) };
}

/** Read actual ZIP records independently of the production ZIP implementation. */
function zipEntries(bytes: Buffer): Array<{ name: string; bytes: Buffer }> {
  const entries: Array<{ name: string; bytes: Buffer }> = [];
  let offset = 0;
  while (offset + 4 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
    if (offset + 30 > bytes.length) throw new Error('Truncated ZIP local header.');
    const flags = bytes.readUInt16LE(offset + 6);
    const method = bytes.readUInt16LE(offset + 8);
    if (method !== 0 || flags & 0x08) throw new Error('Fixture expects complete, uncompressed ZIP records.');
    const compressed = bytes.readUInt32LE(offset + 18);
    const original = bytes.readUInt32LE(offset + 22);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const start = offset + 30 + nameLength + extraLength;
    if (compressed !== original || start + compressed > bytes.length) throw new Error('Invalid ZIP file length.');
    entries.push({ name: bytes.subarray(offset + 30, offset + 30 + nameLength).toString('utf8'), bytes: bytes.subarray(start, start + compressed) });
    offset = start + compressed;
  }
  if (offset + 4 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('Missing ZIP central directory.');
  const end = bytes.length - 22;
  if (end < offset || bytes.readUInt32LE(end) !== 0x06054b50 || bytes.readUInt16LE(end + 10) !== entries.length
    || bytes.readUInt32LE(end + 16) !== offset) throw new Error('Invalid ZIP central directory footer.');
  return entries;
}

async function decodedImage(page: Page, bytes: Buffer, mime: string) {
  return page.evaluate(async ({ data, type }) => {
    const blob = new Blob([new Uint8Array(data)], { type });
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    try {
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Missing browser canvas for image result validation.');
      context.drawImage(bitmap, 0, 0);
      const pixel = context.getImageData(Math.floor(bitmap.width / 3), Math.floor(bitmap.height / 3), 1, 1).data;
      return { width: bitmap.width, height: bitmap.height, pixel: Array.from(pixel) };
    } finally { bitmap.close(); canvas.width = 0; canvas.height = 0; }
  }, { data: [...bytes], type: mime });
}

test('PDF to Markdown retains usable structure, link annotations and mixed blank-page warnings', async ({ conversionPage: page }) => {
  await selectPdfTool(page, 'text', mixedLayoutPdfFixture(), 'mixed-layout.pdf');
  await convert(page);
  const result = page.getByLabel('转换后的文字', { exact: true });
  await expect(result).toHaveValue(/Document conversion fixture/);
  const text = await result.inputValue();
  expect(text).toContain('# Document conversion fixture');
  expect(text).toContain('| Format | Purpose |');
  expect(text).toContain('```\nfunction convert()');
  expect(text).toContain('- First local task');
  expect(text).toContain('[Read the online guide](https://example.com/conversion-guide)');
  expect(text.indexOf('Left column ends')).toBeLessThan(text.indexOf('Right column begins'));
  await expect(page.locator('.cv-warnings')).toContainText(/第\s*2\s*页没有可提取文字/);
  const output = await outputBytes(page);
  expect(output.name).toBe('mixed-layout.md');
  expect(output.bytes.toString('utf8')).toBe(text);
});

test('PDF to TXT respects selected page order and repeated pages in the saved file', async ({ conversionPage: page }) => {
  await selectPdfTool(page, 'text', pdfFixture(), 'ordered.pdf');
  await page.getByLabel('输出格式').selectOption('text');
  await page.getByLabel('页码范围', { exact: false }).fill('2,1,2');
  await convert(page);
  const result = page.getByLabel('转换后的文字', { exact: true });
  await expect(result).toHaveValue(/Second page paragraph for translation/);
  const text = await result.inputValue();
  const secondPage = 'The result is not statistically significant.';
  const firstPage = 'The bank approved the technical report.';
  expect(text.indexOf(secondPage)).toBeLessThan(text.indexOf(firstPage));
  expect(text.lastIndexOf(secondPage)).toBeGreaterThan(text.indexOf(firstPage));
  expect(text.split(secondPage)).toHaveLength(3);
  expect(text).toContain('\f');
  expect(text).not.toContain('```');
  const output = await outputBytes(page);
  expect(output.name).toBe('ordered.txt');
  expect(output.mime).toContain('text/plain');
  expect(output.bytes.toString('utf8')).toBe(text);
  await expect(page.getByRole('status')).toContainText('已提取 3 页');
});

test('real Chinese Type0 CMap text extracts as Unicode prose without external requests', async ({ conversionPage: page }) => {
  const requests: string[] = [];
  const capture = (request: Request) => { requests.push(request.url()); };
  page.context().on('request', capture);
  try {
    await selectPdfTool(page, 'text', chineseCMapPdfFixture(), '中文阅读.pdf');
    await convert(page);
    const result = page.getByLabel('转换后的文字', { exact: true });
    await expect(result).toHaveValue(CHINESE_FIXTURE_TEXT);
    expect((await outputBytes(page)).bytes.toString('utf8')).toBe(CHINESE_FIXTURE_TEXT);
    expect(requests.filter(url => /^https?:/i.test(url))).toEqual([]);
    await expect(page.getByRole('alert')).toHaveCount(0);
  } finally { page.context().off('request', capture); }
});

test('image-only PDF gives OCR guidance without an empty download and allows retry with text PDF', async ({ conversionPage: page }) => {
  await selectPdfTool(page, 'text', pdfFixture({ blank: true }), 'image-only.pdf');
  await convert(page);
  await expect(page.getByRole('alert')).toContainText('不支持 OCR');
  await expect(page.locator('.cv-download')).toHaveCount(0);
  await expect(page.getByLabel('转换后的文字', { exact: true })).toHaveCount(0);
  await page.locator('#cv-files').setInputFiles({ name: 'recovered.pdf', mimeType: 'application/pdf', buffer: pdfFixture() });
  await convert(page);
  await expect(page.getByLabel('转换后的文字', { exact: true })).toHaveValue(/The bank approved/);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect((await outputBytes(page)).name).toBe('recovered.md');
});

test('incorrect PDF password can be corrected without leaking an old failure or worker', async ({ conversionPage: page }) => {
  await selectPdfTool(page, 'text', pdfFixture({ password: 'open-sesame' }), 'encrypted.pdf');
  await page.getByLabel(/PDF 打开密码/).fill('wrong');
  await convert(page);
  await expect(page.getByRole('alert')).toContainText('正确的密码');
  await expect(page.locator('.cv-download')).toHaveCount(0);
  await page.getByLabel(/PDF 打开密码/).fill('open-sesame');
  await convert(page);
  await expect(page.getByLabel('转换后的文字', { exact: true })).toHaveValue(/The bank approved the technical report/);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect((await outputBytes(page)).name).toBe('encrypted.md');
});

test('PDF to PNG ZIP preserves CropBox, rotation, UserUnit and distinct repeated-page filenames', async ({ conversionPage: page }) => {
  await selectPdfTool(page, 'images', geometryPdfFixture(), 'cropped-rotated.pdf');
  await page.getByLabel('分辨率').selectOption('1');
  await page.getByLabel('页码范围', { exact: false }).fill('1,1');
  await convert(page);
  const output = await outputBytes(page);
  expect(output.name).toBe('cropped-rotated-页面.zip');
  expect(output.mime).toContain('application/zip');
  const entries = zipEntries(output.bytes);
  expect(entries).toHaveLength(2);
  expect(new Set(entries.map(entry => entry.name)).size).toBe(2);
  for (const entry of entries) {
    expect(entry.name).toMatch(/\.png$/);
    expect([...entry.bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(entry.bytes.readUInt32BE(16)).toBe(320);
    expect(entry.bytes.readUInt32BE(20)).toBe(480);
    const image = await decodedImage(page, entry.bytes, 'image/png');
    expect([image.width, image.height]).toEqual([320, 480]);
    expect(image.pixel[3]).toBe(255);
    expect(image.pixel.slice(0, 3).every(channel => channel > 245)).toBe(false);
  }
});

test('PDF to JPEG ZIP produces real JPEG bytes at the requested resolution', async ({ conversionPage: page }) => {
  await selectPdfTool(page, 'images', geometryPdfFixture(), 'jpeg-result.pdf');
  await page.getByLabel('图片格式').selectOption('jpeg');
  await page.getByLabel('分辨率').selectOption('2');
  await convert(page);
  const entries = zipEntries((await outputBytes(page)).bytes);
  expect(entries).toHaveLength(1);
  const entry = entries[0]!;
  expect(entry.name).toMatch(/\.jpg$/);
  expect([...entry.bytes.subarray(0, 3)]).toEqual([255, 216, 255]);
  const image = await decodedImage(page, entry.bytes, 'image/jpeg');
  expect([image.width, image.height]).toEqual([640, 960]);
  expect(image.pixel[3]).toBe(255);
  expect(image.pixel.slice(0, 3).every(channel => channel > 245)).toBe(false);
});

test('out-of-range page selection does not generate a file and can be repaired', async ({ conversionPage: page }) => {
  await selectPdfTool(page, 'text', pdfFixture(), 'range.pdf');
  await page.getByLabel('页码范围', { exact: false }).fill('999');
  await convert(page);
  await expect(page.getByRole('alert')).toContainText('页码超出范围');
  await expect(page.locator('.cv-download')).toHaveCount(0);
  await page.getByLabel('页码范围', { exact: false }).fill('1');
  await convert(page);
  await expect(page.getByLabel('转换后的文字', { exact: true })).toHaveValue(/The bank approved/);
  await expect(page.getByLabel('转换后的文字', { exact: true })).not.toHaveValue(/Second page paragraph/);
});

test('cancelling a pending PDF read and switching tools prevents stale output and supports a new conversion', async ({ conversionPage: page }) => {
  await selectPdfTool(page, 'text', pdfFixture(), 'cancelled.pdf');
  await page.evaluate(() => {
    const native = File.prototype.arrayBuffer;
    const state = globalThis as typeof globalThis & { __releaseConversionPdfRead?: () => Promise<void> };
    File.prototype.arrayBuffer = function () {
      File.prototype.arrayBuffer = native;
      return new Promise<ArrayBuffer>((resolve, reject) => {
        state.__releaseConversionPdfRead = async () => {
          try { resolve(await native.call(this)); } catch (error) { reject(error); }
        };
      });
    };
  });
  await convert(page);
  await expect(page.getByRole('button', { name: '取消', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: /^PDF → 图片/ }).click();
  await page.evaluate(async () => {
    const state = globalThis as typeof globalThis & { __releaseConversionPdfRead?: () => Promise<void> };
    await state.__releaseConversionPdfRead?.();
    delete state.__releaseConversionPdfRead;
  });
  await expect(page.locator('.cv-download')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await selectPdfTool(page, 'text', pdfFixture(), 'new-task.pdf');
  await convert(page);
  await expect(page.getByLabel('转换后的文字', { exact: true })).toHaveValue(/The bank approved/);
  expect((await outputBytes(page)).name).toBe('new-task.md');
});
