import type { Download, Page, Route, TestInfo } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import {
  PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFString,
} from 'pdf-lib';
import { test, expect } from './conversion-browser-fixture';

test.setTimeout(90_000);

type Upload = { name: string; mimeType: string; buffer: Buffer };
type TextRun = { text: string; x: number; y: number; width: number; top: number; bottom: number; baselineSlope: number };
type ReadPage = { width: number; height: number; runs: TextRun[] };

async function prepareDocument(page: Page, source: string, name: string, format: 'markdown' | 'html' | 'text' = 'markdown') {
  await page.getByLabel('输入格式').selectOption(format);
  await page.getByLabel('文档内容').fill(source);
  await page.getByLabel('导出文件名').fill(name);
}

/** Only the primary button is clicked; no result link or browser print API is used. */
async function directDownload(page: Page, info: TestInfo, name: string): Promise<Buffer> {
  const pending = page.waitForEvent('download', { timeout: 60_000 });
  await page.getByRole('button', { name: '下载 PDF', exact: true }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe(`${name}.pdf`);
  const path = info.outputPath(`${name}.pdf`);
  await download.saveAs(path);
  expect(await download.failure()).toBeNull();
  await info.attach(`${name} - direct PDF`, { path, contentType: 'application/pdf' });
  const bytes = await readFile(path);
  expect(bytes.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  await expect(page.getByRole('button', { name: '下载 PDF', exact: true })).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
  return bytes;
}

/** Independent PDF.js inspection of the actual downloaded bytes and embedded ToUnicode text. */
async function readPdf(bytes: Buffer): Promise<ReadPage[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url).href;
  const loading = pdfjs.getDocument({
    data: new Uint8Array(bytes), disableFontFace: true, useSystemFonts: false,
  });
  try {
    const pdf = await loading.promise;
    const result: ReadPage[] = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      try {
        const viewport = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        const runs = content.items.flatMap(item => {
          if (!('str' in item) || !item.str.trim()) return [];
          const style = content.styles[item.fontName];
          const size = Math.hypot(item.transform[2]!, item.transform[3]!);
          const x = item.transform[4]!, y = item.transform[5]!;
          return [{
            text: item.str, x, y, width: item.width, baselineSlope: item.transform[1]!,
            top: y + (style?.ascent ?? 1) * size,
            bottom: y + (style?.descent ?? -0.25) * size,
          }];
        });
        result.push({ width: viewport.width, height: viewport.height, runs });
      } finally { page.cleanup(); }
    }
    return result;
  } finally { await loading.destroy(); }
}

function textOf(pages: ReadPage[]): string {
  return pages.flatMap(page => page.runs.map(run => run.text)).join(' ');
}

function expectTextInsidePages(pages: ReadPage[], marginMm = 0): void {
  const margin = marginMm * 72 / 25.4;
  for (const [index, page] of pages.entries()) {
    expect(page.runs.length, `Page ${index + 1} must contain real selectable text`).toBeGreaterThan(0);
    for (const run of page.runs) {
      const label = `Page ${index + 1}: ${run.text.slice(0, 60)}`;
      expect(run.x, label).toBeGreaterThanOrEqual(margin - 3);
      expect(run.x + run.width, label).toBeLessThanOrEqual(page.width - margin + 3);
      expect(run.bottom, label).toBeGreaterThanOrEqual(margin - 3);
      expect(run.top, label).toBeLessThanOrEqual(page.height - margin + 3);
      expect(Math.abs(run.baselineSlope), `${label} must retain a horizontal baseline`).toBeLessThan(.001);
    }
  }
}

