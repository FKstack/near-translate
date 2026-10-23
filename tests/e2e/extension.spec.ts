import { test, expect, chromium, type BrowserContext, type Page, type Worker, type Frame } from '@playwright/test';
import { readFile, mkdtemp, realpath, rm } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { pdfFixture } from './pdf-fixture';

const BASE = 'http://127.0.0.1:4177';
const LONG_SENTENCE = 'The report that the researchers published after the experiment was completed explains why the new method works.';
const LONG_TRANSLATION = '实验完成后，研究人员发表的那份报告解释了新方法为何有效。';
const SENTENCE_ANALYSIS = {
  mainClause: {
    text: 'The report explains why the new method works.',
    translation: '这份报告解释了新方法为何有效。',
    explanation: 'The report 是主语，explains 是谓语，why 引导的宾语从句说明报告解释的内容。',
  },
  chunks: [
    { text: 'The report', role: '主语核心', category: 'subject', explanation: '先找到报告这个句子主语。' },
    { text: 'that the researchers published', role: '定语从句', category: 'clause', explanation: 'that 指代 report，说明这份报告是研究人员发表的。' },
    { text: 'after the experiment was completed', role: '时间状语从句', category: 'clause', explanation: 'after 引出实验完成这一时间条件，修饰 published。' },
    { text: 'explains', role: '主句谓语', category: 'predicate', explanation: '主句的动作是解释。' },
    { text: 'why the new method works.', role: '宾语从句', category: 'clause', explanation: 'why 引导从句，说明 explains 的内容。' },
  ],
  readingGuide: '先读 The report explains 这个主干，再把 that 定语从句放回 report 后，最后理解 after 时间状语和 why 宾语从句。',
};
const COLOR_SENTENCE = 'The scientist who leads the team explained the result.';
const COLOR_SPACED_SENTENCE = 'The scientist  who leads  the team explained   the result.';
const COLOR_TRANSLATION = '领导该团队的科学家解释了这个结果。';
const COLOR_ANALYSIS = {
  mainClause: {
    text: 'The scientist explained the result.',
    translation: '科学家解释了这个结果。',
    explanation: 'The scientist 是主语，explained 是谓语，the result 是宾语。',
  },
  chunks: [
    { text: 'The scientist', role: '主语', category: 'subject', explanation: '句子的主语是这位科学家。' },
    { text: 'who leads the team', role: '定语从句', category: 'clause', explanation: 'who 指代 scientist，补充说明他领导着该团队。' },
    { text: 'explained', role: '谓语', category: 'predicate', explanation: 'explained 表示主语完成了解释这个动作。' },
    { text: 'the result.', role: '宾语', category: 'object', explanation: '解释的对象是这个结果。' },
  ],
  readingGuide: '先读 The scientist explained the result，再把 who 定语从句补回 scientist 后面。',
};
type CapturedRequest = { selectedText: string; context?: string; task?: 'sentence-analysis'; model: string; thinking: { type: string } };
type FakeApiState = {
  requests: CapturedRequest[];
  cancellations: number;
  analysisCancellations: number;
  failNext: boolean;
  failAnalysis: boolean;
  analysisDelayMs: number;
  unsafeAnalysis: boolean;
  holdDictionary?: boolean;
  releaseDictionary?: () => void;
};
let context: BrowserContext;
let worker: Worker;
let extensionId: string;
let profile: string;
let options: Page;
let page: Page;

