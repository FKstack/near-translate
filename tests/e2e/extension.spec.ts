import { test, expect, chromium, type BrowserContext, type Page, type Worker, type Frame } from '@playwright/test';
import { readFile, mkdtemp, realpath, rm } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { pdfFixture } from './pdf-fixture';

const BASE = 'http://127.0.0.1:4177';
type CapturedRequest = { selectedText: string; context?: string; model: string; thinking: { type: string } };
let context: BrowserContext;
let worker: Worker;
let extensionId: string;
let profile: string;
let options: Page;
let page: Page;

async function installFakeApi(background: Worker): Promise<void> {
  await background.evaluate(() => {
    const global = globalThis as typeof globalThis & {
      __nearTest: { requests: Array<Record<string, unknown>>; cancellations: number; failNext: boolean };
    };
    const nativeFetch = global.fetch.bind(global);
    global.__nearTest = { requests: [], cancellations: 0, failNext: false };
    global.fetch = async function (this: typeof globalThis, input, init) {
      // Match the native WorkerGlobalScope receiver contract; arrow mocks hide illegal invocations.
      if (this !== globalThis) throw new TypeError("Failed to execute 'fetch' on 'WorkerGlobalScope': Illegal invocation");
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith('https://api.deepseek.com/')) return nativeFetch(input, init);
      const request = JSON.parse(String(init?.body));
      const envelope = JSON.parse(request.messages[1].content);
      global.__nearTest.requests.push({ ...envelope, model: request.model, thinking: request.thinking });
      if (global.__nearTest.failNext) {
        global.__nearTest.failNext = false;
        return new Response('{}', { status: 503 });
      }
      const word = request.response_format?.type === 'json_object';
      const translated = word ? JSON.stringify({
        translation: envelope.selectedText === 'bank' ? '银行' : envelope.selectedText === 'scheduler' ? '调度器' : '准确性',
        partOfSpeech: '名词',
        explanation: envelope.selectedText === 'bank' ? '此处指金融机构。' : '此处采用技术文档中的常见词义。',
      }) : envelope.selectedText.startsWith('Render translated HTML')
        ? '<img src=x onerror="window.translationExecuted=true">译文保持纯文本。'
        : envelope.selectedText.startsWith('Slow selection') ? '旧请求部分译文；旧请求最终译文。'
        : '并发并不意味着并行。\n\n在 0.05 水平下，结果不具有统计学显著性。';
      const encoder = new TextEncoder();
      const event = (content: string | null, finish_reason: string | null = null) =>
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason }] })}\n\n`;
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(sink) {
          const boundary = word ? 7 : 9;
          sink.enqueue(encoder.encode(event(translated.slice(0, boundary))));
          timer = setTimeout(() => {
            if (done) return;
            done = true;
            sink.enqueue(encoder.encode(event(translated.slice(boundary)) + event(null, 'stop') + 'data: [DONE]\n\n'));
            sink.close();
          }, envelope.selectedText.startsWith('Slow selection') ? 1_500 : word ? 80 : 700);
          init?.signal?.addEventListener('abort', () => {
            if (done) return;
            done = true; clearTimeout(timer); global.__nearTest.cancellations++;
            sink.error(new DOMException('Aborted', 'AbortError'));
          }, { once: true });
        },
        cancel() { done = true; clearTimeout(timer); },
      });
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
    };
  });
}

async function requests(): Promise<CapturedRequest[]> {
  return worker.evaluate(() => (globalThis as unknown as { __nearTest: { requests: CapturedRequest[] } }).__nearTest.requests);
}

async function saveSettings(values: { key?: string; enabled?: boolean; includeContext?: boolean; removeKey?: boolean } = {}): Promise<void> {
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await expect(options.getByRole('button', { name: '保存设置', exact: true })).toBeEnabled();
  if (values.removeKey) await options.getByRole('button', { name: '删除已保存的 Key' }).click();
  if (values.key !== undefined) await options.getByLabel('DeepSeek API Key', { exact: true }).fill(values.key);
  if (values.enabled !== undefined) await options.getByLabel('启用翻译', { exact: true }).setChecked(values.enabled);
  if (values.includeContext !== undefined) await options.getByLabel('附带所在句或附近一句上下文，提高词义判断准确度').setChecked(values.includeContext);
  await options.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(options.getByRole('status')).toContainText('设置已保存');
}

async function selectElement(surface: Page | Frame, selector: string): Promise<void> {
  await surface.locator(selector).first().scrollIntoViewIfNeeded();
  await surface.locator(selector).first().evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = document.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    const rect = element.getBoundingClientRect();
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true, clientX: rect.right - 4, clientY: rect.bottom - 4 }));
  });
  await expect(surface.getByRole('button', { name: '翻译选中的英文' })).toBeVisible();
}

test.beforeAll(async () => {
  const extension = resolve('.output/e2e-extension');
  profile = await mkdtemp(resolve('.output/e2e-profile-'));
  const channel = process.env.NEAR_BROWSER_CHANNEL ?? 'chromium';
  const executablePath = process.env.NEAR_BROWSER_EXECUTABLE;
  const brandedBrowser = channel !== 'chromium' || !!executablePath;
  context = await chromium.launchPersistentContext(profile, {
    channel, executablePath, headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    viewport: { width: 1280, height: 900 },
    args: brandedBrowser ? ['--enable-unsafe-extension-debugging'] : [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  if (brandedBrowser) {
    const browser = context.browser();
    if (!browser) throw new Error('No browser connection available to load the isolated test extension.');
    const debug = await browser.newBrowserCDPSession();
    await debug.send('Extensions.loadUnpacked', { path: extension });
    await debug.detach();
  }
  console.log(`Extension E2E browser: ${channel} ${context.browser()?.version() ?? ''}`);
  await context.route('https://api.deepseek.com/**', route => route.abort('blockedbyclient'));
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  extensionId = new URL(worker.url()).host;
  await installFakeApi(worker);
  options = await context.newPage();
});

test.beforeEach(async () => {
  for (const openPage of context.pages()) if (openPage !== options) await openPage.close();
  await worker.evaluate(() => {
    const state = (globalThis as unknown as { __nearTest: { requests: unknown[]; cancellations: number; failNext: boolean } }).__nearTest;
    state.requests = []; state.cancellations = 0; state.failNext = false;
  });
  await saveSettings({ key: 'fake-test-key', enabled: true, includeContext: true });
  page = await context.newPage();
  await page.goto(BASE);
  await expect(page.locator('near-translate')).toHaveCount(1);
});

test.afterAll(async () => {
  await context?.close();
  if (profile) {
    const workspace = await realpath('.');
    const actual = await realpath(profile);
    if (!relative(workspace, actual).startsWith('.output\\e2e-profile-') && !relative(workspace, actual).startsWith('.output/e2e-profile-')) {
      throw new Error('Refuse to remove an E2E profile outside workspace .output.');
    }
    await rm(actual, { recursive: true, force: true });
  }
});

test('production keeps website permissions optional', async () => {
  const production = JSON.parse(await readFile(resolve('.output/chrome-mv3/manifest.json'), 'utf8'));
  expect(production.optional_host_permissions).toEqual(expect.arrayContaining(['http://*/*', 'https://*/*']));
  expect(production.host_permissions).not.toContain('http://*/*');
  expect(production.host_permissions).not.toContain('https://*/*');
  expect(production.permissions).not.toContain('tabs');
});

test('double-click word translates with context, copy and close', async ({}, testInfo) => {
  await page.locator('#bank').dblclick();
  const trigger = page.getByRole('button', { name: '翻译选中的英文' });
  await expect(trigger).toBeVisible();
  expect(await requests()).toEqual([]);
  await trigger.click();
  await expect(page.locator('.nt-word')).toHaveText('银行');
  await expect(page.locator('.nt-pos')).toHaveText('名词');
  await expect(page.locator('.nt-explanation')).toContainText('金融机构');
  expect((await requests())[0]).toMatchObject({ selectedText: 'bank', context: 'The bank approved the technical report.', model: 'deepseek-flash', thinking: { type: 'disabled' } });
  await page.screenshot({ path: testInfo.outputPath('web-word-card.png'), fullPage: true });
  await page.getByRole('button', { name: '复制', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已复制译文');
  await page.getByRole('button', { name: '关闭翻译' }).click();
  await expect(page.getByRole('dialog', { name: '英文翻译结果' })).toHaveCount(0);
});

test('paragraph streams and preserves paragraph breaks', async () => {
  await selectElement(page, '#paragraph');
  await page.getByRole('button', { name: '翻译选中的英文' }).click();
  await expect(page.locator('.nt-text')).toHaveText('并发并不意味着并行');
  await expect(page.getByRole('button', { name: '复制', exact: true })).toBeVisible();
  await expect(page.locator('.nt-text')).toHaveText('并发并不意味着并行。\n\n在 0.05 水平下，结果不具有统计学显著性。');
  expect((await requests())[0]?.selectedText).toContain('Concurrency does not imply parallelism.');
});

test('context switch removes context from the request and settings show Flash', async ({}, testInfo) => {
  await saveSettings({ includeContext: false });
  await expect(options.getByLabel('模型名')).toHaveValue('deepseek-flash');
  await options.screenshot({ path: testInfo.outputPath('options.png'), fullPage: true });
  await page.locator('#bank').dblclick();
  await page.getByRole('button', { name: '翻译选中的英文' }).click();
  await expect(page.locator('.nt-word')).toHaveText('银行');
  expect((await requests())[0]).not.toHaveProperty('context');
});

test('disable closes the current overlay and prevents selection buttons', async () => {
  await page.locator('#bank').dblclick();
  await expect(page.getByRole('button', { name: '翻译选中的英文' })).toBeVisible();
  await saveSettings({ enabled: false });
  await expect(page.getByRole('button', { name: '翻译选中的英文' })).toHaveCount(0);
  await page.locator('#paragraph').dblclick();
  await expect(page.getByRole('button', { name: '翻译选中的英文' })).toHaveCount(0);
  expect(await requests()).toEqual([]);
});

test('website-access revocation broadcast closes existing web overlays while PDF translation remains available', async () => {
  await page.locator('#bank').dblclick();
  await expect(page.getByRole('button', { name: '翻译选中的英文' })).toBeVisible();
  const reader = await context.newPage();
  await reader.goto(`chrome-extension://${extensionId}/reader.html`);
  await expect(reader.getByRole('button', { name: '打开本地 PDF', exact: true })).toBeEnabled();
  await reader.getByLabel('选择本地 PDF 文件').setInputFiles({ name: 'offline-document.pdf', mimeType: 'application/pdf', buffer: pdfFixture() });
  await expect(reader.locator('.textLayer').first()).toContainText('The bank');
  // The E2E copy grants hosts at installation; exercise the exact public-settings
  // broadcast used after a real optional permission revocation in production.
  await worker.evaluate(async () => {
    const extension = (globalThis as unknown as { chrome: {
      tabs: { query: (filter: object) => Promise<Array<{ id?: number }>>; sendMessage: (id: number, message: object) => Promise<unknown> };
      runtime: { sendMessage: (message: object) => Promise<unknown> };
    } }).chrome;
    const message = { type: 'settings-changed', settings: { enabled: true, includeContext: true, model: 'deepseek-flash', hasApiKey: true, webAccess: false } };
    const tabs = await extension.tabs.query({});
    await Promise.allSettled([
      extension.runtime.sendMessage(message),
      ...tabs.filter(tab => tab.id !== undefined).map(tab => extension.tabs.sendMessage(tab.id!, message)),
    ]);
  });
  await expect(page.getByRole('button', { name: '翻译选中的英文' })).toHaveCount(0);
  await page.locator('#bank').dblclick();
  await expect(page.getByRole('button', { name: '翻译选中的英文' })).toHaveCount(0);
  await selectElement(reader, '.textLayer span');
  await reader.getByRole('button', { name: '翻译选中的英文' }).click();
  await expect(reader.getByRole('button', { name: '复制', exact: true })).toBeVisible();
  expect((await requests())[0]?.selectedText).toContain('The bank');
});

