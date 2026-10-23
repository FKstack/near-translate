import { test, expect, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

const BASE = 'http://127.0.0.1:4177';
const FIXTURE_URL = `${BASE}/whole-page`;
const TRANSLATIONS: Record<string, string> = {
  'Language Design for Software Engineering': '为软件工程服务的语言设计',
  'Go was designed to make software engineering more productive.': 'Go 的设计旨在提高软件工程的生产力。',
  'Run go build to compile the package.': '运行 go build 来编译这个包。',
  'Manage dependencies explicitly.': '显式管理依赖关系。',
  'Keep interfaces small.': '保持接口精简。',
  'Concurrent work': '并发任务',
  'Goroutines': '协程',
  'Repeated text is translated only once.': '重复的文本只翻译一次。',
  'Render translated HTML as plain text.': '<img src=x onerror="window.translationExecuted=true">译文保持纯文本。',
  'Retry this paragraph after a temporary service failure.': '服务暂时失败后，重试这一段。',
  'Another paragraph succeeds immediately.': '另一段立即翻译成功。',
  'Dynamically appended content also needs translation.': '动态追加的内容也需要翻译。',
  'Slow page request number one.': '页面慢请求一。',
  'Slow page request number two.': '页面慢请求二。',
};

function documentHtml(body: string, dark = false): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Whole-page translation fixture</title>
    <style>body{margin:0;background:${dark ? '#202324' : '#f1f5f4'};color:${dark ? '#f4f6f5' : '#20332e'};font:17px/1.75 system-ui,sans-serif}main{max-width:900px;margin:36px auto;padding:30px 44px;background:${dark ? '#202324' : 'white'};border-radius:16px}h1{font-size:32px;line-height:1.3}p{margin:18px 0}a{color:${dark ? '#5dd1e8' : '#007e9c'}}pre{padding:14px;background:${dark ? '#151718' : '#e8eeeb'};border-radius:8px}table{border-collapse:collapse}td{padding:7px 20px;border:1px solid #82948b}img{width:180px;height:70px}button{font:inherit}</style>
    </head><body><main>${body}</main></body></html>`;
}

const ARTICLE = `<h1 id="title">Language Design for Software Engineering</h1>
  <p id="prose">Go was <strong>designed</strong> to make <a href="#title">software engineering</a> more productive.</p>
  <p id="inline-code">Run <code>go build</code> to compile the package.</p>
  <pre id="code"><code>func main() {\n  fmt.Println("Do not translate this code block")\n}</code></pre>
  <img id="diagram" alt="Do not translate image content" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='70'%3E%3Crect width='180' height='70' fill='%230eafba'/%3E%3C/svg%3E">
  <ul><li>Manage dependencies explicitly.</li><li>Keep interfaces small.</li></ul>
  <table><tbody><tr><td>Concurrent work</td><td>Goroutines</td></tr></tbody></table>
  <p class="repeat">Repeated text is translated only once.</p><p class="repeat">Repeated text is translated only once.</p>
  <p id="chinese">这是一段已有的中文内容，无需再次翻译。</p>
  <p hidden>Hidden content must not leave the page.</p>
  <p style="display:none">Invisible content must not leave the page.</p>
  <p aria-hidden="true">Assistive hidden content must not leave the page.</p>
  <p translate="no">Excluded content must not leave the page.</p>
  <textarea aria-label="Draft">Unsubmitted draft must not leave the page.</textarea>
  <div contenteditable="true">Editable content must not leave the page.</div>`;

type Captured = { selectedText: string; model: string; thinking: { type: string } };
type FakeState = {
  requests: Captured[];
  batches: number;
  active: number;
  maxActive: number;
  cancellations: number;
  failText?: string;
  failStatus: number;
  failuresRemaining: number;
  slowAll: boolean;
  delayTail: boolean;
  latencyMs: number;
  perItemMs: number;
};

let context: BrowserContext;
let worker: Worker;
let extensionId: string;
let profile: string;
let options: Page;
let page: Page;
let fixture = documentHtml(ARTICLE);

async function installFakeApi(): Promise<void> {
  await worker.evaluate((translations) => {
    const global = globalThis as typeof globalThis & { __nearPageTest: FakeState };
    const nativeFetch = global.fetch.bind(global);
    global.__nearPageTest = { requests: [], batches: 0, active: 0, maxActive: 0, cancellations: 0,
      failStatus: 503, failuresRemaining: 0, slowAll: false, delayTail: false, latencyMs: 90, perItemMs: 0 };
    global.fetch = async function (this: typeof globalThis, input, init) {
      if (this !== globalThis) throw new TypeError('Native fetch receiver required.');
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith('https://api.deepseek.com/')) return nativeFetch(input, init);
      const request = JSON.parse(String(init?.body));
      const envelope = JSON.parse(request.messages[1].content);
      const state = global.__nearPageTest;
      const passages: Array<{ i: number; text: string }> = Array.isArray(envelope.segments)
        ? envelope.segments : [{ i: 0, text: envelope.selectedText }];
      state.batches++;
      for (const passage of passages) state.requests.push({ selectedText: passage.text, model: request.model, thinking: request.thinking });
      const fail = state.failuresRemaining > 0 && (!state.failText || passages.some(passage => passage.text === state.failText));
      if (fail) state.failuresRemaining--;
      // HTTP-level failures affect a whole request; a selected passage failure below
      // exercises valid streamed siblings followed by an interrupted batch.
      if (fail && !state.failText) {
        return new Response('{}', { status: state.failStatus });
      }
      const encoder = new TextEncoder();
      const event = (content: string | null, finish_reason: string | null = null) =>
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason }] })}\n\n`;
      let done = false;
      const timers: Array<ReturnType<typeof setTimeout>> = [];
      state.active++;
      state.maxActive = Math.max(state.maxActive, state.active);
      const finish = () => {
        if (done) return false;
        done = true;
        for (const timer of timers) clearTimeout(timer);
        state.active--;
        return true;
      };
      const body = new ReadableStream<Uint8Array>({
        start(sink) {
          const delivered = passages.filter(passage => !fail || passage.text !== state.failText);
          const baseDelay = state.slowAll ? 2_000 : state.latencyMs;
          let finalDelay = baseDelay;
          delivered.forEach((passage, index) => {
            const delay = baseDelay + index * state.perItemMs + (state.delayTail && index > 0 ? 1_200 : 0);
            finalDelay = Math.max(finalDelay, delay);
            timers.push(setTimeout(() => {
              if (done) return;
              const translated = translations[passage.text] ?? `译文：${passage.text}`;
              const content = Array.isArray(envelope.segments)
                ? JSON.stringify({ i: passage.i, t: translated }) + '\n' : translated;
              sink.enqueue(encoder.encode(event(content)));
            }, delay));
          });
          timers.push(setTimeout(() => {
            if (!finish()) return;
            sink.enqueue(encoder.encode(fail ? 'data: {"error":{"message":"Temporary batch interruption"}}\n\n'
              : event(null, 'stop') + 'data: [DONE]\n\n'));
            sink.close();
          }, finalDelay + 15));
          init?.signal?.addEventListener('abort', () => {
            if (!finish()) return;
            state.cancellations++;
            sink.error(new DOMException('Aborted', 'AbortError'));
          }, { once: true });
        },
        cancel() { finish(); },
      });
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
    };
  }, TRANSLATIONS);
}