async function installFakeApi(background: Worker): Promise<void> {
  await background.evaluate(({ sentence, analysis, sentenceTranslation, colorSentence, colorAnalysis, colorTranslation }) => {
    const global = globalThis as typeof globalThis & {
      __nearTest: FakeApiState;
    };
    const nativeFetch = global.fetch.bind(global);
    global.__nearTest = { requests: [], cancellations: 0, analysisCancellations: 0,
      failNext: false, failAnalysis: false, analysisDelayMs: 900, unsafeAnalysis: false };
    global.fetch = async function (this: typeof globalThis, input, init) {
      // Match the native WorkerGlobalScope receiver contract; arrow mocks hide illegal invocations.
      if (this !== globalThis) throw new TypeError("Failed to execute 'fetch' on 'WorkerGlobalScope': Illegal invocation");
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith('https://api.deepseek.com/')) return nativeFetch(input, init);
      const request = JSON.parse(String(init?.body));
      const envelope = JSON.parse(request.messages[1].content);
      global.__nearTest.requests.push({ ...envelope, model: request.model, thinking: request.thinking });
      const analyzing = envelope.task === 'sentence-analysis';
      if (analyzing && global.__nearTest.failAnalysis) {
        global.__nearTest.failAnalysis = false;
        return new Response('{}', { status: 503 });
      }
      if (global.__nearTest.failNext) {
        global.__nearTest.failNext = false;
        return new Response('{}', { status: 503 });
      }
      const word = !analyzing && request.response_format?.type === 'json_object';
      const entry = envelope.selectedText === 'bank' ? {
        translation: '银行', partOfSpeech: '名词', explanation: '此处指金融机构。',
        senses: [
          { partOfSpeech: '名词', meaning: '银行' },
          { partOfSpeech: '名词', meaning: '河岸' },
          { partOfSpeech: '动词', meaning: '把钱存入银行' },
        ],
      } : envelope.selectedText === 'record' ? {
        translation: '记录', partOfSpeech: '动词', explanation: '这里表示把最终结果写下来或保存。',
        senses: [
          { partOfSpeech: '名词', meaning: '记录；记载' },
          { partOfSpeech: '名词', meaning: '唱片' },
          { partOfSpeech: '名词', meaning: '最高纪录；最佳成绩' },
          { partOfSpeech: '名词', meaning: '履历；经历' },
          { partOfSpeech: '动词', meaning: '记录；记载信息' },
          { partOfSpeech: '动词', meaning: '录制声音或影像' },
        ],
      } : envelope.selectedText === 'scheduler' ? {
        translation: '调度器', partOfSpeech: '名词', explanation: '此处指安排并发任务执行的调度器。',
        senses: [{ partOfSpeech: '名词', meaning: '调度器' }],
      } : {
        translation: '准确性', partOfSpeech: '名词', explanation: '此处采用技术文档中的常见词义。',
        senses: [{ partOfSpeech: '名词', meaning: '准确性；精确度' }],
      };
      const colorFixture = envelope.selectedText.replace(/\s+/g, ' ').trim() === colorSentence;
      const selectedAnalysis = colorFixture ? colorAnalysis : analysis;
      const translated = analyzing ? JSON.stringify({ ...selectedAnalysis,
        readingGuide: global.__nearTest.unsafeAnalysis ? '<img src=x onerror="window.analysisExecuted=true">阅读顺序保持纯文本。' : selectedAnalysis.readingGuide,
      }) : word ? JSON.stringify({
        ...entry,
        explanation: envelope.context ? entry.explanation : '未提供上下文，此为常见参考释义，需结合原句判断。',
      }) : envelope.selectedText === sentence ? sentenceTranslation : colorFixture ? colorTranslation : envelope.selectedText.startsWith('Render translated HTML')
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
          const heldDictionary = word && global.__nearTest.holdDictionary;
          const boundary = heldDictionary ? translated.indexOf(',"senses"') + 1 : word ? 7 : 9;
          sink.enqueue(encoder.encode(event(translated.slice(0, boundary))));
          const finish = () => {
            if (done) return;
            done = true;
            if (heldDictionary) global.__nearTest.releaseDictionary = undefined;
            sink.enqueue(encoder.encode(event(translated.slice(boundary)) + event(null, 'stop') + 'data: [DONE]\n\n'));
            sink.close();
          };
          if (heldDictionary) global.__nearTest.releaseDictionary = finish;
          else timer = setTimeout(finish, analyzing ? global.__nearTest.analysisDelayMs : envelope.selectedText.startsWith('Slow selection') ? 1_500 : word ? 80 : 700);
          init?.signal?.addEventListener('abort', () => {
            if (done) return;
            done = true; clearTimeout(timer); global.__nearTest.cancellations++;
            if (analyzing) global.__nearTest.analysisCancellations++;
            sink.error(new DOMException('Aborted', 'AbortError'));
          }, { once: true });
        },
        cancel() { done = true; clearTimeout(timer); },
      });
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
    };
  }, { sentence: LONG_SENTENCE, analysis: SENTENCE_ANALYSIS, sentenceTranslation: LONG_TRANSLATION,
    colorSentence: COLOR_SENTENCE, colorAnalysis: COLOR_ANALYSIS, colorTranslation: COLOR_TRANSLATION });
}

async function requests(): Promise<CapturedRequest[]> {
  return worker.evaluate(() => (globalThis as unknown as { __nearTest: { requests: CapturedRequest[] } }).__nearTest.requests);
}

async function saveSettings(values: { key?: string; enabled?: boolean; includeContext?: boolean; removeKey?: boolean; analysis?: boolean } = {}): Promise<void> {
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await expect(options.getByRole('button', { name: '保存设置', exact: true })).toBeEnabled();
  await options.getByLabel('翻译方式', { exact: true }).selectOption('model');
  if (values.removeKey) await options.getByRole('button', { name: '删除已保存的 Key' }).click();
  if (values.key !== undefined) await options.getByLabel('DeepSeek API Key', { exact: true }).fill(values.key);
  if (values.enabled !== undefined) await options.getByLabel('启用翻译', { exact: true }).setChecked(values.enabled);
  if (values.includeContext !== undefined) await options.getByLabel('附带所在句或附近一句上下文，提高词义判断准确度').setChecked(values.includeContext);
  await options.getByRole('checkbox', { name: '长难句拆解', exact: true }).setChecked(values.analysis ?? false);
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
  await expect(surface.getByRole('button', { name: '翻译选中文字' })).toBeVisible();
}