test('authorized iframe selections translate in their own document', async () => {
  const frame = page.frameLocator('iframe');
  await frame.locator('#frame-word').dblclick();
  await expect(frame.getByRole('button', { name: '翻译选中的英文' })).toBeVisible();
  await frame.getByRole('button', { name: '翻译选中的英文' }).click();
  await expect(frame.locator('.nt-word')).toHaveText('调度器');
  expect((await requests())[0]?.selectedText).toBe('scheduler');
});

test('missing key offers settings and sends no request', async () => {
  await saveSettings({ removeKey: true });
  await page.locator('#bank').dblclick();
  await page.getByRole('button', { name: '翻译选中的英文' }).click();
  await expect(page.getByRole('alert')).toContainText('填写 DeepSeek API Key');
  await expect(page.getByRole('button', { name: '打开设置' })).toBeVisible();
  expect(await requests()).toEqual([]);
});

test('new selection cancels old work and old output cannot replace new result', async () => {
  await selectElement(page, '#slow');
  await page.getByRole('button', { name: '翻译选中的英文' }).click();
  await expect(page.locator('.nt-text')).toContainText('旧请求部分');
  await page.locator('#bank').dblclick();
  await page.getByRole('button', { name: '翻译选中的英文' }).click();
  await expect(page.locator('.nt-word')).toHaveText('银行');
  await expect.poll(() => worker.evaluate(() => (globalThis as unknown as { __nearTest: { cancellations: number } }).__nearTest.cancellations)).toBeGreaterThanOrEqual(1);
  // Cancellation releases the delayed response timer; the completed new result stays visible.
  await expect(page.locator('.nt-word')).toHaveText('银行');
  expect((await requests()).map(request => request.selectedText)).toEqual(['Slow selection must never overwrite a newer translation.', 'bank']);
});

