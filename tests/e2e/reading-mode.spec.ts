import { test, expect, chromium, type BrowserContext, type Locator, type Page, type Worker } from '@playwright/test';
import { mkdtemp, realpath, rm, readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { DEFAULT_READING_PREFERENCES } from '../../src/shared/reading';

const BASE = 'http://127.0.0.1:4177';
const FIXTURE_URL = `${BASE}/reading-mode`;
const IMAGE_URL = `${BASE}/reading-diagram.svg`;
const TEST_KEY = 'fake-reading-only-test-key';
const TITLE = 'A calmer way to read technical articles';
const FIRST = 'Good reading begins with enough context. A clear article lets readers follow the argument at their own pace, revisit an earlier explanation, and keep the important technical details close to the text.';
const SECOND = 'When an article contains source code, illustrations, and structured data, a reading view should preserve those details. Changing the presentation should never rewrite the source website or start a translation request.';
const CHINESE = '阅读不应被繁杂的页面打断。保留清晰的章节、完整的代码和必要的图片，可以帮助读者按照自己的节奏理解文章。这段中文应该保留在阅读页中，不需要发送给翻译服务。';
const CODE = `const revision = "${'a_very_long_identifier_'.repeat(30)}";\nconsole.log(revision);`;
const UNSAFE = 'Model output must remain plain text even when the service returns something that looks like HTML.';
const UNSAFE_TRANSLATION = '<img src=x onerror="window.readerTranslationExecuted=true">译文保持纯文本。';
const DEFAULT_PREFERENCES = { ...DEFAULT_READING_PREFERENCES };

const ARTICLE = `<article id="source-article">
  <h1>${TITLE}</h1><p class="byline">By Ada Reader</p>
  <h2 id="source-context">Read with context<a class="permalink" href="#source-context">¶</a></h2><p id="source-first">${FIRST}</p>
  <p id="source-rich">Keep <strong>the details</strong> nearby and run <code>go build</code> before comparing the result. <a href="#source-details">Continue to the next section.</a></p>
  <h2 id="source-details">Keep the details</h2><p id="source-second">${SECOND}</p>
  <pre id="source-code"><code>${CODE}</code></pre>
  <figure><img id="source-image" src="${IMAGE_URL}" alt="A local reading diagram" width="640" height="160"><figcaption>A local technical illustration.</figcaption></figure>
  <table><thead><tr>${Array.from({ length: 6 }, (_, i) => `<th>Column ${i + 1}</th>`).join('')}</tr></thead><tbody><tr>${Array.from({ length: 6 }, (_, i) => `<td>Structured detail ${i + 1}</td>`).join('')}</tr></tbody></table>
  <p id="source-chinese">${CHINESE}</p><p id="source-unsafe">${UNSAFE}</p>
  <p hidden>Hidden draft must not enter the reader.</p><p style="display:none">Invisible draft must not enter the reader.</p>
  <textarea>Private draft must not enter the reader.</textarea><div contenteditable="true">Editable draft must not enter the reader.</div>
</article>`;

function documentHtml(body = ARTICLE, lang = 'en', title = TITLE): string {
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>${title}</title>
    <meta name="author" content="Ada Reader"><meta property="og:site_name" content="Reading Journal">
    <style>body{margin:0;background:#eef2ee;color:#243c2d;font:17px/1.8 system-ui,sans-serif}header,main{max-width:900px;margin:30px auto;padding:24px 40px;background:white}h1{font-size:34px;line-height:1.3}h2{margin-top:44px}p{margin:22px 0}pre{max-width:100%;overflow:auto;padding:16px;background:#edf2ed}img{max-width:100%;height:auto}table{max-width:100%;border-collapse:collapse}td,th{padding:10px;border:1px solid #b3c2b5}button{font:inherit}article{overflow-wrap:break-word}</style>
    </head><body><header><button id="source-control">Original page control</button><nav>Website navigation must not enter the reader.</nav></header><main>${body}</main></body></html>`;
}

type Captured = { text: string; model: string; thinking: { type: string } };
type FakeState = { requests: Captured[]; batches: number; active: number; cancellations: number; blockedExternal: string[];
  delayMs: number; tailDelayMs: number; ignoreAbort: boolean; lateAttempts: number };
type TestBrowserApi = { storage: { local: { set: (items: Record<string, unknown>) => Promise<void>; get: (key: string) => Promise<Record<string, unknown>> } } };

let context: BrowserContext;
let worker: Worker;
let extensionId: string;
let profile: string;
let options: Page;
let page: Page;
let fixture = documentHtml();

async function installFakeApi(): Promise<void> {
  await worker.evaluate(({ unsafe, unsafeTranslation }) => {
    const global = globalThis as typeof globalThis & { __nearReadingTest: FakeState };
    const nativeFetch = global.fetch.bind(global);
    global.__nearReadingTest = { requests: [], batches: 0, active: 0, cancellations: 0, blockedExternal: [], delayMs: 70, tailDelayMs: 0, ignoreAbort: false, lateAttempts: 0 };
    global.fetch = async function (this: typeof globalThis, input, init) {
      if (this !== globalThis) throw new TypeError('Native fetch receiver required.');
      const url = input instanceof Request ? input.url : String(input);
      const state = global.__nearReadingTest;
      if (!url.startsWith('https://api.deepseek.com/')) {
        // No DeepL or other remote service may be contacted by this suite.
        if (/^https?:/i.test(url) && !url.startsWith('http://127.0.0.1:4177/')) {
          state.blockedExternal.push(url); throw new Error('External network disabled in reading E2E.');
        }
        return nativeFetch(input, init);
      }
      const request = JSON.parse(String(init?.body));
      const envelope = JSON.parse(request.messages[1].content);
      const passages: Array<{ i: number; text: string }> = Array.isArray(envelope.segments) ? envelope.segments : [{ i: 0, text: envelope.selectedText }];
      state.batches++;
      for (const passage of passages) state.requests.push({ text: passage.text, model: request.model, thinking: request.thinking });
      const encoder = new TextEncoder();
      const event = (content: string | null, finish_reason: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason }] })}\n\n`;
      let done = false;
      let aborted = false;
      const timers: Array<ReturnType<typeof setTimeout>> = [];
      state.active++;
      const finish = () => {
        if (done) return false;
        done = true; state.active--;
        for (const timer of timers) clearTimeout(timer);
        return true;
      };
      return new Response(new ReadableStream<Uint8Array>({
        start(sink) {
          const push = (content: string) => {
            if (aborted) state.lateAttempts++;
            try { sink.enqueue(encoder.encode(content)); } catch { /* The consumer may have already cancelled its reader. */ }
          };
          passages.forEach((passage, index) => timers.push(setTimeout(() => {
            if (done) return;
            const translated = passage.text === unsafe ? unsafeTranslation : `译文：${passage.text}`;
            push(event(Array.isArray(envelope.segments) ? JSON.stringify({ i: passage.i, t: translated }) + '\n' : translated));
          }, state.delayMs + (index ? state.tailDelayMs : 0))));
          timers.push(setTimeout(() => {
            if (!finish()) return;
            push(event(null, 'stop') + 'data: [DONE]\n\n');
            try { sink.close(); } catch { /* Deliberately late delivery is inert. */ }
          }, state.delayMs + state.tailDelayMs + 20));
          init?.signal?.addEventListener('abort', () => {
            if (done) return;
            state.cancellations++; aborted = true;
            if (state.ignoreAbort) return;
            finish(); sink.error(new DOMException('Aborted', 'AbortError'));
          }, { once: true });
        },
        cancel() { if (!state.ignoreAbort) finish(); },
      }), { headers: { 'Content-Type': 'text/event-stream' } });
    };
  }, { unsafe: UNSAFE, unsafeTranslation: UNSAFE_TRANSLATION });
}

