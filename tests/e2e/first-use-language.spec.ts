import { test, expect, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import type { ConnectionSettings, TranslationServiceStatus } from '../../src/shared/contracts';
import type { SourceLanguage, TargetLanguage } from '../../src/shared/languages';

const BASE = 'http://127.0.0.1:4177';
const FIXTURE = `${BASE}/first-use-language`;
const ENDPOINT = 'https://oneshot-free.www.deepl.com/v1/translate';
const SAMPLE = 'The library opens at nine in the morning.';
const KEY = 'fake-first-use-retained-model-key';
const ENGLISH = 'A clear reading view preserves the complete article and lets the reader choose when to translate. Changing the language or the appearance must not send the article before the reader clicks the translation button.';

type Body = { text: string[]; target_lang: string; source_lang?: string };
type FakeState = { requests: Body[]; preparations: number; unexpected: string[]; active: number; aborts: number; rateLimitNext: boolean };
type ExtensionApi = {
  runtime: { sendMessage(message: object): Promise<unknown> };
  permissions: { request(permissions: { origins: string[] }): Promise<boolean> };
  storage: { local: { remove(keys: string[]): Promise<void> } };
};

let context: BrowserContext;
let worker: Worker;
let extensionId: string;
let profile: string;
let options: Page;
let page: Page;
let fixture = '';

function html(text = ENGLISH, lang = 'en', sections = 1): string {
  return `<!doctype html><html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><title>Local language article</title>
    <style>body{margin:0;background:#eff4ee;font:18px/1.8 system-ui;color:#25432f}main{max-width:820px;margin:40px auto;padding:35px;background:white}h1{font-size:30px}h2{margin-top:35px}p{margin:25px 0}</style></head>
    <body><main><article id="source-article"><h1>Local language article</h1>${Array.from({ length: sections }, (_, i) => `<h2 id="section-${i + 1}">Section ${i + 1}</h2><p class="passage">${text}</p><p>${text}</p>`).join('')}<pre><code>const literal = "Do not translate code";</code></pre></article></main></body></html>`;
}

async function state(): Promise<FakeState> {
  return worker.evaluate(() => (globalThis as unknown as { __nearFirstUseTest: FakeState }).__nearFirstUseTest);
}

async function connection(): Promise<ConnectionSettings> {
  return options.evaluate(() => (globalThis as unknown as { chrome: ExtensionApi }).chrome.runtime.sendMessage({ type: 'get-connection-settings' }) as Promise<ConnectionSettings>);
}

async function saveForm(): Promise<void> {
  await options.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(options.getByRole('status')).toContainText('设置已保存');
}

async function languages(source: SourceLanguage, target: TargetLanguage): Promise<void> {
  await options.getByLabel('源语言', { exact: true }).selectOption(source);
  await options.getByLabel('目标语言', { exact: true }).selectOption(target);
  await saveForm();
}

async function load(text = ENGLISH, lang = 'en', sections = 1, target = page): Promise<void> {
  fixture = html(text, lang, sections);
  await target.goto(FIXTURE);
  await expect(target.getByRole('button', { name: '翻译整个页面', exact: true })).toBeVisible();
}

async function openReader(target = page): Promise<void> {
  await target.keyboard.press('Alt+Shift+R');
  await expect(target.getByRole('dialog', { name: '近译阅读模式', exact: true })).toBeVisible();
  await expect(target.locator('.nr-content > article')).toBeVisible();
}

test.beforeAll(async () => {
  const extension = resolve('.output/e2e-extension');
  profile = await mkdtemp(resolve('.output/e2e-profile-first-use-'));
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
  await context.route(FIXTURE, route => route.fulfill({ status: 200, contentType: 'text/html', body: fixture }));
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  extensionId = new URL(worker.url()).host;
  await worker.evaluate(({ endpoint, sample }) => {
    const global = globalThis as typeof globalThis & { __nearFirstUseTest: FakeState };
    global.__nearFirstUseTest = { requests: [], preparations: 0, unexpected: [], active: 0, aborts: 0, rateLimitNext: false };
    // Never call native fetch. Public-sample and article translations are synthetic.
    global.fetch = async function (this: typeof globalThis, input, init) {
      if (this !== globalThis) throw new TypeError('Native fetch receiver required.');
      const url = input instanceof Request ? input.url : String(input);
      const state = global.__nearFirstUseTest;
      if (url === endpoint && init?.method === 'OPTIONS') { state.preparations++; return new Response(null, { status: 204 }); }
      if (url !== endpoint) { state.unexpected.push(url); throw new Error('External service disabled in first-use E2E.'); }
      const body = JSON.parse(String(init?.body)) as Body;
      state.requests.push(body); state.active++;
      const limited = state.rateLimitNext; state.rateLimitNext = false;
      return new Promise<Response>((resolve, reject) => {
        let settled = false;
        const finish = () => {
          if (settled) return false;
          settled = true; clearTimeout(timer); state.active--;
          init?.signal?.removeEventListener('abort', abort); return true;
        };
        const abort = () => { if (finish()) { state.aborts++; reject(new DOMException('Aborted', 'AbortError')); } };
        const timer = setTimeout(() => {
          if (!finish()) return;
          if (limited) { resolve(new Response('{}', { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '60' } })); return; }
          const prefix = body.target_lang === 'ar' ? 'ترجمة: ' : body.target_lang === 'ja' ? '翻訳：' : body.target_lang === 'en' ? 'Translated: ' : '模拟译文：';
          resolve(new Response(JSON.stringify({ translations: body.text.map(text => ({ text: text === sample ? '图书馆早上九点开门。' : `${prefix}${text}` })) }), { headers: { 'Content-Type': 'application/json' } }));
        }, 45);
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener('abort', abort, { once: true });
      });
    };
  }, { endpoint: ENDPOINT, sample: SAMPLE });
  options = await context.newPage();
});

