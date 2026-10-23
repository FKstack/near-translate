import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import { test, expect } from './conversion-browser-fixture';

const PREVIEW = 'iframe[title="文档预览"]';

async function downloadPdf(page: Page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载 PDF', exact: true }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toMatch(/\.pdf$/i);
  expect(await download.failure()).toBe(null);
  const file = await download.path();
  expect(file).not.toBe(null);
  const pdfBytes = await readFile(file!);
  expect(pdfBytes.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  await expect(page.getByRole('button', { name: '下载 PDF', exact: true })).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.locator('.cv-document-preview > summary').click();
  await expect(page.locator(PREVIEW)).toBeVisible();
  return { preview: page.frameLocator(PREVIEW), pdfBytes };
}

async function generate(page: Page, source: string, format: 'markdown' | 'html' | 'text' = 'markdown') {
  await page.getByLabel('输入格式').selectOption(format);
  await page.getByLabel('文档内容').fill(source);
  return downloadPdf(page);
}

async function downloadHtml(page: Page, name: string): Promise<string> {
  const pending = page.waitForEvent('download');
  await page.getByRole('link', { name: `下载 ${name}.html`, exact: false }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe(`${name}.html`);
  expect(await download.failure()).toBe(null);
  const file = await download.path();
  expect(file).not.toBe(null);
  return readFile(file!, 'utf8');
}

test('Markdown downloads a real PDF and retains headings, lists, GFM tables and literal code in the optional preview', async ({ conversionPage: page }) => {
  const { preview } = await generate(page, '# 阅读记录\n\n## 本周安排\n\n'
    + '- 阅读文档\n- 整理笔记\n\n- [x] 已核对\n- [ ] 待补充\n\n'
    + '| 格式 | 用途 |\n| :--- | ---: |\n| Markdown | 可编辑 |\n| PDF | 便于分享 |\n\n'
    + '```js\nconst literal = "<script>不能执行</script>";\nconsole.log(literal);\n```');
  await expect(preview.getByRole('heading', { name: '阅读记录', exact: true })).toBeVisible();
  await expect(preview.getByRole('heading', { name: '本周安排', exact: true })).toBeVisible();
  await expect(preview.getByRole('listitem')).toHaveCount(4);
  await expect(preview.getByRole('table')).toHaveCount(1);
  await expect(preview.getByRole('columnheader')).toHaveText(['格式', '用途']);
  await expect(preview.getByRole('cell')).toHaveText(['Markdown', '可编辑', 'PDF', '便于分享']);
  await expect(preview.locator('pre code')).toHaveText('const literal = "<script>不能执行</script>";\nconsole.log(literal);\n');
  await expect(preview.locator('main script')).toHaveCount(0);
  await expect(preview.getByRole('checkbox')).toHaveCount(2);
  await expect(preview.getByRole('checkbox').nth(0)).toBeChecked();
  await expect(preview.getByRole('checkbox').nth(1)).not.toBeChecked();
  await expect(preview.getByRole('checkbox').nth(0)).toBeDisabled();
});

for (const fixture of [
  { name: '中文导入.md', format: 'markdown', source: '# 中文文档 🌿\n\n清新自然的 UTF-8 内容。\n\n- 第一项\n- 第二项\n' },
  { name: '纯文本导入.txt', format: 'text', source: '中文文本 🌿\n\n<h1>保持为文字</h1> & 不执行标签\n  保留缩进\n' },
] as const) {
  test(`UTF-8 file import preserves Chinese content and selects the matching format: ${fixture.name}`, async ({ conversionPage: page }) => {
    await page.locator('#cv-files').setInputFiles({
      name: fixture.name, mimeType: 'text/plain', buffer: Buffer.from(`\uFEFF${fixture.source}`, 'utf8'),
    });
    await expect(page.getByRole('status')).toContainText(`已载入 ${fixture.name}`);
    await expect(page.getByLabel('文档内容')).toHaveValue(fixture.source);
    await expect(page.getByLabel('输入格式')).toHaveValue(fixture.format);
    const basename = fixture.name.replace(/\.[^.]+$/, '');
    await expect(page.getByLabel('导出文件名')).toHaveValue(basename);
    const { preview } = await downloadPdf(page);
    if (fixture.format === 'markdown') {
      await expect(preview.getByRole('heading', { name: '中文文档 🌿', exact: true })).toBeVisible();
      await expect(preview.getByRole('listitem')).toHaveText(['第一项', '第二项']);
    } else {
      expect(await preview.locator('main pre').textContent()).toBe(fixture.source);
      await expect(preview.locator('main h1')).toHaveCount(0);
    }
    const exported = await downloadHtml(page, basename);
    expect(exported).toContain('中文');
    expect(exported).toContain('🌿');
    expect(exported).not.toContain('\uFFFD');
    expect(exported).toContain('<meta charset="utf-8">');
  });
}

test('a selected PNG attachment is decoded in preview and embedded as a portable data URL in downloaded HTML', async ({ conversionPage: page }) => {
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 32;
    const painter = canvas.getContext('2d')!;
    painter.fillStyle = '#e8f3e9'; painter.fillRect(0, 0, 64, 32);
    painter.fillStyle = '#328670'; painter.fillRect(8, 8, 24, 16);
    return canvas.toDataURL('image/png');
  });
  const imageBytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  await page.getByLabel('文档内容').fill('# 图文记录\n\n![本地绿叶图片](./images/leaf.png)\n\n图片来自所选附件。');
  await page.getByLabel('本地图片附件').setInputFiles({ name: 'leaf.png', mimeType: 'image/png', buffer: imageBytes });
  await expect(page.getByText(/已附加 1 张本地图片/)).toBeVisible();
  await page.getByLabel('导出文件名').fill('图文记录');
  const { preview } = await downloadPdf(page);
  const image = preview.getByRole('img', { name: '本地绿叶图片', exact: true });
  await expect(image).toHaveAttribute('src', dataUrl);
  await expect(image).toHaveJSProperty('naturalWidth', 64);
  await expect(image).toHaveJSProperty('naturalHeight', 32);
  const exported = await downloadHtml(page, '图文记录');
  expect(exported).toContain(`src="${dataUrl}"`);
  expect(exported).toContain('alt="本地绿叶图片"');
  expect(exported).not.toContain('src="./images/leaf.png"');
  expect(exported).not.toContain('src="blob:');
});

