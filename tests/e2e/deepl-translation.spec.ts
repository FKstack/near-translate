import { test, expect, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import type { ConnectionSettings, EditableSettings, PublicSettings, TranslationServerMessage } from '../../src/shared/contracts';
import { DEEPL_WEB_SCHEDULING } from '../../src/shared/translation-policy';

const FIXTURE_URL = 'http://127.0.0.1:4177/deepl-page';
const ENDPOINT = 'https://oneshot-free.www.deepl.com/v1/translate';
const MODEL_ENDPOINT = 'https://api.deepseek.com/chat/completions';
const SOURCES = [
  'The library opens early every morning.',
  'Please return the books before Friday.',
  'The reading room is quiet in the afternoon.',
];
const TRANSLATIONS: Record<string, string> = {
  [SOURCES[0]!]: '图书馆每天早晨很早开门。',
  [SOURCES[1]!]: '请在星期五之前归还图书。',
  [SOURCES[2]!]: '阅览室在下午很安静。',
};
const ARTICLE = SOURCES.map((text, index) => `<p id="passage-${index}">${text}</p>`).join('')
  + `<p id="duplicate">${SOURCES[0]}</p><pre><code>const untouched = "Keep source code intact";</code></pre>`;

type AnonymousRequest = { text: string[]; target_lang: string };
type CapturedRequest = {
  url: string;
  method?: string;
  authorization: string | null;
  credentials?: RequestCredentials;
  redirect?: RequestRedirect;
  cache?: RequestCache;
  rawBody: string;
  body: AnonymousRequest;
  startedAt: number;
  finishedAt?: number;
};
type MockState = {
  preparations: Array<{ method?: string; credentials?: RequestCredentials; referrerPolicy?: ReferrerPolicy;
    authorization: string | null; hasBody: boolean; startedAt: number }>;
  requests: CapturedRequest[];
  modelRequests: Array<{ url: string; authorization: string | null; model: string }>;
  active: number;
  maxActive: number;
  aborts: number;
  slowNext: boolean;
  slowAll: boolean;
  rateLimitNext: boolean;
};
type ExtensionApi = {
  runtime: {
    sendMessage(message: object): Promise<unknown>;
    connect(options: { name: string }): {
      postMessage(message: object): void;
      disconnect(): void;
      onMessage: { addListener(callback: (message: TranslationServerMessage) => void): void };
    };
  };
  declarativeNetRequest: { getSessionRules(): Promise<Array<Record<string, unknown>>> };
};

let context: BrowserContext;
let worker: Worker;
let extensionId: string;
let profile: string;
let options: Page;
let page: Page;
let fixture = '';

async function state(): Promise<MockState> {
  return worker.evaluate(() => (globalThis as unknown as { __nearDeepLTest: MockState }).__nearDeepLTest);
}

async function connection(): Promise<ConnectionSettings> {
  return options.evaluate(() => (globalThis as unknown as { chrome: ExtensionApi }).chrome.runtime
    .sendMessage({ type: 'get-connection-settings' }) as Promise<ConnectionSettings>);
}

async function publicSettings(): Promise<PublicSettings> {
  return options.evaluate(() => (globalThis as unknown as { chrome: ExtensionApi }).chrome.runtime
    .sendMessage({ type: 'get-settings' }) as Promise<PublicSettings>);
}

async function rules(): Promise<Array<Record<string, unknown>>> {
  return worker.evaluate(() => (globalThis as unknown as { chrome: ExtensionApi }).chrome.declarativeNetRequest.getSessionRules());
}

async function saveForm(): Promise<void> {
  await options.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(options.getByRole('status')).toContainText('设置已保存');
}

async function useDeepL(): Promise<void> {
  await options.getByLabel('翻译方式', { exact: true }).selectOption('deepl-web');
  await saveForm();
  expect(await publicSettings()).toMatchObject({ translationEngine: 'deepl-web', requiresApiKey: false, apiAccess: true });
  await expect.poll(rules).toHaveLength(1);
  expect(await rules()).toEqual([expect.objectContaining({ id: 74002,
    condition: expect.objectContaining({ requestMethods: ['options'], initiatorDomains: [extensionId] }) })]);
}

async function useModel(): Promise<void> {
  await options.getByLabel('翻译方式', { exact: true }).selectOption('model');
  await options.getByLabel('DeepSeek API Key', { exact: true }).fill('fake-deepl-e2e-model-key');
  await saveForm();
  await expect.poll(rules).toHaveLength(0);
}

async function load(body = ARTICLE): Promise<void> {
  fixture = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>DeepL local fixture</title>
    <style>body{font:18px/1.8 system-ui;margin:40px}main{max-width:800px}p{margin:24px 0}</style>
    </head><body><main>${body}</main></body></html>`;
  await page.goto(FIXTURE_URL);
  await expect(page.getByRole('button', { name: '翻译整个页面', exact: true })).toBeVisible();
}

async function modelTranslation(): Promise<TranslationServerMessage[]> {
  return options.evaluate(() => new Promise<TranslationServerMessage[]>((resolve, reject) => {
    const port = (globalThis as unknown as { chrome: ExtensionApi }).chrome.runtime.connect({ name: 'near-translate:v1' });
    const messages: TranslationServerMessage[] = [];
    const timer = setTimeout(() => { port.disconnect(); reject(new Error('Mock model translation did not finish.')); }, 8_000);
    port.onMessage.addListener(message => {
      messages.push(message);
      if (message.type === 'result' || message.type === 'error') {
        clearTimeout(timer); port.disconnect(); resolve(messages);
      }
    });
    port.postMessage({ type: 'translate', requestId: 'deepl-switch-model-test', input: { kind: 'text', text: 'A public test sentence.' } });
  }));
}

test.beforeAll(async () => {
  const extension = resolve('.output/e2e-extension');
  profile = await mkdtemp(resolve('.output/e2e-profile-deepl-'));
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
    if (!browser) throw new Error('Missing browser connection for the isolated DeepL test extension.');
    const debug = await browser.newBrowserCDPSession();
    await debug.send('Extensions.loadUnpacked', { path: extension });
    await debug.detach();
  }
  await context.route('https://**/*', route => route.abort('blockedbyclient'));
  await context.route(FIXTURE_URL, route => route.fulfill({ status: 200, contentType: 'text/html', body: fixture }));
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  extensionId = new URL(worker.url()).host;
  await worker.evaluate(({ translations, endpoint, modelEndpoint }) => {
    const global = globalThis as typeof globalThis & { __nearDeepLTest: MockState };
    global.__nearDeepLTest = { preparations: [], requests: [], modelRequests: [], active: 0, maxActive: 0, aborts: 0, slowNext: false, slowAll: false, rateLimitNext: false };
    // Never delegate to native fetch: every translation in this file is synthetic.
    global.fetch = async function (this: typeof globalThis, input, init) {
      if (this !== globalThis) throw new TypeError('Native fetch receiver required.');
      const url = input instanceof Request ? input.url : String(input);
      const authorization = new Headers(init?.headers).get('Authorization');
      const state = global.__nearDeepLTest;
      if (url === endpoint && init?.method === 'OPTIONS') {
        state.preparations.push({ method: init.method, credentials: init.credentials,
          referrerPolicy: init.referrerPolicy, authorization, hasBody: init.body != null, startedAt: Date.now() });
        return new Response(null, { status: 204 });
      }
      const rawBody = String(init?.body);
      const body = JSON.parse(rawBody);
      if (url === modelEndpoint) {
        state.modelRequests.push({ url, authorization, model: body.model });
        const event = (content: string | null, finish_reason: string | null = null) =>
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason }] })}\n\n`;
        return new Response(event('切换后的模型翻译成功。') + event(null, 'stop') + 'data: [DONE]\n\n', {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }
      if (url !== endpoint) throw new Error(`Unexpected network request in DeepL E2E mock: ${url}`);
      const request: CapturedRequest = { url, method: init?.method, authorization, rawBody, body,
        credentials: init?.credentials, redirect: init?.redirect, cache: init?.cache, startedAt: Date.now() };
      state.requests.push(request);
      state.active++;
      state.maxActive = Math.max(state.maxActive, state.active);
      const slow = state.slowNext;
      const limited = state.rateLimitNext;
      state.slowNext = false;
      state.rateLimitNext = false;
      return new Promise<Response>((resolve, reject) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = () => {
          if (settled) return false;
          settled = true;
          clearTimeout(timer);
          init?.signal?.removeEventListener('abort', abort);
          request.finishedAt = Date.now();
          state.active--;
          return true;
        };
        const abort = () => {
          if (!finish()) return;
          state.aborts++;
          reject(new DOMException('Aborted', 'AbortError'));
        };
        if (init?.signal?.aborted) { abort(); return; }
        init?.signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => {
          if (!finish()) return;
          if (limited) {
            resolve(new Response(JSON.stringify({ error: { message: 'Too many requests' } }), {
              status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '60' },
            }));
            return;
          }
          const translated = body.text.map((text: string) => ({ text: translations[text] ?? `模拟译文：${text}` }));
          resolve(new Response(JSON.stringify({ translations: translated }), {
            headers: { 'Content-Type': 'application/json' },
          }));
        }, state.slowAll ? 2_200 : slow ? 1_100 : 40);
      });
    };
  }, { translations: TRANSLATIONS, endpoint: ENDPOINT, modelEndpoint: MODEL_ENDPOINT });
  options = await context.newPage();
});