test('provider HTML output stays inert and temporary failure offers retry', async () => {
  await selectElement(page, '#inert');
  await page.getByRole('button', { name: '翻译选中的英文' }).click();
  await expect(page.getByRole('button', { name: '复制', exact: true })).toBeVisible();
  await expect(page.locator('.nt-text')).toContainText('<img src=x');
  await expect(page.locator('.nt-card img')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { translationExecuted?: boolean }).translationExecuted)).toBeUndefined();
  await page.getByRole('button', { name: '关闭翻译' }).click();
  await worker.evaluate(() => { (globalThis as unknown as { __nearTest: { failNext: boolean } }).__nearTest.failNext = true; });
  await selectElement(page, '#retry');
  await page.getByRole('button', { name: '翻译选中的英文' }).click();
  await expect(page.getByRole('alert')).toContainText('HTTP 503');
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByRole('button', { name: '复制', exact: true })).toBeVisible();
});

test('editable selection and viewport-edge overlay remain usable', async () => {
  await page.locator('#editable').evaluate((element: HTMLTextAreaElement) => {
    element.focus(); element.setSelectionRange(4, 13);
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 600, clientY: 660 }));
  });
  await page.getByRole('button', { name: '翻译选中的英文' }).click();
  await expect(page.locator('.nt-word')).toHaveText('调度器');
  await page.getByRole('button', { name: '关闭翻译' }).click();
  await page.locator('#edge-word').dblclick();
  await page.getByRole('button', { name: '翻译选中的英文' }).click();
  await expect(page.locator('.nt-word')).toHaveText('准确性');
  const box = await page.getByRole('dialog', { name: '英文翻译结果' }).boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(1280); expect(box!.y + box!.height).toBeLessThanOrEqual(900);
});