async function roundTripText(page: Page, bytes: Buffer, name: string, format: 'text' | 'markdown' = 'text'): Promise<string> {
  await page.getByRole('navigation', { name: '转换工具' }).getByRole('button', { name: /^PDF → Markdown/ }).click();
  await page.locator('#cv-files').setInputFiles({ name: `${name}.pdf`, mimeType: 'application/pdf', buffer: bytes });
  await page.getByLabel('输出格式').selectOption(format);
  await page.getByRole('button', { name: '开始转换', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已提取');
  await expect(page.getByRole('alert')).toHaveCount(0);
  const result = page.getByLabel('转换后的文字', { exact: true });
  await expect(result).toBeVisible();
  return result.inputValue();
}

function imageCount(pdf: PDFDocument): number {
  const streams = pdf.context.enumerateIndirectObjects().map(([, object]) => object)
    .filter((object): object is PDFRawStream => object instanceof PDFRawStream);
  const masks = new Set<PDFRawStream>();
  for (const stream of streams) {
    const reference = stream.dict.get(PDFName.of('SMask'));
    const mask = reference ? pdf.context.lookup(reference) : undefined;
    if (mask instanceof PDFRawStream) masks.add(mask);
  }
  // A transparent PNG may embed a separate grayscale Image as its soft mask.
  // Resource sharing is measured by the three main attachments, excluding masks.
  return streams.filter(stream => stream.dict.get(PDFName.of('Subtype')) === PDFName.of('Image') && !masks.has(stream)).length;
}

function annotationUrls(pdf: PDFDocument): string[] {
  const urls: string[] = [];
  for (const page of pdf.getPages()) {
    for (const ref of page.node.Annots()?.asArray() ?? []) {
      const annotation = pdf.context.lookup(ref, PDFDict);
      const action = annotation.lookupMaybe(PDFName.of('A'), PDFDict);
      if (action?.get(PDFName.of('S')) !== PDFName.of('URI')) continue;
      const uri = action.lookup(PDFName.of('URI'));
      if (uri instanceof PDFString || uri instanceof PDFHexString) urls.push(uri.decodeText());
    }
  }
  return urls;
}

async function rasterAttachments(page: Page): Promise<Upload[]> {
  const images = await page.evaluate(() => [
    { name: 'transparent.png', mimeType: 'image/png', width: 80, height: 40 },
    { name: 'photo.jpg', mimeType: 'image/jpeg', width: 90, height: 60 },
    { name: 'diagram.webp', mimeType: 'image/webp', width: 72, height: 48 },
  ].map(sample => {
    const canvas = document.createElement('canvas');
    canvas.width = sample.width; canvas.height = sample.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Browser canvas unavailable');
    // The PNG deliberately retains a transparent region.
    if (sample.mimeType !== 'image/png') { context.fillStyle = '#eff6ec'; context.fillRect(0, 0, sample.width, sample.height); }
    context.fillStyle = '#167d65'; context.fillRect(4, 4, sample.width / 2, sample.height / 2);
    const data = canvas.toDataURL(sample.mimeType, 0.94);
    if (!data.startsWith(`data:${sample.mimeType};base64,`)) throw new Error(`Missing browser encoder for ${sample.mimeType}`);
    canvas.width = 0; canvas.height = 0;
    return { name: sample.name, mimeType: sample.mimeType, data: data.slice(data.indexOf(',') + 1) };
  }));
  return images.map(image => ({ name: image.name, mimeType: image.mimeType, buffer: Buffer.from(image.data, 'base64') }));
}

test('direct downloads use the selected A4/Letter orientation, margins and font sizes with bounded real text', async ({ conversionPage: page }, info) => {
  const source = '# 页面布局检验\n\n首段中文文字层必须完整。\n\n'
    + Array.from({ length: 9 }, (_, index) => `LAYOUT${String(index + 1).padStart(3, '0')} 中英混合 reading notes。较窄的版心也必须自动换行，保留每个句子。`).join('\n\n')
    + '\n\nLAYOUT_END 文档结束。';
  for (const settings of [
    { paper: 'A4', direction: 'portrait', margin: 0, font: 8, width: 595.28, height: 841.89, name: 'a4-zero-margin' },
    { paper: 'Letter', direction: 'landscape', margin: 40, font: 24, width: 792, height: 612, name: 'letter-landscape-wide-margin' },
  ]) {
    await prepareDocument(page, source, settings.name);
    await page.getByLabel('纸张').selectOption(settings.paper);
    await page.getByLabel('方向').selectOption(settings.direction);
    await page.getByLabel('边距（mm）', { exact: true }).fill(String(settings.margin));
    await page.getByLabel('字号（pt）', { exact: true }).fill(String(settings.font));
    const bytes = await directDownload(page, info, settings.name);
    const pdf = await PDFDocument.load(bytes);
    for (const pdfPage of pdf.getPages()) {
      expect(pdfPage.getWidth()).toBeCloseTo(settings.width, 1);
      expect(pdfPage.getHeight()).toBeCloseTo(settings.height, 1);
    }
    const pages = await readPdf(bytes);
    expectTextInsidePages(pages, settings.margin);
    const compact = textOf(pages).replace(/\s+/gu, '');
    expect(compact).toContain('首段中文文字层必须完整。');
    expect(compact).toContain('LAYOUT_END文档结束。');
    for (let index = 1; index <= 9; index++) expect(compact).toContain(`LAYOUT${String(index).padStart(3, '0')}`);
  }
});

test('direct HTML PDF preserves inline spacing, rich structures, links and shared raster attachments', async ({ conversionPage: page }, info) => {
  const files = await rasterAttachments(page);
  const link = 'https://example.com/direct-pdf-guide?source=local#reading';
  const source = `<h1>中文结构与图片</h1>
    <p>INLINE_BEGIN plain <strong>bold</strong> and <em>italic</em> end INLINE_END<br>AFTER_BREAK 中文另起一行。</p>
    <ol start="7"><li>SEVEN_LABEL 第七项<ul><li>NESTED_LABEL 嵌套内容</li></ul></li><li>EIGHT_LABEL 第八项</li></ol>
    <ul><li><input type="checkbox" checked>CHECKED_LABEL 已完成</li><li><input type="checkbox">UNCHECKED_LABEL 待完成</li></ul>
    <blockquote>QUOTE_LABEL 清晰的引用。</blockquote>
    <p>SUPSUB_BEGIN H<sub>2</sub>O x<sup>2</sup> SUPSUB_END</p>
    <p><em>ITALIC_BEGIN ${'Long italic text must keep a level baseline. '.repeat(8)} ITALIC_END</em></p>
    <pre><code>MIXED_CODE_BEGIN const 标题 = "中文"; // mixed</code></pre>
    <table><caption>TABLE_CAPTION 合并单元格</caption><thead><tr><th colspan="2">SPAN_HEADER 两列标题</th></tr></thead>
      <tbody><tr><td rowspan="2">ROWSPAN_LABEL 跨两行</td><td>RIGHT_ONE 第一行</td></tr><tr><td>RIGHT_TWO 第二行</td></tr></tbody></table>
    <p><a href="${link}">GUIDE_LINK 阅读来源</a></p>
    <figure><img src="transparent.png" alt="透明本地图"><figcaption>IMAGE_CAPTION 图片说明</figcaption></figure>
    <p><img src="photo.jpg" alt="照片"><img src="diagram.webp" alt="示意图"><img src="transparent.png" alt="重复本地图"></p>
    <p>STRUCTURE_END 所有结构都到达文档结尾。</p>`;
  await prepareDocument(page, source, 'rich-structures', 'html');
  await page.getByLabel('本地图片附件').setInputFiles(files);
  await expect(page.getByText(/已附加 3 张本地图片/)).toBeVisible();
  const bytes = await directDownload(page, info, 'rich-structures');
  const pdf = await PDFDocument.load(bytes);
  expect(imageCount(pdf), 'Three unique raster attachments must be shared across repeated references').toBe(3);
  expect(annotationUrls(pdf)).toContain(link);
  const pages = await readPdf(bytes);
  const raw = textOf(pages), compact = raw.replace(/\s+/gu, '');
  expect(raw.replace(/\s+/gu, ' ')).toContain('plain bold and italic end');
  expect(compact).toContain('H2Ox2');
  expect(raw).toMatch(/7[.)]\s*SEVEN_LABEL/u);
  expect(raw).toMatch(/8[.)]\s*EIGHT_LABEL/u);
  const markers = ['INLINE_BEGIN', 'INLINE_END', 'AFTER_BREAK', 'SEVEN_LABEL', 'NESTED_LABEL', 'EIGHT_LABEL',
    'CHECKED_LABEL', 'UNCHECKED_LABEL', 'QUOTE_LABEL', 'SUPSUB_BEGIN', 'SUPSUB_END', 'TABLE_CAPTION',
    'SPAN_HEADER', 'ROWSPAN_LABEL', 'RIGHT_ONE', 'RIGHT_TWO', 'GUIDE_LINK', 'IMAGE_CAPTION', 'STRUCTURE_END', 'ITALIC_BEGIN', 'ITALIC_END', 'MIXED_CODE_BEGIN'];
  for (const marker of markers) expect(compact).toContain(marker);
  const codePage = pages.find(value => value.runs.some(run => run.text.includes('MIXED_CODE_BEGIN')))!;
  const codeStart = codePage.runs.find(run => run.text.includes('MIXED_CODE_BEGIN'))!;
  expect(codePage.runs.some(run => run.text.includes('标题') && Math.abs(run.y - codeStart.y) < 1)).toBe(true);
  expectTextInsidePages(pages);
  const extracted = await roundTripText(page, bytes, 'rich-structures');
  const recovered = extracted.replace(/\s+/gu, '');
  expect(recovered).toContain('中文结构与图片');
  for (const marker of markers) expect(recovered).toContain(marker);
  await info.attach('direct HTML PDF to TXT round trip', { body: Buffer.from(extracted), contentType: 'text/plain' });
});