async function state(): Promise<FakeState> {
  return worker.evaluate(() => (globalThis as unknown as { __nearPageTest: FakeState }).__nearPageTest);
}

async function saveSettings(values: { enabled?: boolean; removeKey?: boolean } = {}): Promise<void> {
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await expect(options.getByRole('button', { name: '保存设置', exact: true })).toBeEnabled();
  await options.getByLabel('翻译方式', { exact: true }).selectOption('model');
  if (values.removeKey) await options.getByRole('button', { name: '删除已保存的 Key' }).click();
  else await options.getByLabel('DeepSeek API Key', { exact: true }).fill('fake-test-key');
  if (values.enabled !== undefined) await options.getByLabel('启用翻译', { exact: true }).setChecked(values.enabled);
  await options.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(options.getByRole('status')).toContainText('设置已保存');
}

async function load(body: string, dark = false): Promise<void> {
  fixture = documentHtml(body, dark);
  await page.goto(FIXTURE_URL);
  await expect(page.getByRole('button', { name: '翻译整个页面', exact: true })).toBeVisible();
}

test.beforeAll(async () => {
  const extension = resolve('.output/e2e-extension');
  profile = await mkdtemp(resolve('.output/e2e-profile-page-'));
  const channel = process.env.NEAR_BROWSER_CHANNEL ?? 'chromium';
  const executablePath = process.env.NEAR_BROWSER_EXECUTABLE;
  const branded = channel !== 'chromium' || !!executablePath;
  context = await chromium.launchPersistentContext(profile, {
    channel, executablePath, headless: true, ignoreDefaultArgs: ['--disable-extensions'],
    viewport: { width: 1280, height: 1000 },
    args: branded ? ['--enable-unsafe-extension-debugging'] : [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  if (branded) {
    const browser = context.browser();
    if (!browser) throw new Error('Missing browser connection for isolated extension.');
    const debug = await browser.newBrowserCDPSession();
    await debug.send('Extensions.loadUnpacked', { path: extension });
    await debug.detach();
  }
  await context.route('https://api.deepseek.com/**', route => route.abort('blockedbyclient'));
  await context.route(FIXTURE_URL, route => route.fulfill({ status: 200, contentType: 'text/html', body: fixture }));
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  extensionId = new URL(worker.url()).host;
  await installFakeApi();
  options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  const vault = await options.evaluate(() => (globalThis as unknown as {
    chrome: { runtime: { sendMessage(message: object): Promise<{ ok: boolean }> } };
  }).chrome.runtime.sendMessage({ type: 'create-key-vault', passphrase: 'test-only-long-passphrase-2026' }));
  expect(vault.ok).toBe(true);
});

test.beforeEach(async () => {
  for (const open of context.pages()) if (open !== options) await open.close();
  await worker.evaluate(() => {
    (globalThis as unknown as { __nearPageTest: FakeState }).__nearPageTest = {
      requests: [], batches: 0, active: 0, maxActive: 0, cancellations: 0,
      failStatus: 503, failuresRemaining: 0, slowAll: false, delayTail: false, latencyMs: 90, perItemMs: 0,
    };
  });
  await saveSettings({ enabled: true });
  page = await context.newPage();
  await load(ARTICLE);
});

test.afterAll(async () => {
  await context?.close();
  if (!profile) return;
  const workspace = await realpath('.');
  const actual = await realpath(profile);
  const local = relative(workspace, actual).replaceAll('\\', '/');
  if (!local.startsWith('.output/e2e-profile-page-')) throw new Error('Refuse deleting an external browser profile.');
  await rm(actual, { recursive: true, force: true });
});

test('ordinary HTTP pages translate the whole page', async ({}, info) => {
  const url = 'http://page-fixture.invalid/';
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.route(url, route => route.fulfill({ status: 200, contentType: 'text/html',
    body: documentHtml('<p>Another paragraph succeeds immediately.</p>'),
  }));
  await page.goto(url);
  expect(await page.evaluate(() => window.isSecureContext)).toBe(false);
  await page.getByRole('button', { name: '翻译整个页面', exact: true }).click();
  await expect.soft.poll(async () => (await state()).requests).toHaveLength(1);
  await expect.soft(page.getByText('另一段立即翻译成功。', { exact: true })).toBeVisible();
  await info.attach('ordinary-http-page.json', {
    body: JSON.stringify({ url: page.url(), secureContext: await page.evaluate(() => window.isSecureContext),
      state: await state(), bar: await page.locator('near-page-translate').evaluate(element => element.shadowRoot?.textContent), errors }, null, 2),
    contentType: 'application/json',
  });
  expect((await state()).requests[0]).toMatchObject({ selectedText: 'Another paragraph succeeds immediately.' });
  expect(errors).toEqual([]);
});

test('whole page stays bilingual and skips code, images, hidden and editable content', async ({}, info) => {
  const code = await page.locator('#code').innerHTML();
  const image = await page.locator('#diagram').evaluate(element => element.outerHTML);
  const prose = await page.locator('#prose').innerHTML();
  expect((await state()).requests).toEqual([]);
  await page.getByRole('button', { name: '翻译整个页面', exact: true }).click();
  await expect(page.getByText(TRANSLATIONS['Language Design for Software Engineering']!, { exact: true })).toBeVisible();
  await expect(page.getByText(TRANSLATIONS['Go was designed to make software engineering more productive.']!, { exact: true })).toBeVisible();
  await expect(page.getByText(TRANSLATIONS['Repeated text is translated only once.']!, { exact: true })).toHaveCount(2);
  await expect(page.getByRole('button', { name: '停止翻译', exact: true })).toHaveCount(0);
  const captured = (await state()).requests;
  expect(captured.filter(item => item.selectedText === 'Repeated text is translated only once.')).toHaveLength(1);
  expect(captured).toHaveLength(8);
  expect((await state()).batches).toBeLessThan(captured.length);
  for (const request of captured) {
    expect(request.model).toBe('deepseek-flash');
    expect(request.thinking).toEqual({ type: 'disabled' });
    expect(request.selectedText).not.toMatch(/Do not translate|must not leave|中文内容/);
  }
  expect(captured.some(item => item.selectedText === 'Run go build to compile the package.')).toBe(true);
  await expect(page.locator('#title')).toContainText('Language Design for Software Engineering');
  expect(await page.locator('#code').innerHTML()).toBe(code);
  expect(await page.locator('#diagram').evaluate(element => element.outerHTML)).toBe(image);
  // The translated sibling may live inside the source paragraph; the original rich nodes stay intact.
  expect(await page.locator('#prose strong').textContent()).toBe('designed');
  expect(await page.locator('#prose a').getAttribute('href')).toBe('#title');
  expect(prose).toContain('<strong>designed</strong>');
  await page.screenshot({ path: info.outputPath('page-bilingual.png'), fullPage: true });
  await page.locator('near-page-translate .np-primary').hover();
  await page.getByRole('button', { name: '显示原文', exact: true }).click();
  await expect(page.locator('near-page-translation[data-near-translation]')).toHaveCount(0);
  expect(await page.locator('#prose').innerHTML()).toBe(prose);
  expect((await state()).requests).toHaveLength(8);
});

test('dark pages retain their original presentation and model output is inert text', async ({}, info) => {
  await load(`${ARTICLE}<p id="inert">Render translated HTML as plain text.</p>`, true);
  await page.getByRole('button', { name: '翻译整个页面', exact: true }).click();
  await expect(page.getByText(TRANSLATIONS['Render translated HTML as plain text.']!, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '停止翻译', exact: true })).toHaveCount(0);
  await expect(page.locator('near-page-translation img')).toHaveCount(0);
  expect(await page.evaluate(() => (window as typeof window & { translationExecuted?: boolean }).translationExecuted)).toBeUndefined();
  expect(await page.locator('body').evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(32, 35, 36)');
  await page.screenshot({ path: info.outputPath('page-dark.png'), fullPage: true });
});

test('the main translate button restores the original page before starting another translation', async () => {
  const original = await page.locator('main').innerHTML();
  const code = await page.locator('#code').innerHTML();
  const image = await page.locator('#diagram').evaluate(element => element.outerHTML);
  await page.getByRole('button', { name: '翻译整个页面', exact: true }).click();
  await expect(page.getByText('为软件工程服务的语言设计', { exact: true })).toBeVisible();
  const restore = page.getByRole('button', { name: '恢复原文', exact: true });
  await expect(restore).toBeVisible();
  const translated = await state();
  expect(translated.requests).toHaveLength(8);
  await restore.click();
  await expect(page.locator('near-page-translation[data-near-translation]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '翻译整个页面', exact: true })).toBeVisible();
  await expect(page.locator('near-page-translate').getByRole('status')).toHaveText('点击翻译页面');
  expect(await page.locator('main').innerHTML()).toBe(original);
  expect(await page.locator('#code').innerHTML()).toBe(code);
  expect(await page.locator('#diagram').evaluate(element => element.outerHTML)).toBe(image);
  await page.locator('main').evaluate(element => {
    const paragraph = document.createElement('p');
    paragraph.textContent = 'Dynamically appended content also needs translation.';
    element.appendChild(paragraph);
  });
  await page.waitForTimeout(500);
  await expect(page.locator('near-page-translation[data-near-translation]')).toHaveCount(0);
  expect((await state()).requests).toHaveLength(translated.requests.length);
  expect((await state()).batches).toBe(translated.batches);
  await page.getByRole('button', { name: '翻译整个页面', exact: true }).click();
  await expect(page.getByText('动态追加的内容也需要翻译。', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '恢复原文', exact: true })).toBeVisible();
  const restarted = await state();
  expect(restarted.requests.length).toBeGreaterThan(translated.requests.length);
  expect(restarted.batches).toBeGreaterThan(translated.batches);
});

test('the main button restores original text after stopping a partially translated page', async () => {
  await load('<p>Another paragraph succeeds immediately.</p><p>Dynamically appended content also needs translation.</p>');
  await worker.evaluate(() => { (globalThis as unknown as { __nearPageTest: FakeState }).__nearPageTest.delayTail = true; });
  await page.getByRole('button', { name: '翻译整个页面', exact: true }).click();
  await expect(page.getByText('另一段立即翻译成功。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '停止翻译', exact: true }).click();
  await expect(page.getByRole('button', { name: '恢复原文', exact: true })).toBeVisible();
  const stopped = await state();
  await page.getByRole('button', { name: '恢复原文', exact: true }).click();
  await expect(page.locator('near-page-translation[data-near-translation]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '翻译整个页面', exact: true })).toBeVisible();
  await expect(page.locator('near-page-translate').getByRole('status')).toHaveText('点击翻译页面');
  expect((await state()).requests).toHaveLength(stopped.requests.length);
  expect((await state()).batches).toBe(stopped.batches);
});

test('stop cancels active requests and leaves no late translations', async () => {
  await load('<p>Slow page request number one.</p><p>Slow page request number two.</p>');
  await worker.evaluate(() => { (globalThis as unknown as { __nearPageTest: FakeState }).__nearPageTest.slowAll = true; });
  await page.getByRole('button', { name: '翻译整个页面', exact: true }).click();
  await expect.poll(async () => (await state()).requests.length).toBe(2);
  await page.getByRole('button', { name: '停止翻译', exact: true }).click();
  await expect.poll(async () => (await state()).cancellations).toBe(1);
  // Allow the original completion deadline to pass to expose callbacks from a cancelled session.
  await page.waitForTimeout(2_100);
  await expect(page.getByText('页面慢请求一。', { exact: true })).toHaveCount(0);
  await expect(page.getByText('页面慢请求二。', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '停止翻译', exact: true })).toHaveCount(0);
  await page.locator('near-page-translate .np-primary').hover();
  await page.getByRole('button', { name: '显示原文', exact: true }).click();
  await expect(page.locator('near-page-translation[data-near-translation]')).toHaveCount(0);
});

test('a failed paragraph can be retried without requesting successful paragraphs again', async () => {
  await load('<p>Retry this paragraph after a temporary service failure.</p><p>Another paragraph succeeds immediately.</p>');
  await worker.evaluate(() => {
    const fake = (globalThis as unknown as { __nearPageTest: FakeState }).__nearPageTest;
    fake.failText = 'Retry this paragraph after a temporary service failure.';
    fake.failuresRemaining = 1;
  });
  await page.getByRole('button', { name: '翻译整个页面', exact: true }).click();
  await expect(page.getByText('另一段立即翻译成功。', { exact: true })).toBeVisible();
  await page.locator('near-page-translate .np-primary').hover();
  await expect(page.getByRole('button', { name: '重试失败段落', exact: true })).toBeVisible();
  expect((await state()).requests).toHaveLength(2);
  await page.getByRole('button', { name: '重试失败段落', exact: true }).click();
  await expect(page.getByText('服务暂时失败后，重试这一段。', { exact: true })).toBeVisible();
  const captured = (await state()).requests;
  expect(captured).toHaveLength(3);
  expect(captured.filter(item => item.selectedText === 'Another paragraph succeeds immediately.')).toHaveLength(1);
});

test('content appended after completion is translated once', async () => {
  await load('<p>Another paragraph succeeds immediately.</p>');
  await page.getByRole('button', { name: '翻译整个页面', exact: true }).click();
  await expect(page.getByText('另一段立即翻译成功。', { exact: true })).toBeVisible();
  await page.locator('main').evaluate(element => {
    const p = document.createElement('p'); p.textContent = 'Dynamically appended content also needs translation.'; element.appendChild(p);
  });
  await expect(page.getByText('动态追加的内容也需要翻译。', { exact: true })).toBeVisible();
  expect((await state()).requests).toHaveLength(2);
});

test('changing the same text node and changing it back replaces stale translations using the cache', async () => {
  await load('<p id="changing">Another paragraph succeeds immediately.</p>');
  await page.getByRole('button', { name: '翻译整个页面', exact: true }).click();
  await expect(page.getByText('另一段立即翻译成功。', { exact: true })).toBeVisible();
  await page.locator('#changing').evaluate(element => {
    const text = element.firstChild;
    if (!(text instanceof Text)) throw new Error('The source paragraph must retain its original text node.');
    (window as typeof window & { __nearOriginalText?: Text }).__nearOriginalText = text;
    text.data = 'Dynamically appended content also needs translation.';
  });
  await expect(page.getByText('动态追加的内容也需要翻译。', { exact: true })).toBeVisible();
  await expect(page.getByText('另一段立即翻译成功。', { exact: true })).toHaveCount(0);
  await expect(page.locator('#changing near-page-translation')).toHaveCount(1);
  await page.locator('#changing').evaluate(element => {
    const text = (window as typeof window & { __nearOriginalText?: Text }).__nearOriginalText;
    if (!text || element.firstChild !== text) throw new Error('The original source text node was replaced.');
    text.data = 'Another paragraph succeeds immediately.';
  });
  await expect(page.getByText('另一段立即翻译成功。', { exact: true })).toBeVisible();
  await expect(page.getByText('动态追加的内容也需要翻译。', { exact: true })).toHaveCount(0);
  await expect(page.locator('#changing near-page-translation')).toHaveCount(1);
  const captured = (await state()).requests;
  expect(captured).toHaveLength(2);
  expect(captured.map(item => item.selectedText)).toEqual([
    'Another paragraph succeeds immediately.',
    'Dynamically appended content also needs translation.',
  ]);
});

test('a removed translation node is rebuilt without another API request', async () => {
  await load('<p id="rebuild">Another paragraph succeeds immediately.</p>');
  await page.getByRole('button', { name: '翻译整个页面', exact: true }).click();
  await expect(page.getByText('另一段立即翻译成功。', { exact: true })).toBeVisible();
  await page.locator('#rebuild near-page-translation').evaluate(element => element.remove());
  await expect(page.locator('#rebuild near-page-translation')).toHaveCount(1);
  await expect(page.getByText('另一段立即翻译成功。', { exact: true })).toBeVisible();
  expect((await state()).requests).toHaveLength(1);
});

test('disabling translation stops the page session and removes inserted translations', async () => {
  await load('<p>Another paragraph succeeds immediately.</p>');
  await page.getByRole('button', { name: '翻译整个页面', exact: true }).click();
  await expect(page.getByText('另一段立即翻译成功。', { exact: true })).toBeVisible();
  await saveSettings({ enabled: false });
  await expect(page.locator('near-page-translation[data-near-translation]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '翻译整个页面', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '停止翻译', exact: true })).toHaveCount(0);
});

test('website permission revocation cancels in-flight page translation', async () => {
  await load('<p>Slow page request number one.</p><p>Slow page request number two.</p>');
  await worker.evaluate(() => { (globalThis as unknown as { __nearPageTest: FakeState }).__nearPageTest.slowAll = true; });
  await page.getByRole('button', { name: '翻译整个页面', exact: true }).click();
  await expect.poll(async () => (await state()).requests.length).toBe(2);
  // Hosts are granted in the isolated E2E manifest. Exercise the settings broadcast
  // emitted by the real background after optional permission revocation.
  await worker.evaluate(async () => {
    const extension = (globalThis as unknown as { chrome: {
      tabs: { query: (filter: object) => Promise<Array<{ id?: number }>>; sendMessage: (id: number, message: object) => Promise<unknown> };
    } }).chrome;
    const message = { type: 'settings-changed', settings: { enabled: true, includeContext: true, model: 'deepseek-flash', hasApiKey: true, webAccess: false } };
    const tabs = await extension.tabs.query({});
    await Promise.allSettled(tabs.filter(tab => tab.id !== undefined).map(tab => extension.tabs.sendMessage(tab.id!, message)));
  });
  await expect.poll(async () => (await state()).cancellations).toBe(1);
  await expect(page.locator('near-page-translation[data-near-translation]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '翻译整个页面', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '停止翻译', exact: true })).toHaveCount(0);
});

test('a rate limit stops queued paragraphs instead of repeatedly calling the API', async () => {
  await worker.evaluate(() => {
    const fake = (globalThis as unknown as { __nearPageTest: FakeState }).__nearPageTest;
    fake.failStatus = 429; fake.failuresRemaining = 1;
  });
  await page.getByRole('button', { name: '翻译整个页面', exact: true }).click();
  await page.locator('near-page-translate .np-primary').hover();
  await expect(page.getByRole('button', { name: '重试失败段落', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '停止翻译', exact: true })).toHaveCount(0);
  const stopped = await state();
  await page.waitForTimeout(300);
  expect((await state()).batches).toBe(stopped.batches);
  expect(stopped.batches).toBe(1);
});

test('missing API key offers settings and sends no page content', async () => {
  await saveSettings({ removeKey: true });
  await page.getByRole('button', { name: '翻译整个页面', exact: true }).click();
  await expect(page.locator('near-page-translate')).toContainText('API Key');
  await page.locator('near-page-translate .np-primary').hover();
  await expect(page.locator('near-page-translate').getByRole('button', { name: '翻译设置', exact: true })).toBeVisible();
  expect((await state()).requests).toEqual([]);
});

test('flex text blocks place the Chinese below the original without changing its layout', async () => {
  await load('<p id="flex-prose" style="display:flex;gap:8px">Another paragraph succeeds immediately.</p>');
  await page.getByRole('button', { name: '翻译整个页面', exact: true }).click();
  await expect(page.getByText('另一段立即翻译成功。', { exact: true })).toBeVisible();
  const source = await page.locator('#flex-prose').boundingBox();
  const translated = await page.locator('near-page-translation').boundingBox();
  expect(source).not.toBeNull();
  expect(translated).not.toBeNull();
  expect(translated!.y).toBeGreaterThanOrEqual(source!.y + source!.height);
  await expect(page.locator('#flex-prose')).toHaveAttribute('style', 'display:flex;gap:8px');
});

test('a streamed passage is readable before the rest of its batch finishes', async () => {
  await load('<p>Another paragraph succeeds immediately.</p><p>Dynamically appended content also needs translation.</p>');
  await worker.evaluate(() => { (globalThis as unknown as { __nearPageTest: FakeState }).__nearPageTest.delayTail = true; });
  await page.getByRole('button', { name: '翻译整个页面', exact: true }).click();
  await expect(page.getByText('另一段立即翻译成功。', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '停止翻译', exact: true })).toBeVisible();
  await expect(page.getByText('动态追加的内容也需要翻译。', { exact: true })).toHaveCount(0);
  expect((await state()).batches).toBe(1);
  await expect(page.getByText('动态追加的内容也需要翻译。', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '停止翻译', exact: true })).toHaveCount(0);
});

/** Artificial prose with the measured Go page's scale; no copied article body. */
function syntheticGoScaleArticle(): { body: string; passages: string[] } {
  const lengths = [
    ...Array<number>(127).fill(20), ...Array<number>(25).fill(70), ...Array<number>(64).fill(180),
    ...Array<number>(63).fill(360), ...Array<number>(23).fill(650), 761,
  ];
  for (let index = 0; index < 12; index++) lengths[index] = index < 10 ? 9 : 8;
  lengths[216] = 494;
  lengths[279] = 296;
  lengths[302] = 1115;
  const passages = lengths.map((length, index) => {
    if (index < 12) return `Core ${String(index).padStart(3, '0')}${index < 10 ? '.' : ''}`;
    const prefix = `Passage ${String(index).padStart(3, '0')}: `;
    const prose = prefix + 'Maintain clear interfaces and explicit dependencies while preserving reliable software behavior. '.repeat(20);
    return prose.slice(0, length - 1) + '.';
  });
  const paragraphs = [...passages, ...passages.slice(0, 12)];
  const code = Array.from({ length: 28 }, (_, index) => `<pre><code>const untouched_${index} = "Never translate code";</code></pre>`).join('');
  const images = Array.from({ length: 25 }, () => '<img alt="Never translate image" src="data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\'/%3E">').join('');
  return { passages, body: paragraphs.map((text, index) => `<p data-fixture-index="${index}">${text}</p>`).join('') + code + images };
}

test('Go-sized prose batches hundreds of passages into bounded parallel requests', async ({}, info) => {
  const article = syntheticGoScaleArticle();
  expect(article.passages).toHaveLength(303);
  expect(new Set(article.passages).size).toBe(303);
  expect(article.passages.reduce((count, text) => count + text.length, 0)).toBe(54_201);
  await load(article.body);
  await worker.evaluate(() => {
    const fake = (globalThis as unknown as { __nearPageTest: FakeState }).__nearPageTest;
    fake.latencyMs = 400;
    fake.perItemMs = 10;
  });
  const started = performance.now();
  await page.getByRole('button', { name: '翻译整个页面', exact: true }).click();
  await expect(page.locator('near-page-translation[data-state="done"]')).toHaveCount(315, { timeout: 10_000 });
  await expect(page.getByRole('button', { name: '停止翻译', exact: true })).toHaveCount(0);
  const elapsedMs = performance.now() - started;
  const fake = await state();
  expect(fake.requests).toHaveLength(303);
  expect(new Set(fake.requests.map(request => request.selectedText)).size).toBe(303);
  expect(fake.batches).toBeLessThanOrEqual(50);
  expect(fake.batches).toBeGreaterThan(1);
  expect(fake.maxActive).toBeGreaterThan(2);
  expect(fake.maxActive).toBeLessThanOrEqual(32);
  expect(elapsedMs).toBeLessThan(10_000);
  await expect(page.locator('pre near-page-translation,img near-page-translation')).toHaveCount(0);
  await info.attach('synthetic-go-scale-performance.json', {
    body: JSON.stringify({ paragraphs: 315, uniquePassages: 303, uniqueEnglishCharacters: 54_201,
      simulatedPerRequestLatencyMs: 400, batches: fake.batches, maxActive: fake.maxActive, elapsedMs,
      realApi: false }, null, 2),
    contentType: 'application/json',
  });
});