async function addSentenceFixture(sentence = LONG_SENTENCE): Promise<void> {
  await page.locator('main').evaluate((element, sentence) => {
    const paragraph = document.createElement('p');
    paragraph.id = 'long-sentence';
    paragraph.style.whiteSpace = 'pre-wrap';
    paragraph.textContent = sentence;
    const heading = element.querySelector('h1');
    if (heading) heading.after(paragraph);
    else element.prepend(paragraph);
  }, sentence);
}

async function startSentenceTranslation(sentence = LONG_SENTENCE): Promise<void> {
  await addSentenceFixture(sentence);
  await selectElement(page, '#long-sentence');
  await page.getByRole('button', { name: '翻译选中文字' }).click();
}

async function analysisRequests(): Promise<CapturedRequest[]> {
  return (await requests()).filter(request => request.task === 'sentence-analysis');
}

async function analysisCancellations(): Promise<number> {
  return worker.evaluate(() => (globalThis as unknown as { __nearTest: FakeApiState }).__nearTest.analysisCancellations);
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
    const state = (globalThis as unknown as { __nearTest: FakeApiState }).__nearTest;
    state.requests = []; state.cancellations = 0; state.analysisCancellations = 0;
    state.failNext = false; state.failAnalysis = false; state.analysisDelayMs = 900; state.unsafeAnalysis = false;
    state.holdDictionary = false; state.releaseDictionary = undefined;
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

test('ordinary HTTP pages translate selected words', async ({}, info) => {
  const url = 'http://selection-fixture.invalid/';
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.route(url, route => route.fulfill({ status: 200, contentType: 'text/html', body:
    '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body><p>The <span id="http-bank">bank</span> approved the technical report.</p></body></html>',
  }));
  await page.goto(url);
  expect(await page.evaluate(() => window.isSecureContext)).toBe(false);
  await expect(page.locator('near-translate')).toHaveCount(1);
  await page.locator('#http-bank').dblclick();
  await page.getByRole('button', { name: '翻译选中文字' }).click();
  await expect.soft.poll(requests).toHaveLength(1);
  await expect.soft(page.locator('.nt-word')).toHaveText('银行');
  await info.attach('ordinary-http-selection.json', {
    body: JSON.stringify({ url: page.url(), secureContext: await page.evaluate(() => window.isSecureContext),
      requests: await requests(), card: await page.locator('near-translate').evaluate(element => element.shadowRoot?.textContent), errors }, null, 2),
    contentType: 'application/json',
  });
  expect((await requests())[0]).toMatchObject({ selectedText: 'bank', context: 'The bank approved the technical report.' });
  expect(errors).toEqual([]);
});

test('word meaning is visible while dictionary senses are still generating', async ({}, testInfo) => {
  await worker.evaluate(() => { (globalThis as unknown as { __nearTest: FakeApiState }).__nearTest.holdDictionary = true; });
  await page.locator('#bank').dblclick();
  await page.getByRole('button', { name: '翻译选中文字' }).click();
  await expect(page.locator('.nt-word')).toHaveText('银行');
  await expect(page.locator('.nt-pos')).toHaveText('名词');
  await expect(page.locator('.nt-explanation')).toContainText('金融机构');
  await expect(page.locator('.nt-loading')).toHaveText('正在生成释义…');
  await expect(page.locator('.nt-senses')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '复制', exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('word-preview.png') });
  await worker.evaluate(() => { (globalThis as unknown as { __nearTest: FakeApiState }).__nearTest.releaseDictionary?.(); });
  await expect(page.locator('.nt-sense-meaning')).toHaveText(['银行', '河岸', '把钱存入银行']);
  await expect(page.locator('.nt-loading')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '复制', exact: true })).toBeVisible();
  expect(await requests()).toHaveLength(1);
});