test('a single very long code line and oversized table cell paginate without losing first, last or intermediate IDs', async ({ conversionPage: page }, info) => {
  const codeIds = Array.from({ length: 1000 }, (_, index) => `CODE${String(index + 1).padStart(4, '0')}_`);
  const cellIds = Array.from({ length: 180 }, (_, index) => `CELL${String(index + 1).padStart(4, '0')}`);
  const source = '<h1>长内容分页检验</h1><p>DOCUMENT_START 首段。</p><pre><code>CODE_START_'
    + codeIds.join('') + 'CODE_END</code></pre>'
    + '<table><thead><tr><th>长单元格标题</th></tr></thead><tbody><tr><td>CELL_START '
    + cellIds.map(id => `${id} 这个单元格需要完整跨页且保持中文文字。`).join(' ')
    + ' CELL_END</td></tr></tbody></table><p>DOCUMENT_END 所有内容到达结尾。</p>';
  await prepareDocument(page, source, 'long-code-and-cell', 'html');
  const bytes = await directDownload(page, info, 'long-code-and-cell');
  const pdf = await PDFDocument.load(bytes);
  expect(pdf.getPageCount()).toBeGreaterThanOrEqual(3);
  expect(pdf.getPageCount()).toBeLessThan(80);
  const pages = await readPdf(bytes);
  expectTextInsidePages(pages);
  const compact = textOf(pages).replace(/\s+/gu, '');
  for (const marker of ['DOCUMENT_START', 'CODE_START_', 'CODE_END', 'CELL_START', 'CELL_END', 'DOCUMENT_END']) expect(compact).toContain(marker);
  for (const id of [...codeIds, ...cellIds]) expect(compact.split(id).length - 1, `${id} must survive exactly once`).toBe(1);
  const extracted = await roundTripText(page, bytes, 'long-code-and-cell');
  const recovered = extracted.replace(/\s+/gu, '');
  expect(recovered).toContain('DOCUMENT_END');
  for (const id of [codeIds[0]!, codeIds.at(-1)!, cellIds[0]!, cellIds.at(-1)!]) expect(recovered).toContain(id);
});