test.beforeEach(async () => {
  for (const open of context.pages()) if (open !== options) await open.close();
  await expect.poll(async () => (await state()).active).toBe(0);
  await worker.evaluate(async () => {
    const global = globalThis as unknown as { chrome: ExtensionApi; __nearFirstUseTest: FakeState };
    await global.chrome.storage.local.remove(['settings:v1', 'reading-preferences:v1']);
    global.__nearFirstUseTest = { requests: [], preparations: 0, unexpected: [], active: 0, aborts: 0, rateLimitNext: false };
  });
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await expect(options.getByRole('button', { name: '保存设置', exact: true })).toBeEnabled();
  page = await context.newPage();
});

test.afterEach(async ({}, info) => {
  const captured = await state();
  await info.attach('first-use-service-state.json', { body: JSON.stringify(captured, null, 2), contentType: 'application/json' });
  expect(captured.unexpected).toEqual([]);
});

test.afterAll(async () => {
  await context?.close();
  if (!profile) return;
  const workspace = await realpath('.');
  const actual = await realpath(profile);
  const local = relative(workspace, actual).replaceAll('\\', '/');
  if (!local.startsWith('.output/e2e-profile-first-use-')) throw new Error('Refuse deleting an external browser profile.');
  await rm(actual, { recursive: true, force: true });
});

test('fresh settings use free translation without a Key and only the explicit test sends its public sample', async () => {
  expect(await connection()).toMatchObject({ translationEngine: 'deepl-web', hasApiKey: false, sourceLanguage: 'auto', targetLanguage: 'zh-Hans' });
  await expect(options.getByLabel('翻译方式', { exact: true })).toHaveValue('deepl-web');
  expect((await state()).requests).toEqual([]);
  await languages('ja', 'en');
  expect((await state()).requests).toEqual([]);
  await expect(options.getByText('测试仅发送固定公开示例句，不读取当前文章。', { exact: true })).toBeVisible();
  await options.getByRole('button', { name: '测试免费翻译', exact: true }).click();
  await expect(options.getByLabel('公开示例句测试结果')).toContainText('图书馆早上九点开门。');
  expect((await state()).requests).toEqual([{ text: [SAMPLE], source_lang: 'en', target_lang: 'zh-Hans' }]);
  expect(await connection()).toMatchObject({ sourceLanguage: 'ja', targetLanguage: 'en', hasApiKey: false });
});