test.beforeEach(async () => {
  for (const open of context.pages()) if (open !== options) await open.close();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await expect(options.getByRole('button', { name: '保存设置', exact: true })).toBeEnabled();
  const settings: EditableSettings = { translationEngine: 'model', provider: 'deepseek', baseUrl: 'https://api.deepseek.com',
    model: 'retained-model-profile', apiKey: '', jsonMode: true, enabled: true, includeContext: true, sentenceAnalysisEnabled: true };
  const saved = await options.evaluate(settings => (globalThis as unknown as { chrome: ExtensionApi }).chrome.runtime
    .sendMessage({ type: 'save-settings', keepExistingKey: false, settings }), settings) as { ok: boolean };
  expect(saved.ok).toBe(true);
  await expect.poll(async () => (await state()).active).toBe(0);
  await worker.evaluate(() => {
    (globalThis as unknown as { __nearDeepLTest: MockState }).__nearDeepLTest = {
      preparations: [], requests: [], modelRequests: [], active: 0, maxActive: 0, aborts: 0, slowNext: false, slowAll: false, rateLimitNext: false,
    };
  });
  await options.reload();
  await expect(options.getByRole('button', { name: '保存设置', exact: true })).toBeEnabled();
  page = await context.newPage();
});

test.afterAll(async () => {
  await context?.close();
  if (!profile) return;
  const workspace = await realpath('.');
  const actual = await realpath(profile);
  const local = relative(workspace, actual).replaceAll('\\', '/');
  if (!local.startsWith('.output/e2e-profile-deepl-')) throw new Error('Refuse deleting an external browser profile.');
  await rm(actual, { recursive: true, force: true });
});