test('double-click word translates with context, copy and close', async ({}, testInfo) => {
  await page.locator('#bank').dblclick();
  const trigger = page.getByRole('button', { name: '翻译选中文字' });
  await expect(trigger).toBeVisible();
  expect(await requests()).toEqual([]);
  await trigger.click();
  await expect(page.locator('.nt-word')).toHaveText('银行');
  await expect(page.locator('.nt-pos')).toHaveText('名词');
  await expect(page.locator('.nt-explanation')).toContainText('金融机构');
  await expect(page.locator('.nt-current-sense')).toHaveAttribute('aria-label', '本句含义');
  await expect(page.locator('.nt-senses')).toBeVisible();
  await expect(page.getByText('常见义项', { exact: true })).toBeVisible();
  await expect(page.locator('.nt-sense-group').filter({ hasText: '名词' }).locator('.nt-sense-meaning')).toHaveText(['银行', '河岸']);
  await expect(page.locator('.nt-sense-group').filter({ hasText: '动词' }).locator('.nt-sense-meaning')).toHaveText(['把钱存入银行']);
  await expect(page.getByText('河岸', { exact: true })).toBeInViewport();
  expect((await requests())[0]).toMatchObject({ selectedText: 'bank', context: 'The bank approved the technical report.', model: 'deepseek-flash', thinking: { type: 'disabled' } });
  await page.screenshot({ path: testInfo.outputPath('web-word-card.png'), fullPage: true });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  await page.bringToFront();
  await page.getByRole('button', { name: '复制', exact: true }).click();
  await expect(page.locator('near-translate').getByRole('status')).toContainText('已复制译文');
  const copied = (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n');
  expect(copied).toContain('本句含义');
  expect(copied).toContain('词性：名词');
  expect(copied).toContain('常见义项');
  expect(copied).toContain('名词\n1. 银行\n2. 河岸');
  expect(copied).toContain('动词\n1. 把钱存入银行');
  await page.getByRole('button', { name: '关闭翻译' }).click();
  await expect(page.getByRole('dialog', { name: '翻译结果' })).toHaveCount(0);
});

test('paragraph streams and preserves paragraph breaks', async () => {
  await selectElement(page, '#paragraph');
  await page.getByRole('button', { name: '翻译选中文字' }).click();
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
  await page.getByRole('button', { name: '翻译选中文字' }).click();
  await expect(page.locator('.nt-word')).toHaveText('银行');
  await expect(page.locator('.nt-current-sense')).toHaveAttribute('aria-label', '参考释义');
  await expect(page.getByText('本句含义', { exact: true })).toHaveCount(0);
  await expect(page.locator('.nt-context-note')).toContainText('未提供上下文');
  await expect(page.locator('.nt-senses')).toBeVisible();
  await expect(page.locator('.nt-sense-meaning')).toHaveCount(3);
  expect((await requests())[0]).not.toHaveProperty('context');
});

test('disable closes the current overlay and prevents selection buttons', async () => {
  await page.locator('#bank').dblclick();
  await expect(page.getByRole('button', { name: '翻译选中文字' })).toBeVisible();
  await saveSettings({ enabled: false });
  await expect(page.getByRole('button', { name: '翻译选中文字' })).toHaveCount(0);
  await page.locator('#paragraph').dblclick();
  await expect(page.getByRole('button', { name: '翻译选中文字' })).toHaveCount(0);
  expect(await requests()).toEqual([]);
});

test('website-access revocation broadcast closes existing web overlays while PDF translation remains available', async () => {
  await page.locator('#bank').dblclick();
  await expect(page.getByRole('button', { name: '翻译选中文字' })).toBeVisible();
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
  await expect(page.getByRole('button', { name: '翻译选中文字' })).toHaveCount(0);
  await page.locator('#bank').dblclick();
  await expect(page.getByRole('button', { name: '翻译选中文字' })).toHaveCount(0);
  await selectElement(reader, '.textLayer span');
  await reader.getByRole('button', { name: '翻译选中文字' }).click();
  await expect(reader.getByRole('button', { name: '复制', exact: true })).toBeVisible();
  expect((await requests())[0]?.selectedText).toContain('The bank');
});

test('authorized iframe selections translate in their own document', async () => {
  const frame = page.frameLocator('iframe');
  await frame.locator('#frame-word').dblclick();
  await expect(frame.getByRole('button', { name: '翻译选中文字' })).toBeVisible();
  await frame.getByRole('button', { name: '翻译选中文字' }).click();
  await expect(frame.locator('.nt-word')).toHaveText('调度器');
  await expect(frame.locator('.nt-sense-meaning')).toHaveText(['调度器']);
  await expect(frame.locator('.nt-sense-group')).toHaveCount(1);
  expect((await requests())[0]?.selectedText).toBe('scheduler');
});

test('missing key offers settings and sends no request', async () => {
  await saveSettings({ removeKey: true });
  await page.locator('#bank').dblclick();
  await page.getByRole('button', { name: '翻译选中文字' }).click();
  await expect(page.getByRole('alert')).toContainText('填写 API Key');
  await expect(page.getByRole('button', { name: '打开设置' })).toBeVisible();
  expect(await requests()).toEqual([]);
});

test('new selection cancels old work and old output cannot replace new result', async () => {
  await selectElement(page, '#slow');
  await page.getByRole('button', { name: '翻译选中文字' }).click();
  await expect(page.locator('.nt-text')).toContainText('旧请求部分');
  await page.locator('#bank').dblclick();
  await page.getByRole('button', { name: '翻译选中文字' }).click();
  await expect(page.locator('.nt-word')).toHaveText('银行');
  await expect.poll(() => worker.evaluate(() => (globalThis as unknown as { __nearTest: { cancellations: number } }).__nearTest.cancellations)).toBeGreaterThanOrEqual(1);
  // Cancellation releases the delayed response timer; the completed new result stays visible.
  await expect(page.locator('.nt-word')).toHaveText('银行');
  expect((await requests()).map(request => request.selectedText)).toEqual(['Slow selection must never overwrite a newer translation.', 'bank']);
});

test('provider HTML output stays inert and temporary failure offers retry', async () => {
  await selectElement(page, '#inert');
  await page.getByRole('button', { name: '翻译选中文字' }).click();
  await expect(page.getByRole('button', { name: '复制', exact: true })).toBeVisible();
  await expect(page.locator('.nt-text')).toContainText('<img src=x');
  await expect(page.locator('.nt-card img')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { translationExecuted?: boolean }).translationExecuted)).toBeUndefined();
  await page.getByRole('button', { name: '关闭翻译' }).click();
  await worker.evaluate(() => { (globalThis as unknown as { __nearTest: { failNext: boolean } }).__nearTest.failNext = true; });
  await selectElement(page, '#retry');
  await page.getByRole('button', { name: '翻译选中文字' }).click();
  await expect(page.getByRole('alert')).toContainText('HTTP 503');
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByRole('button', { name: '复制', exact: true })).toBeVisible();
});