test('HTML preview and download remove scripts, events and remote images without making external requests', async ({ conversionPage: page }) => {
  const attemptedRequests: string[] = [];
  page.on('request', request => {
    if (request.url().startsWith('https://never-load.invalid/')) attemptedRequests.push(request.url());
  });
  await page.getByLabel('导出文件名').fill('安全正文');
  const { preview } = await generate(page, `<h1>安全正文</h1>
    <p onclick="window.__conversionUnsafe=true" style="background:url(https://never-load.invalid/style.png)">保留这段文字。</p>
    <script>window.__conversionUnsafe=true</script>
    <iframe src="https://never-load.invalid/frame"></iframe>
    <img src="https://never-load.invalid/image.png" alt="未加载的网络图片" onerror="window.__conversionUnsafe=true">
    <svg onload="window.__conversionUnsafe=true"><foreignObject>危险嵌入</foreignObject></svg>
    <a href="javascript:window.__conversionUnsafe=true">危险链接</a>
    <a href="https://example.com/reading" ping="https://never-load.invalid/ping">阅读来源</a>
    <a href="#section">页内链接</a><h2 id="section">补充说明</h2>`, 'html');
  await expect(preview.getByRole('heading', { name: '安全正文', exact: true })).toBeVisible();
  await expect(preview.getByText('保留这段文字。', { exact: true })).toBeVisible();
  await expect(preview.locator('main script,main style,main iframe,main svg,main img,[onclick],[onerror],[onload],[style],[ping]')).toHaveCount(0);
  await expect(preview.getByText('危险链接', { exact: true })).not.toHaveAttribute('href');
  await expect(preview.getByRole('link', { name: '阅读来源', exact: true })).toHaveAttribute('target', '_blank');
  await expect(preview.getByRole('link', { name: '阅读来源', exact: true })).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(preview.getByRole('link', { name: '页内链接', exact: true })).not.toHaveAttribute('target');
  await expect(preview.getByText('[图片未包含：未加载的网络图片]', { exact: true })).toBeVisible();
  await expect(page.locator('.cv-warnings')).toContainText('不会自动加载网络图片');
  const exported = await downloadHtml(page, '安全正文');
  expect(exported).not.toMatch(/<script\b|<iframe\b|<svg\b|\bon(?:click|load|error)\s*=/i);
  expect(exported).not.toContain('never-load.invalid');
  expect(exported).not.toContain('__conversionUnsafe');
  expect(attemptedRequests).toEqual([]);
});