test('optional connection preparation sends metadata before the click, coalesces navigation, and leaves text for the click', async () => {
  await useDeepL();
  await page.bringToFront();
  await load();
  await expect.poll(async () => (await state()).preparations.length).toBe(1);
  expect((await state()).requests).toHaveLength(0);
  expect((await state()).preparations[0]).toMatchObject({ method: 'OPTIONS', authorization: null,
    hasBody: false, credentials: 'omit', referrerPolicy: 'no-referrer' });
  await load();
  expect((await state()).preparations).toHaveLength(1);
  expect((await state()).requests).toHaveLength(0);
  await page.getByRole('button', { name: '翻译整个页面', exact: true }).click();
  await expect(page.locator('near-page-translation[data-state="done"]')).toHaveCount(4);
  expect((await state()).requests).toHaveLength(1);
  expect((await state()).preparations).toHaveLength(1);
});

test('DeepL saves without a key, hides model controls, and preserves the existing model profile', async () => {
  await useDeepL();
  for (const label of ['API 服务商', 'API Base URL', 'DeepSeek API Key', '模型名', 'JSON 模式', '长难句拆解']) {
    await expect(options.getByLabel(label, { exact: true })).toHaveCount(0);
  }
  await expect(options.getByLabel('附带所在句或附近一句上下文，提高词义判断准确度', { exact: true })).toHaveCount(0);
  expect(await connection()).toMatchObject({ translationEngine: 'deepl-web', hasApiKey: false, requiresApiKey: false,
    profiles: { deepseek: { model: 'retained-model-profile', baseUrl: 'https://api.deepseek.com', hasApiKey: false, jsonMode: true } } });
  expect(await publicSettings()).toMatchObject({ translationEngine: 'deepl-web', includeContext: false, sentenceAnalysisEnabled: false });
  expect(await rules()).toHaveLength(1);

  await useModel();
  const retained = (await connection()).profiles.deepseek;
  expect(retained).toMatchObject({ model: 'retained-model-profile', hasApiKey: true });
  await useDeepL();
  const free = await connection();
  expect(free.profiles.deepseek).toEqual(retained);
  expect(JSON.stringify(free)).not.toContain('fake-deepl-e2e-model-key');
  await options.getByLabel('翻译方式', { exact: true }).selectOption('model');
  await expect(options.getByLabel('模型名', { exact: true })).toHaveValue('retained-model-profile');
  await expect(options.getByLabel('DeepSeek API Key', { exact: true })).toHaveValue('');
  await expect(options.getByLabel('长难句拆解', { exact: true })).toBeChecked();
  await expect(options.getByLabel('附带所在句或附近一句上下文，提高词义判断准确度', { exact: true })).toBeChecked();
  expect((await state()).requests).toHaveLength(0);
  expect((await state()).modelRequests).toHaveLength(0);
});