test('editable selection and viewport-edge overlay remain usable', async () => {
  await page.locator('#editable').evaluate((element: HTMLTextAreaElement) => {
    element.focus(); element.setSelectionRange(4, 13);
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 600, clientY: 660 }));
  });
  await page.getByRole('button', { name: '翻译选中文字' }).click();
  await expect(page.locator('.nt-word')).toHaveText('调度器');
  await page.getByRole('button', { name: '关闭翻译' }).click();
  await page.locator('#edge-word').dblclick();
  await page.getByRole('button', { name: '翻译选中文字' }).click();
  await expect(page.locator('.nt-word')).toHaveText('准确性');
  const box = await page.getByRole('dialog', { name: '翻译结果' }).boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(1280); expect(box!.y + box!.height).toBeLessThanOrEqual(900);
});

test('a larger dictionary keeps different parts of speech accessible in a small viewport', async ({}, testInfo) => {
  await page.setViewportSize({ width: 480, height: 360 });
  await page.locator('#record').dblclick();
  await page.getByRole('button', { name: '翻译选中文字' }).click();
  await expect(page.locator('.nt-word')).toHaveText('记录');
  await expect(page.locator('.nt-pos')).toHaveText('动词');
  await expect(page.locator('.nt-sense-pos')).toHaveText(['名词', '动词']);
  await expect(page.locator('.nt-sense-meaning')).toHaveCount(6);
  const box = await page.getByRole('dialog', { name: '翻译结果' }).boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(480); expect(box!.y + box!.height).toBeLessThanOrEqual(360);
  expect(await page.locator('.nt-body').evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  await page.locator('.nt-sense-meaning').last().scrollIntoViewIfNeeded();
  await expect(page.getByText('录制声音或影像', { exact: true })).toBeInViewport();
  await expect(page.getByRole('button', { name: '复制', exact: true })).toBeInViewport();
  await expect(page.getByRole('button', { name: '关闭翻译' })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('dictionary-small-viewport.png'), fullPage: true });
});

test('sentence analysis is saved and appears after the ordinary translation', async ({}, testInfo) => {
  await saveSettings({ analysis: true });
  await options.reload();
  await expect(options.getByRole('checkbox', { name: '长难句拆解', exact: true })).toBeChecked();
  await startSentenceTranslation();
  await expect(page.locator('.nt-text')).toContainText('实验完成后');
  expect(await analysisRequests()).toEqual([]);
  await expect(page.locator('.nt-source mark')).toHaveCount(0);
  await expect(page.locator('.nt-analysis-legend')).toHaveCount(0);
  await expect(page.locator('.nt-text')).toHaveText(LONG_TRANSLATION);
  await expect(page.locator('.nt-analysis')).toContainText('正在拆解句子');
  await expect.poll(async () => (await analysisRequests()).length).toBe(1);
  await expect(page.getByRole('region', { name: '句子主干', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: '分块阅读', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: '阅读顺序', exact: true })).toBeVisible();
  await expect(page.locator('.nt-analysis-title')).toHaveText('长难句拆解');
  await expect(page.getByRole('region', { name: '句子主干', exact: true })).toContainText(SENTENCE_ANALYSIS.mainClause.text);
  await expect(page.getByRole('region', { name: '分块阅读', exact: true })).toContainText('定语从句');
  await expect(page.getByRole('region', { name: '分块阅读', exact: true })).toContainText('时间状语从句');
  await expect(page.locator('.nt-source mark')).toHaveCount(5);
  expect(await page.locator('.nt-source').textContent()).toBe(LONG_SENTENCE);
  const captured = await requests();
  expect(captured).toHaveLength(2);
  expect(captured[0]).toMatchObject({ selectedText: LONG_SENTENCE, model: 'deepseek-flash' });
  expect(captured[0]).not.toHaveProperty('task');
  expect(captured[1]).toMatchObject({ selectedText: LONG_SENTENCE, task: 'sentence-analysis', thinking: { type: 'disabled' } });
  await page.locator('.nt-card').screenshot({ path: testInfo.outputPath('sentence-analysis-card.png') });
});