test('local PDF text layer translates, zooms, searches, and changes pages', async ({}, testInfo) => {
  await page.goto(`chrome-extension://${extensionId}/reader.html`);
  await expect(page.getByRole('button', { name: '打开本地 PDF', exact: true })).toBeEnabled();
  await page.getByLabel('选择本地 PDF 文件').setInputFiles({ name: 'technical-document.pdf', mimeType: 'application/pdf', buffer: pdfFixture() });
  await expect(page.locator('.textLayer').first()).toContainText('The bank approved the technical report.');
  await page.getByLabel('PDF 缩放').selectOption('1');
  await expect(page.getByLabel('PDF 缩放')).toHaveValue('1');
  await page.getByLabel('搜索文档', { exact: true }).fill('technical');
  await expect(page.locator('.reader-match-count')).toContainText('1 / 1');
  await page.getByLabel('搜索文档', { exact: true }).fill('');
  await selectElement(page, '.textLayer span');
  await page.getByRole('button', { name: '翻译选中的英文' }).click();
  await expect(page.getByRole('button', { name: '复制', exact: true })).toBeVisible();
  await expect(page.locator('.nt-meta')).toContainText('PDF');
  await page.screenshot({ path: testInfo.outputPath('pdf-reader-card.png'), fullPage: true });
  await page.getByRole('button', { name: '关闭翻译' }).click();
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(page.getByLabel('页码', { exact: true })).toHaveValue('2');
  await expect(page.locator('.textLayer').nth(1)).toContainText('Scientific evidence requires reproducible experiments.');
  await page.getByRole('button', { name: '上一页', exact: true }).click();
  await expect(page.getByLabel('页码', { exact: true })).toHaveValue('1');
  await page.locator('.page[data-page-number="2"] .textLayer span').last().scrollIntoViewIfNeeded();
  await page.evaluate(async () => {
    const start = document.querySelector('.page[data-page-number="1"] .textLayer span')?.firstChild;
    const endElement = Array.from(document.querySelectorAll('.page[data-page-number="2"] .textLayer span')).at(-1);
    const end = endElement?.firstChild;
    if (!start || !end || !endElement) throw new Error('Both PDF pages must have selectable text layers.');
    const range = document.createRange(); range.setStart(start, 0); range.setEnd(end, end.textContent?.length ?? 0);
    const selection = document.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const rect = endElement.getBoundingClientRect();
    endElement.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: rect.right - 4, clientY: rect.bottom - 4 }));
  });
  const crossPageTrigger = page.getByRole('button', { name: '翻译选中的英文' });
  await expect(crossPageTrigger).toBeVisible();
  const buttonPosition = await crossPageTrigger.boundingBox();
  if (!buttonPosition) throw new Error('Cross-page PDF selection must show a translation button.');
  await page.mouse.click(buttonPosition.x + buttonPosition.width / 2, buttonPosition.y + buttonPosition.height / 2);
  await expect(page.getByRole('button', { name: '复制', exact: true })).toBeVisible();
  const crossPage = (await requests()).at(-1)?.selectedText;
  expect(crossPage).toContain('The bank approved');
  expect(crossPage).toContain('Second page paragraph for translation.');
});