test('the whole-page button sends anonymous text arrays, deduplicates paragraphs, preserves order, and restores the original', async () => {
  await useDeepL();
  await load();
  const original = await page.locator('main').innerHTML();
  await page.getByRole('button', { name: '翻译整个页面', exact: true }).click();
  const rendered = page.locator('near-page-translation[data-state="done"]');
  await expect(rendered).toHaveCount(4);
  await expect(page.getByRole('button', { name: '恢复原文', exact: true })).toBeVisible();
  expect(await rendered.locator('span[data-state="done"]').allTextContents()).toEqual([
    ...SOURCES.map(text => TRANSLATIONS[text]), TRANSLATIONS[SOURCES[0]!],
  ]);
  const captured = await state();
  expect(captured.requests).toHaveLength(1);
  expect(captured.maxActive).toBe(1);
  expect(captured.active).toBe(0);
  expect(captured.requests.flatMap(request => request.body.text)).toEqual(SOURCES);
  for (const [index, request] of captured.requests.entries()) {
    expect(request).toMatchObject({ url: ENDPOINT, method: 'POST', authorization: 'None',
      credentials: 'omit', redirect: 'error', cache: 'no-store', body: { text: SOURCES, target_lang: 'zh-Hans' } });
    expect(Object.keys(request.body).sort()).toEqual(['target_lang', 'text']);
    expect(request.rawBody).not.toContain('fake-deepl-e2e-model-key');
    // Fetch follows async host-permission checks. Exact scheduler cadence is
    // covered by fake-time unit tests; the network hook can differ slightly.
    if (index > 0) expect(request.startedAt - captured.requests[index - 1]!.startedAt).toBeGreaterThanOrEqual(DEEPL_WEB_SCHEDULING.intervalMs - 25);
  }
  await page.getByRole('button', { name: '恢复原文', exact: true }).click();
  await expect(page.locator('near-page-translation[data-near-translation]')).toHaveCount(0);
  expect(await page.locator('main').innerHTML()).toBe(original);
  expect((await state()).requests).toHaveLength(1);
  await page.getByRole('button', { name: '翻译整个页面', exact: true }).click();
  await expect(page.locator('near-page-translation[data-state="done"]')).toHaveCount(4);
  expect((await state()).requests).toHaveLength(1);
});

test('a long article batches dozens of passages, prioritizes article content, and reuses the warm document cache', async () => {
  await useDeepL();
  const paragraphs = Array.from({ length: 120 }, (_, index) => `Passage ${index}: ${'This paragraph explains practical software engineering and clear programming interfaces. '.repeat(3)}`);
  await load(paragraphs.map(text => `<p>${text}</p>`).join(''));
  await page.evaluate(() => { const nav = document.createElement('nav'); nav.textContent = 'Never spend translation calls on this navigation menu.'; document.body.prepend(nav); });
  await page.getByRole('button', { name: '翻译整个页面', exact: true }).click();
  await expect(page.locator('near-page-translation[data-state="done"]')).toHaveCount(120, { timeout: 30_000 });
  const captured = await state();
  expect(captured.requests.length).toBeLessThanOrEqual(26);
  expect(captured.maxActive).toBe(1);
  expect(captured.requests.flatMap(r => r.body.text).sort()).toEqual(paragraphs.map(text => text.trim()).sort());
  for (const request of captured.requests) {
    expect(request.body.text.length).toBeLessThanOrEqual(32);
    expect(request.body.text.reduce((n, text) => n + text.length, 0)).toBeLessThanOrEqual(1500);
  }
  const translated = await page.locator('near-page-translation span').allTextContents();
  await page.getByRole('button', { name: '恢复原文', exact: true }).click();
  await page.getByRole('button', { name: '翻译整个页面', exact: true }).click();
  await expect(page.locator('near-page-translation[data-state="done"]')).toHaveCount(120);
  expect(await page.locator('near-page-translation span').allTextContents()).toEqual(translated);
  expect((await state()).requests).toHaveLength(captured.requests.length);
});