test('disabling sentence analysis persists and word translations never request analysis', async () => {
  await saveSettings({ analysis: true });
  await page.locator('#bank').dblclick();
  await page.getByRole('button', { name: '翻译选中文字' }).click();
  await expect(page.locator('.nt-word')).toHaveText('银行');
  expect(await analysisRequests()).toEqual([]);
  await expect(page.locator('.nt-analysis')).toHaveCount(0);
  await expect(page.locator('.nt-source mark')).toHaveCount(0);
  await expect(page.locator('.nt-analysis-legend')).toHaveCount(0);
  await page.getByRole('button', { name: '关闭翻译' }).click();
  await saveSettings({ analysis: false });
  await options.reload();
  await expect(options.getByRole('checkbox', { name: '长难句拆解', exact: true })).not.toBeChecked();
  await startSentenceTranslation();
  await expect(page.locator('.nt-text')).toHaveText(LONG_TRANSLATION);
  await page.waitForTimeout(250);
  await expect(page.locator('.nt-analysis')).toHaveCount(0);
  await expect(page.locator('.nt-source mark')).toHaveCount(0);
  await expect(page.locator('.nt-analysis-legend')).toHaveCount(0);
  expect(await analysisRequests()).toEqual([]);
  expect(await requests()).toHaveLength(2);
});

test('an analysis failure keeps the translation and retries only the analysis request', async () => {
  await saveSettings({ analysis: true });
  await worker.evaluate(() => { (globalThis as unknown as { __nearTest: FakeApiState }).__nearTest.failAnalysis = true; });
  await startSentenceTranslation();
  await expect(page.locator('.nt-text')).toHaveText(LONG_TRANSLATION);
  await expect(page.locator('.nt-analysis')).toContainText('拆解暂未完成');
  await expect(page.locator('.nt-analysis')).toContainText('HTTP 503');
  await expect(page.locator('.nt-source mark')).toHaveCount(0);
  await expect(page.locator('.nt-analysis-legend')).toHaveCount(0);
  expect(await requests()).toHaveLength(2);
  await page.getByRole('button', { name: '重试拆解', exact: true }).click();
  await expect(page.getByRole('region', { name: '句子主干', exact: true })).toBeVisible();
  await expect(page.locator('.nt-text')).toHaveText(LONG_TRANSLATION);
  expect(await analysisRequests()).toHaveLength(2);
  expect((await requests()).filter(request => !request.task)).toHaveLength(1);
});

test('closing the card cancels sentence analysis and suppresses its late output', async () => {
  await saveSettings({ analysis: true });
  await worker.evaluate(() => { (globalThis as unknown as { __nearTest: FakeApiState }).__nearTest.analysisDelayMs = 1_500; });
  await startSentenceTranslation();
  await expect(page.locator('.nt-text')).toHaveText(LONG_TRANSLATION);
  await expect.poll(async () => (await analysisRequests()).length).toBe(1);
  await page.getByRole('button', { name: '关闭翻译' }).click();
  await expect.poll(analysisCancellations).toBe(1);
  await page.waitForTimeout(1_600);
  await expect(page.getByRole('dialog', { name: '翻译结果' })).toHaveCount(0);
  await expect(page.locator('.nt-analysis')).toHaveCount(0);
});

test('a new selection cancels sentence analysis without replacing the new word result', async () => {
  await saveSettings({ analysis: true });
  await worker.evaluate(() => { (globalThis as unknown as { __nearTest: FakeApiState }).__nearTest.analysisDelayMs = 1_500; });
  await startSentenceTranslation();
  await expect(page.locator('.nt-text')).toHaveText(LONG_TRANSLATION);
  await expect.poll(async () => (await analysisRequests()).length).toBe(1);
  await page.locator('#bank').dblclick();
  await page.getByRole('button', { name: '翻译选中文字' }).click();
  await expect(page.locator('.nt-word')).toHaveText('银行');
  await expect.poll(analysisCancellations).toBe(1);
  await page.waitForTimeout(1_600);
  await expect(page.locator('.nt-word')).toHaveText('银行');
  await expect(page.locator('.nt-analysis')).toHaveCount(0);
  await expect(page.locator('.nt-source mark')).toHaveCount(0);
  await expect(page.locator('.nt-analysis-legend')).toHaveCount(0);
  expect((await requests()).map(request => request.task ?? request.selectedText)).toEqual([LONG_SENTENCE, 'sentence-analysis', 'bank']);
});