test('reader reports damaged and image-only files and can recover with a valid local file', async () => {
  await page.goto(`chrome-extension://${extensionId}/reader.html`);
  await expect(page.getByRole('button', { name: '打开本地 PDF', exact: true })).toBeEnabled();
  const file = page.getByLabel('选择本地 PDF 文件');
  await file.setInputFiles({ name: 'broken.pdf', mimeType: 'application/pdf', buffer: Buffer.from('not a PDF') });
  await expect(page.getByRole('alert')).toContainText('PDF');
  await file.setInputFiles({ name: 'image-only.pdf', mimeType: 'application/pdf', buffer: pdfFixture({ blank: true }) });
  await expect(page.getByRole('status')).toContainText('暂不支持 OCR');
  await file.setInputFiles({ name: 'recovered.pdf', mimeType: 'application/pdf', buffer: pdfFixture() });
  await expect(page.locator('.textLayer').first()).toContainText('The bank');
  await expect(page.locator('.reader-no-text')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('password PDF handles incorrect input, successful unlock, and cancellation', async () => {
  await page.goto(`chrome-extension://${extensionId}/reader.html`);
  await expect(page.getByRole('button', { name: '打开本地 PDF', exact: true })).toBeEnabled();
  const file = page.getByLabel('选择本地 PDF 文件');
  const encrypted = { name: 'password.pdf', mimeType: 'application/pdf', buffer: pdfFixture({ password: 'open-sesame' }) };
  await file.setInputFiles(encrypted);
  await expect(page.getByRole('dialog', { name: '解锁 PDF' })).toBeVisible();
  await page.getByLabel('PDF 密码', { exact: true }).fill('wrong');
  await page.getByRole('button', { name: '解锁', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '解锁 PDF' })).toContainText('密码不正确');
  await page.getByLabel('PDF 密码', { exact: true }).fill('open-sesame');
  await page.getByRole('button', { name: '解锁', exact: true }).click();
  await expect(page.locator('.textLayer').first()).toContainText('The bank');
  await file.setInputFiles(encrypted);
  await expect(page.getByRole('dialog', { name: '解锁 PDF' })).toBeVisible();
  await page.getByRole('dialog', { name: '解锁 PDF' }).getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '解锁 PDF' })).toHaveCount(0);
  await expect(page.locator('.reader-welcome')).toBeVisible();
});

test('online PDF opens with granted host access and shows local fallback on download failure', async () => {
  await context.route(`${BASE}/document.pdf`, route => route.fulfill({ status: 200, contentType: 'application/pdf', body: pdfFixture() }));
  await page.goto(`chrome-extension://${extensionId}/reader.html?url=${encodeURIComponent(`${BASE}/document.pdf`)}`);
  await expect(page.locator('.textLayer').first()).toContainText('The bank');
  await page.getByLabel('在线 PDF 地址', { exact: true }).fill(`${BASE}/missing.pdf`);
  await page.getByRole('button', { name: '打开在线 PDF', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('本地');
  await context.unroute(`${BASE}/document.pdf`);
});