async function state(): Promise<FakeState> {
  return worker.evaluate(() => (globalThis as unknown as { __nearReadingTest: FakeState }).__nearReadingTest);
}

async function configureFake(patch: Partial<FakeState>): Promise<void> {
  await worker.evaluate(patch => Object.assign((globalThis as unknown as { __nearReadingTest: FakeState }).__nearReadingTest, patch), patch);
}

async function saveSettings(removeKey = false): Promise<void> {
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await expect(options.getByRole('button', { name: '保存设置', exact: true })).toBeEnabled();
  await options.getByLabel('翻译方式', { exact: true }).selectOption('model');
  if (removeKey) await options.getByRole('button', { name: '删除已保存的 Key' }).click();
  else await options.getByLabel('DeepSeek API Key', { exact: true }).fill(TEST_KEY);
  await options.getByLabel('启用翻译', { exact: true }).setChecked(true);
  await options.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(options.getByRole('status')).toContainText('设置已保存');
}

async function load(body = ARTICLE, lang = 'en', title = TITLE): Promise<void> {
  fixture = documentHtml(body, lang, title);
  await page.goto(FIXTURE_URL);
  await expect(page.locator('near-page-translate .np-primary')).toBeVisible();
}

function reader(): Locator { return page.getByRole('dialog', { name: '近译阅读模式', exact: true }); }
function content(): Locator { return reader().locator('.nr-content'); }

async function openReader(): Promise<void> {
  await page.locator('near-page-translate .np-primary').hover();
  await page.getByRole('button', { name: '阅读模式', exact: true }).click();
  await expect(reader()).toBeVisible();
  await expect(content().locator(':scope > article')).toBeVisible();
}

async function storedPreferences(): Promise<Record<string, unknown>> {
  return worker.evaluate(async () => {
    const api = (globalThis as unknown as { chrome: TestBrowserApi }).chrome;
    return (await api.storage.local.get('reading-preferences:v1'))['reading-preferences:v1'] as Record<string, unknown>;
  });
}

async function advancedSettings(): Promise<void> {
  const advanced = reader().locator('.nr-advanced-settings');
  if (!await advanced.evaluate(element => (element as HTMLDetailsElement).open)) await advanced.locator('summary').click();
}