test('turning off sentence analysis cancels its request while keeping the completed translation', async () => {
  await saveSettings({ analysis: true });
  await worker.evaluate(() => { (globalThis as unknown as { __nearTest: FakeApiState }).__nearTest.analysisDelayMs = 1_500; });
  await startSentenceTranslation();
  await expect(page.locator('.nt-text')).toHaveText(LONG_TRANSLATION);
  await expect.poll(async () => (await analysisRequests()).length).toBe(1);
  await saveSettings({ analysis: false });
  await expect.poll(analysisCancellations).toBe(1);
  await expect(page.locator('.nt-text')).toHaveText(LONG_TRANSLATION);
  await expect(page.locator('.nt-analysis')).toHaveCount(0);
  await page.waitForTimeout(1_600);
  await expect(page.locator('.nt-analysis')).toHaveCount(0);
  expect(await analysisRequests()).toHaveLength(1);
});

test('sentence analysis scrolls inside a small card and treats model markup as plain text', async ({}, testInfo) => {
  await saveSettings({ analysis: true });
  await page.setViewportSize({ width: 480, height: 360 });
  await worker.evaluate(() => { (globalThis as unknown as { __nearTest: FakeApiState }).__nearTest.unsafeAnalysis = true; });
  await startSentenceTranslation();
  await expect(page.getByRole('region', { name: '阅读顺序', exact: true })).toBeVisible();
  await expect(page.locator('.nt-analysis')).toContainText('<img src=x onerror="window.analysisExecuted=true">阅读顺序保持纯文本。');
  await expect(page.locator('.nt-card img')).toHaveCount(0);
  expect(await page.evaluate(() => (window as typeof window & { analysisExecuted?: boolean }).analysisExecuted)).toBeUndefined();
  const box = await page.getByRole('dialog', { name: '翻译结果' }).boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(480); expect(box!.y + box!.height).toBeLessThanOrEqual(360);
  expect(await page.locator('.nt-body').evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  await page.getByRole('region', { name: '阅读顺序', exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('region', { name: '阅读顺序', exact: true })).toBeInViewport();
  await expect(page.getByRole('button', { name: '复制', exact: true })).toBeInViewport();
  await expect(page.getByRole('button', { name: '关闭翻译' })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('sentence-analysis-small-viewport.png'), fullPage: true });
});

test('grammar colors match the original and chunks and disappear when sentence analysis is switched off', async ({}, testInfo) => {
  await saveSettings({ analysis: true });
  await startSentenceTranslation(COLOR_SENTENCE);
  await expect(page.locator('.nt-text')).toHaveText(COLOR_TRANSLATION);
  await expect(page.locator('.nt-source mark')).toHaveCount(0);
  await expect(page.locator('.nt-analysis-legend')).toHaveCount(0);
  await expect(page.getByRole('region', { name: '分块阅读', exact: true })).toBeVisible();
  await expect(page.locator('.nt-source mark')).toHaveCount(4);
  await expect(page.locator('.nt-analysis-legend')).toBeVisible();
  expect(await page.locator('.nt-source').textContent()).toBe(COLOR_SENTENCE);
  const colors: string[] = [];
  for (const [index, chunk] of COLOR_ANALYSIS.chunks.entries()) {
    const source = page.locator(`.nt-source mark[data-analysis-chunk="${index}"]`);
    const block = page.locator(`.nt-analysis-chunk[data-analysis-chunk="${index}"]`);
    await expect(source).toHaveAttribute('data-category', chunk.category);
    await expect(block).toHaveAttribute('data-category', chunk.category);
    const sourceColor = await source.evaluate(element => getComputedStyle(element).backgroundColor);
    const blockColor = await block.locator('.nt-analysis-english').evaluate(element => getComputedStyle(element).backgroundColor);
    expect(sourceColor).not.toBe('rgba(0, 0, 0, 0)');
    expect(sourceColor).toBe(blockColor);
    colors.push(sourceColor);
  }
  expect(new Set(colors).size).toBe(4);
  expect(await analysisRequests()).toHaveLength(1);
  expect(await requests()).toHaveLength(2);
  await page.locator('.nt-card').screenshot({ path: testInfo.outputPath('sentence-analysis-colors.png') });
  await saveSettings({ analysis: false });
  await expect(page.locator('.nt-source mark')).toHaveCount(0);
  await expect(page.locator('.nt-analysis-legend')).toHaveCount(0);
  await expect(page.locator('.nt-analysis')).toHaveCount(0);
  expect(await page.locator('.nt-source').textContent()).toBe(COLOR_SENTENCE);
  await expect(page.locator('.nt-text')).toHaveText(COLOR_TRANSLATION);
  await page.waitForTimeout(250);
  expect(await analysisRequests()).toHaveLength(1);
  expect(await requests()).toHaveLength(2);
});

test('grammar marks and chunks synchronize mouse and keyboard focus without changing the source text', async () => {
  await saveSettings({ analysis: true });
  await startSentenceTranslation(COLOR_SPACED_SENTENCE);
  await expect(page.locator('.nt-source mark')).toHaveCount(4);
  expect(await page.locator('.nt-source').textContent()).toBe(COLOR_SPACED_SENTENCE);
  const clause = page.locator('.nt-source mark[data-analysis-chunk="1"]');
  const clauseBlock = page.locator('.nt-analysis-chunk[data-analysis-chunk="1"]');
  await clause.click();
  await expect(clause).toHaveAttribute('aria-pressed', 'true');
  await expect(clause).toHaveAttribute('data-active', 'true');
  await expect(clauseBlock).toHaveAttribute('data-active', 'true');
  await expect(clauseBlock).toBeInViewport();
  const object = page.locator('.nt-source mark[data-analysis-chunk="3"]');
  const objectBlock = page.locator('.nt-analysis-chunk[data-analysis-chunk="3"]');
  await objectBlock.getByRole('button').click();
  await expect(object).toHaveAttribute('data-active', 'true');
  await expect(object).toHaveAttribute('aria-pressed', 'true');
  await expect(objectBlock).toHaveAttribute('data-active', 'true');
  await expect(object).toBeInViewport();
  await expect(clause).toHaveAttribute('data-active', 'false');
  const subject = page.locator('.nt-source mark[data-analysis-chunk="0"]');
  const subjectBlock = page.locator('.nt-analysis-chunk[data-analysis-chunk="0"]');
  await subject.press('Enter');
  await expect(subject).toHaveAttribute('data-active', 'true');
  await expect(subjectBlock).toHaveAttribute('data-active', 'true');
  await expect(subjectBlock).toBeInViewport();
  const predicate = page.locator('.nt-source mark[data-analysis-chunk="2"]');
  const predicateBlock = page.locator('.nt-analysis-chunk[data-analysis-chunk="2"]');
  await predicateBlock.getByRole('button').press('Space');
  await expect(predicate).toHaveAttribute('data-active', 'true');
  await expect(predicateBlock).toHaveAttribute('data-active', 'true');
  await expect(predicate).toBeInViewport();
  expect(await page.locator('.nt-source').textContent()).toBe(COLOR_SPACED_SENTENCE);
  expect(await requests()).toHaveLength(2);
  await page.locator('#bank').dblclick();
  await expect(page.locator('.nt-source mark')).toHaveCount(0);
  await expect(page.locator('.nt-analysis-legend')).toHaveCount(0);
  await page.getByRole('button', { name: '翻译选中文字' }).click();
  await expect(page.locator('.nt-word')).toHaveText('银行');
  await expect(page.locator('.nt-source mark')).toHaveCount(0);
  await expect(page.locator('.nt-analysis-legend')).toHaveCount(0);
  expect(await analysisRequests()).toHaveLength(1);
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
  await page.locator('.textLayer span').filter({ hasText: 'The bank approved the technical report.' }).first().evaluate((element) => {
    const text = element.firstChild;
    const offset = text?.textContent?.indexOf('bank') ?? -1;
    if (!text || offset < 0) throw new Error('The PDF fixture must expose bank in its text layer.');
    const range = document.createRange(); range.setStart(text, offset); range.setEnd(text, offset + 4);
    const selection = document.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    const rect = range.getBoundingClientRect();
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: rect.right - 4, clientY: rect.bottom - 4 }));
  });
  await page.getByRole('button', { name: '翻译选中文字' }).click();
  await expect(page.getByRole('button', { name: '复制', exact: true })).toBeVisible();
  await expect(page.locator('.nt-meta')).toContainText('PDF');
  await expect(page.locator('.nt-word')).toHaveText('银行');
  await expect(page.locator('.nt-current-sense')).toHaveAttribute('aria-label', '本句含义');
  await expect(page.locator('.nt-sense-meaning')).toHaveText(['银行', '河岸', '把钱存入银行']);
  expect((await requests())[0]?.selectedText).toBe('bank');
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
  const crossPageTrigger = page.getByRole('button', { name: '翻译选中文字' });
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