test('denied setup leaves local reading and old model settings intact, then one click enables free translation', async () => {
  await load();
  await openReader();
  await options.getByLabel('翻译方式', { exact: true }).selectOption('model');
  await options.getByLabel('DeepSeek API Key', { exact: true }).fill(KEY);
  await options.getByLabel('模型名', { exact: true }).fill('retained-first-use-model');
  await options.getByLabel('启用翻译', { exact: true }).setChecked(false);
  await saveForm();
  const before = await connection();
  await options.evaluate(() => {
    const global = globalThis as unknown as { chrome: ExtensionApi; __restoreFirstUsePermission?: ExtensionApi['permissions']['request'] };
    global.__restoreFirstUsePermission = global.chrome.permissions.request.bind(global.chrome.permissions);
    global.chrome.permissions.request = async () => false;
  });
  await options.getByRole('button', { name: '启用免费翻译', exact: true }).click();
  await expect(options.getByText('未授予翻译权限，设置没有更改。', { exact: false })).toBeVisible();
  expect(await connection()).toEqual(before);
  await expect(page.getByRole('dialog', { name: '近译阅读模式', exact: true })).toBeVisible();
  expect((await state()).requests).toEqual([]);
  await options.evaluate(() => {
    const global = globalThis as unknown as { chrome: ExtensionApi; __restoreFirstUsePermission?: ExtensionApi['permissions']['request'] };
    global.chrome.permissions.request = global.__restoreFirstUsePermission!;
  });
  await options.getByRole('button', { name: '启用免费翻译', exact: true }).click();
  await expect(options.getByRole('status')).toContainText('免费翻译已启用');
  await expect(options.getByRole('button', { name: '启用免费翻译', exact: true })).toBeDisabled();
  const after = await connection();
  expect(after).toMatchObject({ translationEngine: 'deepl-web', enabled: true, webAccess: true, apiAccess: true,
    model: 'retained-first-use-model', profiles: { deepseek: { hasApiKey: true, model: 'retained-first-use-model' } } });
  expect(JSON.stringify(after)).not.toContain(KEY);
  await expect(page.getByRole('dialog', { name: '近译阅读模式', exact: true })).toBeVisible();
  expect((await state()).requests).toEqual([]);
});

test('Japanese, Korean, Russian, Arabic and Chinese passages translate to English with matching language attributes', async () => {
  const cases: Array<{ source: SourceLanguage; lang: string; text: string }> = [
    { source: 'ja', lang: 'ja', text: '図書館では静かに本を読んでください。必要な情報を確認してから、次の章へ進むことができます。' },
    { source: 'ko', lang: 'ko', text: '도서관에서는 조용히 책을 읽어 주세요. 필요한 정보를 확인한 다음에 다음 장으로 이동할 수 있습니다.' },
    { source: 'ru', lang: 'ru', text: 'В библиотеке можно спокойно читать книги и изучать новые материалы. После проверки информации читатель переходит к следующей главе.' },
    { source: 'ar', lang: 'ar', text: 'يمكن للقارئ أن يقرأ الكتاب بهدوء في المكتبة وأن يراجع المعلومات المهمة قبل الانتقال إلى الفصل التالي.' },
    { source: 'zh-Hans', lang: 'zh-CN', text: '图书馆为读者提供安静的阅读环境。阅读技术资料时，可以保留完整的上下文，并在理解重要信息后继续阅读下一章。' },
  ];
  for (const item of cases) {
    await languages(item.source, 'en');
    const before = (await state()).requests.length;
    await load(item.text, item.lang);
    expect((await state()).requests).toHaveLength(before);
    await page.getByRole('button', { name: '翻译整个页面', exact: true }).click();
    const translated = page.locator('.passage').first().locator('near-page-translation[data-state=done]');
    await expect(translated).toContainText(`Translated: ${item.text}`);
    await expect(translated).toHaveAttribute('lang', 'en');
    await expect(page.locator('html')).toHaveAttribute('lang', item.lang);
    await expect(page.getByRole('button', { name: '恢复原文', exact: true })).toBeVisible();
    const sent = (await state()).requests.slice(before);
    expect(sent.some(request => request.text.includes(item.text))).toBe(true);
    expect(sent.every(request => request.target_lang === 'en' && request.source_lang === (item.source.startsWith('zh-') ? 'zh' : item.source))).toBe(true);
  }
});