test.beforeAll(async () => {
  const extension = resolve('.output/e2e-extension');
  profile = await mkdtemp(resolve('.output/e2e-profile-reading-'));
  const channel = process.env.NEAR_BROWSER_CHANNEL ?? 'chromium';
  const executablePath = process.env.NEAR_BROWSER_EXECUTABLE;
  const branded = channel !== 'chromium' || !!executablePath;
  context = await chromium.launchPersistentContext(profile, {
    channel, executablePath, headless: true, ignoreDefaultArgs: ['--disable-extensions'], reducedMotion: 'reduce',
    viewport: { width: 1440, height: 1000 },
    args: branded ? ['--enable-unsafe-extension-debugging'] : [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  if (branded) {
    const browser = context.browser();
    if (!browser) throw new Error('Missing isolated browser connection.');
    const debug = await browser.newBrowserCDPSession();
    await debug.send('Extensions.loadUnpacked', { path: extension }); await debug.detach();
  }
  await context.route(/^https?:\/\/(?!127\.0\.0\.1:4177\/)/, route => route.abort('blockedbyclient'));
  await context.route(FIXTURE_URL, route => route.fulfill({ status: 200, contentType: 'text/html', body: fixture }));
  await context.route(IMAGE_URL, route => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="160"><rect width="640" height="160" fill="#dce6d9"/><path d="M80 100h480M160 50v100M320 50v100M480 50v100" stroke="#386746" stroke-width="4"/></svg>' }));
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  extensionId = new URL(worker.url()).host;
  await installFakeApi();
  options = await context.newPage();
});

test.beforeEach(async () => {
  // Edge exposes its native downloads popover as a page after a JSON export.
  // It is browser chrome, not an owned fixture tab; Page.close can hang on it.
  for (const open of context.pages()) if (open !== options && !/^(?:edge|chrome):/.test(open.url())) await open.close();
  await configureFake({ requests: [], batches: 0, active: 0, cancellations: 0, blockedExternal: [], delayMs: 70, tailDelayMs: 0, ignoreAbort: false, lateAttempts: 0 });
  await worker.evaluate(async preferences => {
    const api = (globalThis as unknown as { chrome: TestBrowserApi }).chrome;
    await api.storage.local.set({ 'reading-preferences:v1': preferences });
  }, DEFAULT_PREFERENCES);
  await saveSettings();
  page = await context.newPage();
  await load();
});

test.afterEach(async ({}, info) => {
  if (worker) {
    const captured = await state();
    await info.attach('reading-service-state.json', { body: JSON.stringify(captured, null, 2), contentType: 'application/json' });
    expect(captured.blockedExternal).toEqual([]);
  }
});

test.afterAll(async () => {
  await context?.close();
  if (!profile) return;
  const workspace = await realpath('.');
  const actual = await realpath(profile);
  const local = relative(workspace, actual).replaceAll('\\', '/');
  if (!local.startsWith('.output/e2e-profile-reading-')) throw new Error('Refuse deleting an external browser profile.');
  await rm(actual, { recursive: true, force: true });
});

test('English and Chinese reading work locally without a Key and preserve article details', async ({}, info) => {
  await saveSettings(true);
  await load();
  const original = await page.locator('#source-article').innerHTML();
  await openReader();
  await expect(reader().getByRole('heading', { name: TITLE, exact: true })).toBeVisible();
  await expect(content().locator('pre code')).toHaveText(CODE);
  await expect(content().getByRole('img', { name: 'A local reading diagram' })).toBeVisible();
  await expect(content().getByText(CHINESE, { exact: true })).toBeVisible();
  await expect(reader().getByRole('navigation', { name: '文章章节' }).getByRole('button', { name: 'Keep the details', exact: true })).toBeVisible();
  await expect(content().locator('textarea,[contenteditable],script')).toHaveCount(0);
  await expect(content()).not.toContainText('must not enter the reader');
  expect((await state()).requests).toEqual([]);
  expect(await page.locator('#source-article').innerHTML()).toBe(original);
  await page.screenshot({ path: info.outputPath('reading-local-sepia.png') });
  await page.keyboard.press('Escape');
  await expect(reader()).toHaveCount(0);
  const chineseBody = `<article id="source-article"><h1>让技术文章更容易阅读</h1><h2>完整保留上下文</h2><p>${CHINESE}</p><p>${CHINESE}</p><h2>按照自己的节奏</h2><p>${CHINESE}</p></article>`;
  await load(chineseBody, 'zh-CN', '让技术文章更容易阅读');
  await openReader();
  await expect(reader().getByRole('heading', { name: '让技术文章更容易阅读', exact: true })).toBeVisible();
  await expect(content()).toContainText(CHINESE);
  expect((await state()).requests).toEqual([]);
});

test('mode changes make no requests and only completed text is hidden in translation mode', async () => {
  await openReader();
  const modes = reader().getByRole('group', { name: '正文显示模式' });
  for (const mode of ['双语', '仅译文', '原文', '仅译文']) await modes.getByRole('button', { name: mode, exact: true }).click();
  await expect(reader().getByText('尚无译文，暂时显示原文。', { exact: false })).toBeVisible();
  await expect(content().getByText(FIRST, { exact: true })).toBeVisible();
  expect((await state()).requests).toEqual([]);
  await configureFake({ tailDelayMs: 1_500 });
  await reader().getByRole('button', { name: '翻译正文', exact: true }).click();
  const finished = content().locator('[data-near-reader-translation][data-state=done]');
  await expect(finished.first()).toBeVisible();
  await expect(content().locator('[data-near-reader-original][data-near-reader-translated=true]').first()).toBeHidden();
  await expect(content().locator('[data-near-reader-original]:not([data-near-reader-translated=true])').first()).toBeVisible();
  await reader().getByRole('button', { name: '停止翻译', exact: true }).click();
  const sent = (await state()).requests.length;
  await modes.getByRole('button', { name: '原文', exact: true }).click();
  await expect(finished.first()).toBeHidden();
  await modes.getByRole('button', { name: '双语', exact: true }).click();
  await expect(finished.first()).toBeVisible();
  await expect(content().locator('[data-near-reader-original][data-near-reader-translated=true]').first()).toBeVisible();
  expect((await state()).requests).toHaveLength(sent);
  await configureFake({ tailDelayMs: 0 });
  await reader().getByRole('button', { name: '继续翻译', exact: true }).click();
  await expect(reader().getByRole('button', { name: '翻译完成', exact: true })).toBeDisabled();
  await expect(content().getByText(UNSAFE_TRANSLATION, { exact: true })).toBeVisible();
  await expect(content().locator('[data-near-reader-translation] img')).toHaveCount(0);
  expect(await page.evaluate(() => (window as typeof window & { readerTranslationExecuted?: boolean }).readerTranslationExecuted)).toBeUndefined();
  expect((await state()).requests.every(request => !request.text.includes(CHINESE) && !request.text.includes('console.log(revision)'))).toBe(true);
});

test('completed reading translations survive closing and reopen without another provider request', async () => {
  await openReader();
  await reader().getByRole('button', { name: '翻译正文', exact: true }).click();
  await expect(reader().getByRole('button', { name: '翻译完成', exact: true })).toBeDisabled();
  const sent = (await state()).requests.length;
  expect(sent).toBeGreaterThan(0);
  await reader().getByRole('button', { name: '退出阅读模式', exact: true }).click();
  await openReader();
  await reader().getByRole('button', { name: '双语', exact: true }).click();
  await expect(content().locator('[data-near-reader-translation][data-state=done]').first()).toBeVisible();
  expect((await state()).requests).toHaveLength(sent);
  // Even an explicit cached translation reuses validated local results.
  await reader().getByRole('button', { name: '翻译正文', exact: true }).click();
  await expect(reader().getByRole('button', { name: '翻译完成', exact: true })).toBeDisabled();
  expect((await state()).requests).toHaveLength(sent);
});

test('the already translated source page seeds the reader without sending the article twice', async () => {
  await page.getByRole('button', { name: '翻译整个页面', exact: true }).click();
  await expect(page.getByRole('button', { name: '恢复原文', exact: true })).toBeVisible();
  const sent = (await state()).requests.length;
  expect(sent).toBeGreaterThan(0);
  const sourceTranslated = await page.locator('#source-article').innerHTML();
  await openReader();
  await reader().getByRole('button', { name: '双语', exact: true }).click();
  await expect(content().locator('[data-near-reader-translation][data-state=done]').first()).toBeVisible();
  await expect(content()).toContainText(`译文：${FIRST}`);
  expect((await state()).requests).toHaveLength(sent);
  await expect(content().getByRole('heading', { name: 'Read with context', exact: true })).toBeVisible();
  await reader().getByRole('button', { name: '翻译正文', exact: true }).click();
  await expect(reader().getByRole('button', { name: '翻译完成', exact: true })).toBeDisabled();
  expect((await state()).requests).toHaveLength(sent);
  await page.keyboard.press('Escape');
  expect(await page.locator('#source-article').innerHTML()).toBe(sourceTranslated);
});

test('display preferences persist across documents without including article text or credentials', async () => {
  await openReader();
  await reader().getByRole('button', { name: '深色主题', exact: true }).click();
  await reader().getByRole('button', { name: '无衬线字体', exact: true }).click();
  await reader().getByRole('button', { name: '增大字号', exact: true }).click();
  await reader().getByRole('button', { name: '增大字号', exact: true }).click();
  await reader().getByRole('button', { name: '宽阔栏宽', exact: true }).click();
  const lineHeight = reader().getByRole('slider', { name: '阅读行间距', exact: true });
  await lineHeight.press('Home');
  for (let step = 0; step < 12; step++) await lineHeight.press('ArrowRight');
  await reader().getByRole('switch', { name: '段落专注', exact: true }).click();
  await reader().getByRole('button', { name: '双语', exact: true }).click();
  const expected = { ...DEFAULT_PREFERENCES, theme: 'dark', fontSize: 22, lineHeight: 2, width: 'wide', fontFamily: 'sans', mode: 'bilingual', focus: true };
  await expect.poll(async () => worker.evaluate(async () => {
    const api = (globalThis as unknown as { chrome: TestBrowserApi }).chrome;
    return (await api.storage.local.get('reading-preferences:v1'))['reading-preferences:v1'];
  })).toEqual(expected);
  expect(await page.locator('near-reading-mode').evaluate(element => element.shadowRoot?.innerHTML ?? '')).not.toContain(TEST_KEY);
  await page.keyboard.press('Escape');
  await page.reload();
  await openReader();
  await expect(reader().locator('.nr-reader')).toHaveAttribute('data-theme', 'dark');
  await expect(reader().getByRole('slider', { name: '阅读字号', exact: true })).toHaveValue('22');
  await expect(reader().getByRole('slider', { name: '阅读行间距', exact: true })).toHaveValue('2');
  await expect(reader().getByRole('switch', { name: '段落专注', exact: true })).toBeChecked();
  await expect(reader().getByRole('button', { name: '宽阔栏宽', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect((await state()).requests).toEqual([]);
});

test('scene and personal styles are reversible, persist, and leave bilingual mode and translation untouched', async ({}, info) => {
  await openReader();
  await expect(reader().locator('.nr-advanced-settings')).not.toHaveAttribute('open');
  await reader().getByRole('button', { name: '双语', exact: true }).click();
  await reader().getByRole('button', { name: '技术文档', exact: true }).click();
  await expect(reader().locator('.nr-reader')).toHaveAttribute('data-mode', 'bilingual');
  await expect(content()).toHaveCSS('font-size', '19px');
  await reader().getByRole('button', { name: '增大字号', exact: true }).click();
  await reader().getByRole('button', { name: '保存为我的样式', exact: true }).click();
  await expect.poll(async () => (await storedPreferences()).savedStyle).toMatchObject({ theme: 'paper', fontSize: 20 });
  await reader().getByRole('button', { name: '夜间阅读', exact: true }).click();
  await expect(content()).toHaveCSS('font-size', '22px');
  await expect(reader().locator('.nr-reader')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: info.outputPath('reading-night-preset.png') });
  await reader().getByRole('button', { name: '应用我的样式', exact: true }).click();
  await expect(content()).toHaveCSS('font-size', '20px');
  await expect(reader().locator('.nr-reader')).toHaveAttribute('data-theme', 'paper');
  await reader().getByRole('button', { name: '恢复默认', exact: true }).click();
  await expect(reader().locator('.nr-reader')).toHaveAttribute('data-theme', 'sepia');
  await reader().getByRole('button', { name: '撤销上次调整', exact: true }).click();
  await expect(reader().locator('.nr-reader')).toHaveAttribute('data-theme', 'paper');
  await expect(reader().locator('.nr-reader')).toHaveAttribute('data-mode', 'bilingual');
  await expect.poll(storedPreferences).toMatchObject({ theme: 'paper', fontSize: 20, mode: 'bilingual', savedStyle: { fontSize: 20 } });
  await page.reload(); await openReader();
  await expect(reader().locator('.nr-reader')).toHaveAttribute('data-theme', 'paper');
  await expect(reader().getByRole('button', { name: '应用我的样式', exact: true })).toBeEnabled();
  expect((await state()).requests).toEqual([]);
});

test('advanced typography, code wrapping and bilingual layers update real content without another request', async ({}, info) => {
  await openReader();
  await reader().getByRole('button', { name: '翻译正文', exact: true }).click();
  await expect(reader().getByRole('button', { name: '翻译完成', exact: true })).toBeDisabled();
  const requestsBefore = (await state()).requests.length;
  await advancedSettings();
  await reader().getByRole('slider', { name: '阅读字间距', exact: true }).press('End');
  const word = reader().getByRole('slider', { name: '阅读词间距', exact: true });
  await word.press('Home'); for (let i = 0; i < 8; i++) await word.press('ArrowRight');
  await reader().getByRole('slider', { name: '阅读段落间距', exact: true }).press('End');
  await reader().getByRole('slider', { name: '阅读自定义栏宽', exact: true }).press('End');
  await reader().getByRole('button', { name: '两端对齐', exact: true }).click();
  await reader().getByRole('switch', { name: '代码自动换行', exact: true }).click();
  await reader().getByRole('button', { name: '卡片对照', exact: true }).click();
  await reader().getByRole('slider', { name: '阅读译文字号比例', exact: true }).press('Home');
  await expect(content()).toHaveCSS('letter-spacing', '2.4px');
  await expect(content()).toHaveCSS('word-spacing', '3.2px');
  await expect(content()).toHaveCSS('text-align', 'justify');
  await expect(content().locator('pre')).toHaveCSS('white-space', 'pre-wrap');
  await expect(content().locator('pre')).toHaveText(CODE);
  const translated = content().locator('p[data-near-reader-source] [data-near-reader-translation][data-state=done]').first();
  await expect(translated).toHaveCSS('font-size', '16px');
  await expect(translated).toHaveCSS('border-top-width', '1px');
  await expect.poll(storedPreferences).toMatchObject({ width: 'custom', columnWidth: 1080, letterSpacing: .12, wordSpacing: .16,
    paragraphSpacing: 2, codeWrap: true, translationStyle: 'card', translationScale: .8 });
  await page.screenshot({ path: info.outputPath('reading-bilingual-custom.png') });
  await reader().getByRole('button', { name: '仅译文', exact: true }).click();
  await reader().getByRole('button', { name: '原文', exact: true }).click();
  await reader().getByRole('button', { name: '双语', exact: true }).click();
  expect((await state()).requests).toHaveLength(requestsBefore);
});

test('custom palettes can repair contrast and the system theme follows the device', async () => {
  await openReader();
  await reader().getByRole('button', { name: '自定义主题', exact: true }).click();
  await reader().getByLabel('自定义背景颜色', { exact: true }).fill('#eeeeee');
  await reader().getByLabel('自定义文字颜色', { exact: true }).fill('#eeeeee');
  await expect(reader().locator('.nr-contrast-note')).toContainText('1.00');
  await expect(content()).toHaveCSS('color', 'rgb(238, 238, 238)');
  await reader().getByRole('button', { name: '提高文字对比度', exact: true }).click();
  await expect(content()).toHaveCSS('color', 'rgb(0, 0, 0)');
  await expect(reader().getByRole('button', { name: '提高文字对比度', exact: true })).toHaveCount(0);
  await reader().getByRole('button', { name: '跟随系统主题', exact: true }).click();
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(reader().locator('.nr-reader')).toHaveCSS('background-color', 'rgb(23, 35, 30)');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(reader().locator('.nr-reader')).not.toHaveCSS('background-color', 'rgb(23, 35, 30)');
  expect((await state()).requests).toEqual([]);
});

test('changing the layout keeps the current passage at the reading line', async () => {
  const long = `<article id="source-article"><h1>Long reading session</h1>${Array.from({ length: 20 }, (_, index) =>
    `<h2>Chapter ${index + 1}</h2><p>${FIRST} ${SECOND} Passage ${index + 1}.</p>`).join('')}</article>`;
  await load(long); await openReader();
  await reader().getByRole('navigation', { name: '文章章节' }).getByRole('button', { name: 'Chapter 10', exact: true }).click();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const point = await reader().locator('.nr-scroll').evaluate(element => {
    const line = element.getBoundingClientRect().top + 150;
    const block = Array.from(element.querySelectorAll<HTMLElement>('[data-near-reader-source]')).find(node => {
      const box = node.getBoundingClientRect(); return node.tagName === 'P' && box.top <= line && box.bottom >= line;
    });
    if (!block) throw new Error('Fixture must place a passage across the reading line.');
    const box = block.getBoundingClientRect();
    return { id: block.dataset.nearReaderSource!, fraction: (line - box.top) / box.height, offset: 150 };
  });
  await reader().getByRole('button', { name: '夜间阅读', exact: true }).click();
  await expect.poll(async () => reader().locator('.nr-scroll').evaluate((element, point) => {
    const block = element.querySelector<HTMLElement>(`[data-near-reader-source="${point.id}"]`)!;
    const box = block.getBoundingClientRect();
    return Math.abs(box.top + box.height * point.fraction - element.getBoundingClientRect().top - point.offset);
  }, point)).toBeLessThan(4);
  await reader().getByRole('button', { name: '宽阔栏宽', exact: true }).click();
  await expect.poll(async () => reader().locator('.nr-scroll').evaluate((element, point) => {
    const block = element.querySelector<HTMLElement>(`[data-near-reader-source="${point.id}"]`)!;
    const box = block.getBoundingClientRect();
    return Math.abs(box.top + box.height * point.fraction - element.getBoundingClientRect().top - point.offset);
  }, point)).toBeLessThan(4);
  expect((await state()).requests).toEqual([]);
});

test('display save failures are visible and retry succeeds without losing the preview', async () => {
  await openReader();
  await worker.evaluate(() => {
    const global = globalThis as unknown as { chrome: TestBrowserApi; __restoreReadingStorage?: () => void };
    const storage = global.chrome.storage.local; const original = storage.set;
    global.__restoreReadingStorage = () => { storage.set = original; };
    storage.set = async items => { if ('reading-preferences:v1' in items) throw new Error('isolated preference test failure'); await original.call(storage, items); };
  });
  try {
    await reader().getByRole('button', { name: '深色主题', exact: true }).click();
    await expect(reader().locator('.nr-save-status')).toContainText('显示偏好保存失败');
    await expect(reader().locator('.nr-reader')).toHaveAttribute('data-theme', 'dark');
    await worker.evaluate(() => { (globalThis as unknown as { __restoreReadingStorage?: () => void }).__restoreReadingStorage?.(); });
    await reader().getByRole('button', { name: '重试保存显示偏好', exact: true }).click();
    await expect(reader().locator('.nr-save-status')).toContainText('显示偏好已自动保存');
    expect((await storedPreferences()).theme).toBe('dark');
  } finally {
    await worker.evaluate(() => { (globalThis as unknown as { __restoreReadingStorage?: () => void }).__restoreReadingStorage?.(); });
  }
  expect((await state()).requests).toEqual([]);
});

test('appearance files round trip while malformed imports preserve the current style', async () => {
  await openReader();
  await reader().getByRole('button', { name: '技术文档', exact: true }).click();
  const waiting = page.waitForEvent('download');
  await reader().getByRole('button', { name: '导出版式', exact: true }).click();
  const download = await waiting;
  const location = await download.path();
  if (!location) throw new Error('Appearance download missing.');
  const json = await readFile(location, 'utf8');
  const envelope = JSON.parse(json);
  expect(envelope).toMatchObject({ format: 'near-translate-reading-style', version: 1, style: { theme: 'paper', fontSize: 19 } });
  expect(json).not.toMatch(/apiKey|fake-reading|source-first|savedStyle|"mode"/);
  await reader().getByRole('button', { name: '夜间阅读', exact: true }).click();
  const input = reader().getByLabel('导入阅读版式文件', { exact: true });
  await input.setInputFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{invalid') });
  await expect(reader().locator('.nr-reader')).toHaveAttribute('data-theme', 'dark');
  await expect(reader().locator('.nr-settings-content')).toContainText('有效的 JSON');
  await input.setInputFiles({ name: 'my-style.json', mimeType: 'application/json', buffer: Buffer.from(json) });
  await expect(reader().locator('.nr-reader')).toHaveAttribute('data-theme', 'paper');
  await expect(content()).toHaveCSS('font-size', '19px');
  expect((await state()).requests).toEqual([]);
});

test('200 percent browser zoom retains keyboard access to customization and content', async ({}, info) => {
  await openReader();
  type ZoomApi = { tabs: { query: (query: { url: string }) => Promise<Array<{ id?: number }>>;
    setZoomSettings: (id: number, settings: { mode: string; scope: string }) => Promise<void>;
    setZoom: (id: number, factor: number) => Promise<void> } };
  const tabId = await worker.evaluate(async url => {
    const api = (globalThis as unknown as { chrome: ZoomApi }).chrome;
    const [tab] = await api.tabs.query({ url });
    if (tab?.id === undefined) throw new Error('Isolated fixture tab missing.');
    await api.tabs.setZoomSettings(tab.id, { mode: 'automatic', scope: 'per-tab' });
    await api.tabs.setZoom(tab.id, 2); return tab.id;
  }, FIXTURE_URL);
  try {
    await reader().getByRole('button', { name: '显示设置', exact: true }).click();
    const panel = await reader().locator('.nr-settings').boundingBox();
    const topbar = await reader().locator('.nr-topbar').boundingBox();
    expect(Math.abs(panel!.y - topbar!.y - topbar!.height)).toBeLessThanOrEqual(1);
    const size = reader().getByRole('slider', { name: '阅读字号', exact: true });
    await size.focus(); await size.press('End');
    await expect(size).toHaveValue('36');
    await advancedSettings();
    await reader().getByRole('slider', { name: '阅读字间距', exact: true }).press('End');
    await reader().getByRole('slider', { name: '阅读词间距', exact: true }).press('End');
    await reader().getByRole('slider', { name: '阅读段落间距', exact: true }).press('End');
    await reader().getByRole('switch', { name: '代码自动换行', exact: true }).click();
    await page.screenshot({ path: info.outputPath('reading-zoom-200-settings.png') });
    await reader().getByRole('button', { name: '关闭显示设置', exact: true }).click();
    await expect(reader().getByRole('button', { name: '显示设置', exact: true })).toBeFocused();
    expect(await reader().locator('.nr-scroll').evaluate(element => (element as HTMLElement).inert)).toBe(false);
    const sizes = await reader().evaluate(element => ['.nr-reader', '.nr-scroll', '.nr-paper'].map(selector => {
      const node = element.querySelector(selector)!; return { width: node.clientWidth, scroll: node.scrollWidth };
    }));
    for (const size of sizes) expect(size.scroll).toBeLessThanOrEqual(size.width + 1);
  } finally {
    await worker.evaluate(async id => { await (globalThis as unknown as { chrome: ZoomApi }).chrome.tabs.setZoom(id, 1); }, tabId);
  }
  expect((await state()).requests).toEqual([]);
});

test('keyboard entry and Escape preserve source focus and discard slow late translation results', async () => {
  const original = await page.locator('#source-article').innerHTML();
  await page.locator('#source-control').evaluate(element => { (element as HTMLElement).focus({ preventScroll: true }); window.scrollTo(0, 350); });
  const originalScroll = await page.evaluate(() => window.scrollY);
  await page.keyboard.press('Alt+Shift+R');
  await expect(reader()).toBeVisible();
  await expect(content().locator(':scope > article')).toBeVisible();
  await page.keyboard.press('Tab');
  expect(await page.locator('near-reading-mode').evaluate(element => {
    const shadow = element.shadowRoot;
    return Boolean(shadow?.querySelector('dialog')?.contains(shadow.activeElement));
  })).toBe(true);
  await configureFake({ delayMs: 1_000, ignoreAbort: true });
  await reader().getByRole('button', { name: '翻译正文', exact: true }).click();
  await expect.poll(async () => (await state()).active).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  await expect(reader()).toHaveCount(0);
  await expect(page.locator('#source-control')).toBeFocused();
  expect(await page.evaluate(() => window.scrollY)).toBe(originalScroll);
  expect(await page.locator('#source-article').innerHTML()).toBe(original);
  await expect.poll(async () => (await state()).cancellations).toBeGreaterThan(0);
  await page.keyboard.press('Alt+Shift+R');
  await expect(reader()).toBeVisible();
  await expect.poll(async () => (await state()).lateAttempts).toBeGreaterThan(0);
  await expect.poll(async () => (await state()).active).toBe(0);
  await expect(content().locator('[data-near-reader-translation][data-state=done]')).toHaveCount(0);
  expect(await page.locator('#source-article').innerHTML()).toBe(original);
});

test('outline and progress follow reading and a paragraph can return to its original page location', async () => {
  const longBody = `<article id="source-article"><h1>${TITLE}</h1>${Array.from({ length: 16 }, (_, index) => `<h2 id="source-section-${index + 1}">Section ${index + 1}</h2><p>${FIRST}</p><p>${SECOND}</p>`).join('')}</article>`;
  await load(longBody);
  const original = await page.locator('#source-article').innerHTML();
  await openReader();
  const chapter = reader().getByRole('navigation', { name: '文章章节' }).getByRole('button', { name: 'Section 12', exact: true });
  await chapter.click();
  await expect(chapter).toHaveAttribute('aria-current', 'location');
  await expect.poll(async () => Number(await reader().getByRole('progressbar', { name: '阅读进度', exact: true }).getAttribute('aria-valuenow'))).toBeGreaterThan(40);
  await reader().locator('.nr-scroll').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(reader().getByRole('progressbar', { name: '阅读进度', exact: true })).toHaveAttribute('aria-valuenow', '100');
  const heading = content().getByRole('heading', { name: 'Section 12', exact: true });
  await heading.scrollIntoViewIfNeeded();
  await heading.hover();
  await heading.getByRole('button', { name: '回到原文位置', exact: true }).click();
  await expect(reader()).toHaveCount(0);
  const box = await page.locator('#source-section-12').boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeLessThan(1000);
  expect(await page.locator('#source-article').innerHTML()).toBe(original);
  expect((await state()).requests).toEqual([]);
});

test('selection translation stays inside the reader and closing cancels its request', async () => {
  await openReader();
  await configureFake({ delayMs: 1_000, ignoreAbort: true });
  await content().getByText(FIRST, { exact: true }).evaluate(element => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const shadow = element.getRootNode() as ShadowRoot & { getSelection?: () => Selection | null };
    const selection = shadow.getSelection?.() ?? document.getSelection();
    if (!selection) throw new Error('Missing reader selection.');
    selection.removeAllRanges();
    selection.addRange(range);
    const box = element.getBoundingClientRect();
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true, clientX: box.x + 20, clientY: box.y + 20 }));
  });
  const trigger = reader().getByRole('button', { name: '翻译选中文字', exact: true });
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(reader().getByRole('dialog', { name: '翻译结果', exact: true })).toBeVisible();
  await expect.poll(async () => (await state()).active).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  await expect(reader()).toHaveCount(0);
  await expect.poll(async () => (await state()).cancellations).toBeGreaterThan(0);
  await expect.poll(async () => (await state()).lateAttempts).toBeGreaterThan(0);
  await expect.poll(async () => (await state()).active).toBe(0);
  await expect(page.locator('near-translate')).toHaveCount(1);
  await expect(page.locator('.nt-card')).toHaveCount(0);
  await openReader();
  await expect(reader().locator('near-translate')).toHaveCount(1);
  await expect(reader().getByRole('dialog', { name: '翻译结果', exact: true })).toHaveCount(0);
});

test('narrow screens use accessible drawers and contain long code and wide tables', async ({}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openReader();
  await expect(reader().locator('.nr-settings')).toBeHidden();
  await reader().getByRole('button', { name: '显示设置', exact: true }).click();
  await expect(reader().getByRole('button', { name: '深色主题', exact: true })).toBeVisible();
  const panel = await reader().locator('.nr-settings').boundingBox();
  const topbar = await reader().locator('.nr-topbar').boundingBox();
  expect(Math.abs(panel!.y - topbar!.y - topbar!.height)).toBeLessThanOrEqual(1);
  await reader().getByRole('button', { name: '纸白主题', exact: true }).click();
  await reader().getByRole('button', { name: '关闭显示设置', exact: true }).click();
  await expect(reader().getByRole('button', { name: '显示设置', exact: true })).toBeFocused();
  await reader().getByRole('button', { name: '阅读目录', exact: true }).click();
  await expect(reader().getByRole('navigation', { name: '文章章节' })).toBeVisible();
  await reader().getByRole('button', { name: '关闭目录', exact: true }).click();
  await expect(reader().getByRole('button', { name: '阅读目录', exact: true })).toBeFocused();
  const dimensions = await reader().evaluate(element => {
    const selectors = ['.nr-reader', '.nr-scroll', '.nr-paper'];
    return selectors.map(selector => { const node = element.querySelector(selector)!; return { selector, width: node.clientWidth, scroll: node.scrollWidth }; });
  });
  for (const item of dimensions) expect(item.scroll, item.selector).toBeLessThanOrEqual(item.width + 1);
  expect(await content().locator('pre').evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  expect(await content().locator('table').evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('reading-narrow-paper.png') });
  await reader().getByRole('button', { name: '显示设置', exact: true }).click();
  expect(await reader().locator('.nr-scroll').evaluate(element => (element as HTMLElement).inert)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect.poll(async () => reader().locator('.nr-scroll').evaluate(element => (element as HTMLElement).inert)).toBe(false);
  await expect(reader().locator('.nr-scrim')).toBeHidden();
  await reader().locator('.nr-scroll').focus();
  await expect(reader().locator('.nr-scroll')).toBeFocused();
  expect((await state()).requests).toEqual([]);
});

test('a narrow-screen outline selection reaches the chosen chapter after its drawer closes', async () => {
  const long = `<article id="source-article"><h1>Mobile reading</h1>${Array.from({ length: 16 }, (_, index) =>
    `<h2>Mobile chapter ${index + 1}</h2><p>${FIRST} ${SECOND}</p>`).join('')}</article>`;
  await load(long); await page.setViewportSize({ width: 390, height: 844 }); await openReader();
  await reader().getByRole('button', { name: '阅读目录', exact: true }).click();
  await reader().getByRole('navigation', { name: '文章章节' }).getByRole('button', { name: 'Mobile chapter 12', exact: true }).click();
  await expect(reader().locator('.nr-outline')).toBeHidden();
  await expect.poll(async () => reader().locator('.nr-scroll').evaluate(element => {
    const heading = Array.from(element.querySelectorAll('h2')).find(node => node.textContent?.startsWith('Mobile chapter 12'))!;
    return heading.getBoundingClientRect().top - element.getBoundingClientRect().top;
  })).toBeLessThan(100);
  const heading = await content().getByRole('heading', { name: 'Mobile chapter 12', exact: true }).boundingBox();
  const header = await reader().locator('.nr-header').boundingBox();
  expect(heading!.y).toBeGreaterThanOrEqual(header!.y + header!.height);
  expect((await state()).requests).toEqual([]);
});

test('translation tools remain in the header after scrolling at desktop and narrow widths', async ({}, info) => {
  const long = `<article id="source-article"><h1>Read without hunting for controls</h1>${Array.from({ length: 16 }, (_, index) =>
    `<h2>Chapter ${index + 1}</h2><p>${FIRST} ${SECOND}</p>`).join('')}</article>`;
  await load(long); await openReader();
  for (const width of [1440, 861, 860, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const controls = reader().getByRole('group', { name: '阅读翻译工具', exact: true });
    await expect(controls.getByRole('button', { name: '翻译正文', exact: true })).toBeVisible();
    expect(await reader().locator('.nr-paper .nr-reading-tools').count()).toBe(0);
    const box = await controls.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    const header = await reader().locator('.nr-header').boundingBox();
    expect(box!.y + box!.height).toBeLessThanOrEqual(header!.y + header!.height);
    await reader().locator('.nr-scroll').evaluate(element => { element.scrollTop = element.scrollHeight / 2; });
    await expect(controls.getByRole('button', { name: '双语', exact: true })).toBeVisible();
    const afterScroll = await controls.boundingBox();
    expect(afterScroll!.y).toBeCloseTo(box!.y, 1);
    const dimensions = await reader().locator('.nr-header').evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth }));
    expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width + 1);
    if (width === 1440 || width === 390) await page.screenshot({ path: info.outputPath(`reading-toolbar-${width}.png`) });
  }
  expect((await state()).requests).toEqual([]);
  await configureFake({ delayMs: 1_000 });
  await reader().getByRole('button', { name: '翻译正文', exact: true }).click();
  await expect(reader().locator('.nr-header-status')).toBeVisible();
  await expect(reader().getByRole('button', { name: '停止翻译', exact: true })).toBeVisible();
  await reader().getByRole('button', { name: '显示设置', exact: true }).click();
  const panel = await reader().locator('.nr-settings').boundingBox();
  const header = await reader().locator('.nr-header').boundingBox();
  const scrim = await reader().locator('.nr-scrim').boundingBox();
  expect(panel!.y).toBeCloseTo(header!.y + header!.height, 0);
  expect(scrim!.y).toBeCloseTo(header!.y + header!.height, 0);
  await reader().getByRole('button', { name: '关闭显示设置', exact: true }).click();
  await reader().getByRole('button', { name: '停止翻译', exact: true }).click();
  await expect(reader().locator('.nr-header-status')).toContainText('翻译已停止');
  await page.emulateMedia({ media: 'print' });
  await expect(reader().locator('.nr-header')).toBeHidden();
  await expect(reader().locator('.nr-content')).toBeVisible();
});