test('the page pipelines slow anonymous batches within the shared service budget and preserves document order', async () => {
  await useDeepL();
  const windowBudget = (DEEPL_WEB_SCHEDULING as { startWindow?: { durationMs: number } }).startWindow;
  // Prior test callers intentionally share this provider. Let their real budget
  // expire instead of resetting its history to manufacture available slots.
  if (windowBudget) await page.waitForTimeout(windowBudget.durationMs);
  const paragraphs = Array.from({ length: DEEPL_WEB_SCHEDULING.maxConcurrent }, (_, index) => `Passage ${index}: ${'Practical software interfaces remain clear. '.repeat(22)}`);
  await load(paragraphs.map(text => `<p>${text}</p>`).join(''));
  await worker.evaluate(() => { (globalThis as unknown as { __nearDeepLTest: MockState }).__nearDeepLTest.slowAll = true; });
  await page.getByRole('button', { name: '翻译整个页面', exact: true }).click();
  await expect(page.locator('near-page-translation[data-state="done"]')).toHaveCount(paragraphs.length, { timeout: 12_000 });
  const captured = await state();
  expect(captured.maxActive).toBe(DEEPL_WEB_SCHEDULING.maxConcurrent);
  expect(captured.active).toBe(0);
  expect(captured.requests.flatMap(request => request.body.text).sort()).toEqual(paragraphs.map(text => text.trim()).sort());
  for (let index = 1; index < captured.requests.length; index++) {
    expect(captured.requests[index]!.startedAt - captured.requests[index - 1]!.startedAt).toBeGreaterThanOrEqual(DEEPL_WEB_SCHEDULING.intervalMs - 25);
  }
  expect(await page.locator('near-page-translation span').allTextContents()).toEqual(paragraphs.map(text => `模拟译文：${text.trim()}`));
});

test('one service start window applies across sequential page batches without losing output', async () => {
  const windowBudget = (DEEPL_WEB_SCHEDULING as { startWindow?: { maxStarts: number; durationMs: number } }).startWindow;
  test.skip(!windowBudget, 'The active service strategy does not request a rolling start window.');
  await useDeepL();
  const paragraphs = Array.from({ length: windowBudget!.maxStarts + 6 }, (_, index) =>
    `Window passage ${index}: ${'Practical software interfaces remain clear. '.repeat(22)}`);
  await load(paragraphs.map(text => `<p>${text}</p>`).join(''));
  await page.getByRole('button', { name: '翻译整个页面', exact: true }).click();
  await expect(page.locator('near-page-translation[data-state="done"]')).toHaveCount(paragraphs.length,
    { timeout: windowBudget!.durationMs + 10_000 });
  const captured = await state();
  expect(captured.requests).toHaveLength(paragraphs.length);
  for (let index = windowBudget!.maxStarts; index < captured.requests.length; index++) {
    // These timestamps are taken by fetch after asynchronous host-permission
    // checks, not at scheduler execution. Exact window edges use fake-time unit
    // tests; allow a small platform timestamp difference in this integration.
    expect(captured.requests[index]!.startedAt - captured.requests[index - windowBudget!.maxStarts]!.startedAt)
      .toBeGreaterThanOrEqual(windowBudget!.durationMs - 25);
  }
  expect(captured.active).toBe(0);
  expect(await page.locator('near-page-translation span').allTextContents())
    .toEqual(paragraphs.map(text => `模拟译文：${text.trim()}`));
});