test('cancelling delayed local font loading prevents late downloads after switching tools and supports a clean retry', async ({ conversionPage: page }, info) => {
  const downloads: Download[] = [];
  const record = (download: Download) => { downloads.push(download); };
  page.on('download', record);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let intercepted = 0;
  const work: Promise<void>[] = [];
  const handler = (route: Route): Promise<void> => {
    intercepted++;
    const task = held.then(async () => { try { await route.continue(); } catch { /* The cancelled request may already have been disposed. */ } });
    work.push(task);
    return task;
  };
  await page.route('**/fonts/**', handler);
  try {
    await prepareDocument(page, '# 旧任务\n\nCANCEL_OLD_FONT_DOWNLOAD', 'cancelled-old-font');
    await page.getByRole('button', { name: '下载 PDF', exact: true }).click();
    await expect.poll(() => intercepted, { timeout: 15_000, message: 'The first direct conversion must request its packaged local font' }).toBeGreaterThan(0);
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('已取消');
    await page.getByRole('navigation', { name: '转换工具' }).getByRole('button', { name: /^PDF → Markdown/ }).click();
    await expect(page.getByRole('heading', { name: 'PDF → Markdown', exact: true })).toBeVisible();
    release();
    await Promise.all(work);
    await page.unroute('**/fonts/**', handler);
    expect(downloads).toHaveLength(0);
    await expect(page.getByRole('link', { name: /^下载 / })).toHaveCount(0);

    await page.getByRole('navigation', { name: '转换工具' }).getByRole('button', { name: /^Markdown → PDF/ }).click();
    await prepareDocument(page, '# 新任务成功\n\nRETRY_ONLY 新文档正常生成。', 'retry-after-cancel');
    const bytes = await directDownload(page, info, 'retry-after-cancel');
    const compact = textOf(await readPdf(bytes)).replace(/\s+/gu, '');
    expect(compact).toContain('RETRY_ONLY新文档正常生成。');
    expect(compact).not.toContain('CANCEL_OLD_FONT_DOWNLOAD');
    expect(downloads.map(download => download.suggestedFilename())).toEqual(['retry-after-cancel.pdf']);
  } finally {
    release();
    await Promise.allSettled(work);
    await page.unroute('**/fonts/**', handler);
    page.off('download', record);
  }
});

test('unsupported emoji shows a visible warning while the remaining Chinese and English text still downloads', async ({ conversionPage: page }, info) => {
  await prepareDocument(page, '# 缺字处理检验\n\nEMOJI_BEFORE 中文前文 🌿 中文后文 EMOJI_AFTER\n\nEMOJI_END 文档正常结束。', 'missing-glyph');
  const bytes = await directDownload(page, info, 'missing-glyph');
  await expect(page.locator('.cv-warnings')).toBeVisible();
  await expect(page.locator('.cv-warnings')).toContainText(/字形|字体|字符|表情|emoji/iu);
  const pages = await readPdf(bytes);
  const compact = textOf(pages).replace(/\s+/gu, '');
  expect(compact).toContain('EMOJI_BEFORE中文前文');
  expect(compact).toContain('中文后文EMOJI_AFTER');
  expect(compact).toContain('EMOJI_END文档正常结束。');
  expectTextInsidePages(pages);
  await expect(page.getByRole('alert')).toHaveCount(0);
});