test('changing language and service clears old reader translations while preserving the reading position', async () => {
  await load(ENGLISH, 'en', 12);
  await openReader();
  const dialog = page.getByRole('dialog', { name: '近译阅读模式', exact: true });
  await dialog.getByRole('button', { name: '翻译正文', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '翻译完成', exact: true })).toBeDisabled();
  await dialog.locator('.nr-scroll').evaluate(element => { element.scrollTop = (element.scrollHeight - element.clientHeight) * .55; });
  await expect(dialog.getByRole('progressbar', { name: '阅读进度', exact: true })).toHaveAttribute('aria-valuenow', '55');
  await expect(dialog.locator('[data-near-reader-focused=true]')).toHaveCount(1);
  const focused = dialog.locator('[data-near-reader-focused=true]');
  const id = await focused.getAttribute('data-near-reader-source');
  const before = await focused.boundingBox();
  const sent = (await state()).requests.length;
  await languages('auto', 'ja');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-near-reader-translation]')).toHaveCount(0);
  await expect.poll(async () => {
    const after = await dialog.locator(`[data-near-reader-source="${id}"]`).boundingBox();
    return Math.abs((after?.y ?? Infinity) - before!.y);
  }).toBeLessThan(5);
  expect((await state()).requests).toHaveLength(sent);
  await options.getByLabel('翻译方式', { exact: true }).selectOption('model');
  await options.getByLabel('DeepSeek API Key', { exact: true }).fill(KEY);
  await saveForm();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-near-reader-translation]')).toHaveCount(0);
  expect((await state()).requests).toHaveLength(sent);
});

test('Arabic target output has Arabic language and right-to-left presentation without changing source markup', async () => {
  await languages('en', 'ar');
  await load();
  expect((await state()).requests).toEqual([]);
  await page.getByRole('button', { name: '翻译整个页面', exact: true }).click();
  const translated = page.locator('.passage').first().locator('near-page-translation[data-state=done]');
  await expect(translated).toHaveAttribute('lang', 'ar');
  await expect(translated).toContainText('ترجمة:');
  expect(await translated.evaluate(element => getComputedStyle(element).direction)).toBe('rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  expect((await state()).requests.every(request => request.source_lang === 'en' && request.target_lang === 'ar')).toBe(true);
});

test('a real simulated 429 shares a cooldown across pages and the UI deadline never auto-retries', async () => {
  test.setTimeout(90_000);
  // This is the last case: the real provider's minimum 60-second cooldown remains intact.
  // Content scripts run in an isolated world; Playwright's main-world clock does not
  // advance their Date/timers. Observe the genuine deadline instead of faking expiry.
  await load();
  await worker.evaluate(() => { (globalThis as unknown as { __nearFirstUseTest: FakeState }).__nearFirstUseTest.rateLimitNext = true; });
  await page.getByRole('button', { name: '翻译整个页面', exact: true }).click();
  const retry = page.getByRole('button', { name: '重试失败段落', exact: true });
  await page.locator('.np-bar').hover();
  await expect(retry).toBeDisabled();
  await expect(page.locator('near-page-translate').getByRole('status')).toContainText('秒后可手动重试');
  const status = await options.evaluate(() => (globalThis as unknown as { chrome: ExtensionApi }).chrome.runtime.sendMessage({ type: 'get-translation-status' })) as { ok: boolean; status: TranslationServiceStatus };
  expect(status.ok).toBe(true);
  expect(status.status.cooldownUntil - status.status.checkedAt).toBeGreaterThan(55_000);
  const sent = (await state()).requests.length;
  const second = await context.newPage();
  await load(ENGLISH, 'en', 1, second);
  await expect(second.getByRole('button', { name: '翻译整个页面', exact: true })).toBeDisabled();
  await openReader(second);
  const secondDialog = second.getByRole('dialog', { name: '近译阅读模式', exact: true });
  await expect(secondDialog.getByRole('button', { name: '翻译正文', exact: true })).toBeDisabled();
  await expect(secondDialog.locator('.nr-translation-note[role=status]')).toContainText('秒后可手动重试');
  await secondDialog.getByRole('button', { name: '仅译文', exact: true }).click();
  await expect(secondDialog.locator('.nr-translation-note[role=status]')).toContainText('秒后可手动重试');
  expect((await state()).requests).toHaveLength(sent);
  await expect(retry).toBeEnabled({ timeout: 65_000 });
  await expect(secondDialog.getByRole('button', { name: '翻译正文', exact: true })).toBeEnabled();
  expect((await state()).requests).toHaveLength(sent);
});