test('visible prose enters the first batch before an earlier offscreen table of contents without losing full coverage', async () => {
  await useDeepL();
  const contents = Array.from({ length: 80 }, (_, index) => `Section ${index}: engineering notes`);
  const prose = Array.from({ length: 6 }, (_, index) => `Reading passage ${index}. ${'This paragraph describes practical engineering and readable interfaces. '.repeat(4)}`.trim());
  await load(`<ol>${contents.map(text => `<li>${text}</li>`).join('')}</ol>`
    + prose.map((text, index) => `<p id="reading-${index}">${text}</p>`).join(''));
  await page.locator('#reading-0').scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: '翻译整个页面', exact: true }).click();
  await expect(page.locator('near-page-translation[data-state="done"]')).toHaveCount(86, { timeout: 12_000 });
  const captured = await state();
  expect(captured.requests[0]!.body.text[0]).toBe(prose[0]);
  expect(captured.requests[0]!.body.text.length).toBeLessThanOrEqual(2);
  expect(captured.requests.flatMap(request => request.body.text).sort()).toEqual([...contents, ...prose].sort());
  expect(await page.locator('near-page-translation span').allTextContents()).toEqual([...contents, ...prose].map(text => `模拟译文：${text}`));
});

test('stopping a slow request or switching engines aborts it without late page translations', async () => {
  await useDeepL();
  await load(`<p>${SOURCES[0]}</p><p>${SOURCES[1]}</p>`);
  await worker.evaluate(() => { (globalThis as unknown as { __nearDeepLTest: MockState }).__nearDeepLTest.slowNext = true; });
  await page.getByRole('button', { name: '翻译整个页面', exact: true }).click();
  await expect.poll(async () => (await state()).active).toBe(1);
  await page.getByRole('button', { name: '停止翻译', exact: true }).click();
  await expect.poll(async () => (await state()).aborts).toBe(1);
  // Pass the original response deadline to expose stale completion callbacks.
  await page.waitForTimeout(1_250);
  await expect(page.locator('near-page-translation[data-state="done"]')).toHaveCount(0);
  expect((await state()).requests).toHaveLength(1);
  expect((await state()).active).toBe(0);

  await worker.evaluate(() => { (globalThis as unknown as { __nearDeepLTest: MockState }).__nearDeepLTest.slowNext = true; });
  await page.getByRole('button', { name: '翻译整个页面', exact: true }).click();
  await expect.poll(async () => (await state()).active).toBe(1);
  await useModel();
  await expect.poll(async () => (await state()).aborts).toBe(2);
  await page.waitForTimeout(1_250);
  await expect(page.locator('near-page-translation[data-near-translation]')).toHaveCount(0);
  expect((await state()).requests).toHaveLength(2);
  expect((await state()).active).toBe(0);
});

// The background owns one provider instance. Keep its real 60-second cooldown last.
test('429 stops queued paragraphs and cooldown retries send nothing; switching to the model keeps its own credentials', async () => {
  await useDeepL();
  await load(Array.from({ length: 12 }, (_, index) => `<p>Passage ${index}: ${'This is a public paragraph. '.repeat(32)}</p>`).join(''));
  await worker.evaluate(() => { (globalThis as unknown as { __nearDeepLTest: MockState }).__nearDeepLTest.rateLimitNext = true; });
  await page.getByRole('button', { name: '翻译整个页面', exact: true }).click();
  await expect(page.getByRole('button', { name: '重试失败段落', exact: true })).toBeVisible();
  await expect(page.locator('near-page-translate').getByRole('status')).toContainText('DeepL 请求受限');
  await expect(page.getByRole('button', { name: '停止翻译', exact: true })).toHaveCount(0);
  await page.waitForTimeout(1_250);
  expect((await state()).requests).toHaveLength(1);
  await expect(page.getByRole('button', { name: '重试失败段落', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '停止翻译', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '重试失败段落', exact: true })).toBeVisible();
  expect((await state()).requests).toHaveLength(1);
  await expect(page.locator('near-page-translation[data-state="done"]')).toHaveCount(0);

  await useModel();
  expect(await publicSettings()).toMatchObject({ translationEngine: 'model', includeContext: true, sentenceAnalysisEnabled: true });
  expect((await modelTranslation()).at(-1)).toMatchObject({ type: 'result', result: { kind: 'text', translation: '切换后的模型翻译成功。' } });
  expect((await state()).requests).toHaveLength(1);
  expect((await state()).modelRequests).toEqual([{ url: MODEL_ENDPOINT, authorization: 'Bearer fake-deepl-e2e-model-key', model: 'retained-model-profile' }]);
  await expect(page.locator('near-page-translation[data-near-translation]')).toHaveCount(0);
});