test('one-click multi-page A4 PDF download preserves Chinese prose, every table row and code line through PDF to Markdown', async ({ conversionPage: page }, testInfo) => {
  const tableIds = Array.from({ length: 40 }, (_, index) => `TABLE${String(index + 1).padStart(3, '0')}`);
  const codeIds = Array.from({ length: 60 }, (_, index) => `CODELINE${String(index + 1).padStart(3, '0')}`);
  const paragraphIds = Array.from({ length: 8 }, (_, index) => String(index + 1).padStart(3, '0'));
  const paragraph = '阅读者应能完整阅读跨页的说明、表格和代码，每一段文字都应保留下来。';
  const source = '# 中文打印验证\n\n首段完整性验证：本机字体显示中文内容，不需要下载外部字体。\n\n'
    + '- 第一项\n- 第二项\n\n## 跨页表格\n\n| 项目 | 说明 |\n| --- | --- |\n'
    + tableIds.map((id, index) => `| ${id} | 表格验证第${String(index + 1).padStart(3, '0')}行 |`).join('\n')
    + '\n\n## 跨页代码\n\n```js\n'
    + codeIds.map((id, index) => `const ${id} = "代码验证${String(index + 1).padStart(3, '0')}";`).join('\n')
    + '\n```\n\n## 连续正文\n\n'
    + paragraphIds.map(id => `正文段落${id}开始。${paragraph.repeat(3)}正文段落${id}结束。`).join('\n\n')
    + '\n\n末段完整性验证：所有内容已经到达文档结尾。';
  await page.getByLabel('导出文件名').fill('打印验证');
  await page.getByLabel('纸张').selectOption('A4');
  await page.getByLabel('方向').selectOption('portrait');
  const { preview, pdfBytes } = await generate(page, source);
  await expect(preview.getByRole('heading', { name: '中文打印验证', exact: true })).toBeVisible();
  const pdf = await PDFDocument.load(pdfBytes);
  expect(pdf.getPageCount()).toBeGreaterThanOrEqual(2);
  for (const pdfPage of pdf.getPages()) {
    const { width, height } = pdfPage.getSize();
    expect(Math.abs(width - 595.28)).toBeLessThan(1);
    expect(Math.abs(height - 841.89)).toBeLessThan(1);
  }
  await testInfo.attach('Markdown 直接下载 A4 PDF', { body: pdfBytes, contentType: 'application/pdf' });

  // Re-upload the exact PDF downloaded by the extension, rather than a
  // synthetic fixture or a PDF generated by Playwright's print API.
  await page.getByRole('button', { name: 'PDF → Markdown', exact: false }).click();
  await page.locator('#cv-files').setInputFiles({ name: '打印验证.pdf', mimeType: 'application/pdf', buffer: pdfBytes });
  await page.getByLabel('输出格式').selectOption('markdown');
  await expect(page.getByRole('button', { name: '开始转换', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '开始转换', exact: true }).click();
  await expect(page.getByRole('status')).toContainText(`已提取 ${pdf.getPageCount()} 页的文字`);
  await expect(page.getByRole('alert')).toHaveCount(0);
  const extracted = await page.getByLabel('转换后的文字').inputValue();
  const compact = extracted.replace(/\s+/gu, '');
  expect(compact).toContain('中文打印验证');
  expect(compact).toContain('本机字体');
  expect(compact).toContain('首段完整性验证：本机字体显示中文内容，不需要下载外部字体。');
  expect(compact).toContain('末段完整性验证：所有内容已经到达文档结尾。');
  for (const id of tableIds) expect(compact, `PDF table row ${id} must survive extraction`).toContain(id);
  for (const id of codeIds) expect(compact, `PDF code line ${id} must survive extraction`).toContain(id);
  for (const id of paragraphIds) {
    expect(compact).toContain(`正文段落${id}开始。`);
    expect(compact).toContain(`正文段落${id}结束。`);
  }
  expect(compact.split('每一段文字都应保留下来。').length - 1).toBe(paragraphIds.length * 3);
  await testInfo.attach('直接下载 PDF 回提取 Markdown', { body: Buffer.from(extracted, 'utf8'), contentType: 'text/markdown' });
});

test('a 360px viewport keeps both conversion controls and long document content inside their horizontal bounds', async ({ conversionPage: page }, testInfo) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const longToken = 'document-content-'.repeat(24);
  const { preview } = await generate(page, `# 窄屏文档\n\n[很长的文档链接](https://example.com/${longToken})\n\n`
    + `| 很长的第一列 | 第二列 |\n| --- | --- |\n| ${longToken} | 自适应表格 |\n\n`
    + `\`\`\`txt\n${longToken}\n\`\`\``);
  await expect(preview.getByRole('heading', { name: '窄屏文档', exact: true })).toBeVisible();
  const outer = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth, width: document.documentElement.scrollWidth,
  }));
  expect(outer.width).toBeLessThanOrEqual(outer.viewport + 1);
  const inner = await preview.locator('html').evaluate(element => ({
    viewport: element.clientWidth, width: element.scrollWidth,
  }));
  expect(inner.viewport).toBeGreaterThan(100);
  expect(inner.width).toBeLessThanOrEqual(inner.viewport + 1);
  await testInfo.attach('360px 文档转换界面', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
});
