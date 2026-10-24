import { test, expect, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import type { ConnectionSettings, EditableSettings, PublicSettings, TranslationServerMessage } from '../../src/shared/contracts';
import { createEncryptedKeyVault } from '../../src/platform/key-vault';

type CapturedRequest = { url: string; authorization: string | null; body: Record<string, unknown>; credentials?: string; redirect?: string };
type TestState = { requests: CapturedRequest[]; slowNext: boolean; aborts: number };
type ExtensionApi = {
  runtime: {
    sendMessage(message: object): Promise<unknown>;
    connect(options: { name: string }): {
      postMessage(message: object): void;
      disconnect(): void;
      onMessage: { addListener(callback: (message: TranslationServerMessage) => void): void };
    };
  };
};
let context: BrowserContext;
let worker: Worker;
let options: Page;
let extensionId: string;
let profile: string;

async function readConnection(): Promise<ConnectionSettings> {
  return options.evaluate(() => (globalThis as unknown as { chrome: ExtensionApi }).chrome.runtime
    .sendMessage({ type: 'get-connection-settings' }) as Promise<ConnectionSettings>);
}

async function seedConnection(settings: Partial<EditableSettings>, surface = options): Promise<void> {
  const result = await surface.evaluate(settings => (globalThis as unknown as { chrome: ExtensionApi }).chrome.runtime.sendMessage({
    type: 'save-settings', keepExistingKey: true,
    settings: { translationEngine: 'model', enabled: true, includeContext: true, sentenceAnalysisEnabled: false, ...settings },
  }), settings) as { ok: boolean };
  expect(result.ok).toBe(true);
}

async function translateFromOptions(surface = options): Promise<TranslationServerMessage[]> {
  return surface.evaluate(() => new Promise<TranslationServerMessage[]>((resolve, reject) => {
    const port = (globalThis as unknown as { chrome: ExtensionApi }).chrome.runtime.connect({ name: 'near-translate:v1' });
    const messages: TranslationServerMessage[] = [];
    (globalThis as unknown as { __nearConnectionMessages: TranslationServerMessage[] }).__nearConnectionMessages = messages;
    const timer = setTimeout(() => { port.disconnect(); reject(new Error('Mock translation did not finish.')); }, 8_000);
    port.onMessage.addListener(message => {
      messages.push(message);
      if (message.type === 'result' || message.type === 'error') {
        clearTimeout(timer); port.disconnect(); resolve(messages);
      }
    });
    port.postMessage({ type: 'translate', requestId: 'api-connections-test', input: { kind: 'text', text: 'An isolated translation request.' } });
  }));
}

async function capturedRequests(): Promise<CapturedRequest[]> {
  return worker.evaluate(() => (globalThis as unknown as { __nearConnectionsTest: TestState }).__nearConnectionsTest.requests);
}

async function saveForm(): Promise<void> {
  await options.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(options.getByRole('status')).toContainText('设置已保存');
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
  // Block external requests even if a mock regression tries to escape this test.
  await context.route('https://**/*', route => route.abort('blockedbyclient'));
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  extensionId = new URL(worker.url()).host;
  await worker.evaluate(() => {
    const global = globalThis as typeof globalThis & { __nearConnectionsTest: TestState };
    global.__nearConnectionsTest = { requests: [], slowNext: false, aborts: 0 };
    global.fetch = async function (this: typeof globalThis, input, init) {
      if (this !== globalThis) throw new TypeError('Native fetch receiver required.');
      const url = input instanceof Request ? input.url : String(input);
      const headers = new Headers(init?.headers);
      global.__nearConnectionsTest.requests.push({
        url, authorization: headers.get('Authorization'), body: JSON.parse(String(init?.body)),
        credentials: init?.credentials, redirect: init?.redirect,
      });
      const event = (content: string | null, finish_reason: string | null = null) =>
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason }] })}\n\n`;
      if (global.__nearConnectionsTest.slowNext) {
        global.__nearConnectionsTest.slowNext = false;
        let ended = false;
        const body = new ReadableStream<Uint8Array>({
          start(sink) {
            sink.enqueue(new TextEncoder().encode(event('旧模型的部分译文。')));
            init?.signal?.addEventListener('abort', () => {
              if (ended) return;
              ended = true; global.__nearConnectionsTest.aborts++;
              sink.error(new DOMException('Aborted', 'AbortError'));
            }, { once: true });
          },
          cancel() { ended = true; },
        });
        return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
      }
      return new Response(event('模拟接口翻译成功。') + event(null, 'stop') + 'data: [DONE]\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    };
  });
  options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
});

test.beforeEach(async () => {
  await worker.evaluate(() => {
    const state = (globalThis as unknown as { __nearConnectionsTest: TestState }).__nearConnectionsTest;
    state.requests = []; state.slowNext = false; state.aborts = 0;
  });
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await expect(options.getByRole('button', { name: '保存设置', exact: true })).toBeEnabled();
  await seedConnection({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-test-model', jsonMode: true, apiKey: 'fake-test-deepseek-key' });
  await options.reload();
  await expect(options.getByRole('button', { name: '保存设置', exact: true })).toBeEnabled();
});

test.afterAll(async () => {
  await context?.close();
  if (profile) {
    const workspace = await realpath('.');
    const actual = await realpath(profile);
    const location = relative(workspace, actual);
    if (!location.startsWith('.output\\e2e-profile-') && !location.startsWith('.output/e2e-profile-')) {
      throw new Error('Refuse to remove an E2E profile outside workspace .output.');
    }
    await rm(actual, { recursive: true, force: true });
  }
});

test('provider selection restores isolated profiles and never returns saved keys to the settings UI', async () => {
  await options.getByLabel('API 服务商', { exact: true }).selectOption('openai');
  await expect(options.getByLabel('API Base URL', { exact: true })).toHaveValue('https://api.openai.com/v1');
  await options.getByLabel('模型名', { exact: true }).fill('openai-test-model');
  await options.getByLabel('OpenAI API Key', { exact: true }).fill('fake-test-openai-key');
  await saveForm();
  await expect(options.getByLabel('OpenAI API Key', { exact: true })).toHaveValue('');
  let settings = await readConnection();
  expect(settings.provider).toBe('openai');
  expect(settings.profiles.deepseek).toMatchObject({ model: 'deepseek-test-model', hasApiKey: true });
  expect(settings.profiles.openai).toMatchObject({ model: 'openai-test-model', hasApiKey: true });
  expect(JSON.stringify(settings)).not.toMatch(/fake-test-deepseek-key|fake-test-openai-key/);

  await options.getByLabel('API 服务商', { exact: true }).selectOption('deepseek');
  await expect(options.getByLabel('模型名', { exact: true })).toHaveValue('deepseek-test-model');
  await expect(options.getByLabel('DeepSeek API Key', { exact: true })).toHaveValue('');
  await saveForm();
  expect((await translateFromOptions()).at(-1)).toMatchObject({ type: 'result' });
  expect((await capturedRequests()).at(-1)).toMatchObject({
    url: 'https://api.deepseek.com/chat/completions', authorization: 'Bearer fake-test-deepseek-key',
    body: { model: 'deepseek-test-model', thinking: { type: 'disabled' } },
  });

  await options.getByLabel('API 服务商', { exact: true }).selectOption('openai');
  await expect(options.getByLabel('模型名', { exact: true })).toHaveValue('openai-test-model');
  await saveForm();
  await translateFromOptions();
  expect((await capturedRequests()).at(-1)).toMatchObject({
    url: 'https://api.openai.com/v1/chat/completions', authorization: 'Bearer fake-test-openai-key',
    body: { model: 'openai-test-model', max_completion_tokens: 8192 },
  });
  settings = await readConnection();
  expect(JSON.stringify(settings)).not.toMatch(/fake-test-deepseek-key|fake-test-openai-key/);
  const publicProjection = await options.evaluate(() => (globalThis as unknown as { chrome: ExtensionApi }).chrome.runtime.sendMessage({ type: 'get-settings' })) as PublicSettings;
  expect(publicProjection).toMatchObject({ provider: 'openai', hasApiKey: true });
  expect(publicProjection).not.toHaveProperty('profiles');
  expect(publicProjection).not.toHaveProperty('apiKey');
  expect(publicProjection).not.toHaveProperty('baseUrl');
});

test('saved keys work after reload and in new pages while content cannot read private storage', async () => {
  const persistent = await options.evaluate(() => (globalThis as unknown as {
    chrome: { storage: { local: { get(keys: null): Promise<Record<string, unknown>> } } };
  }).chrome.storage.local.get(null));
  expect(persistent['connection-settings:v2']).toBeTruthy();
  expect(JSON.stringify(persistent['connection-settings:v2'])).toContain('fake-test-deepseek-key');
  expect(persistent).not.toHaveProperty('key-vault:v1');
  await expect(options.getByLabel('密钥库口令', { exact: true })).toHaveCount(0);
  await options.reload();
  expect(await readConnection()).toMatchObject({ hasApiKey: true, keyVaultLocked: false });
  await options.screenshot({ path: resolve('.output/extension-settings-simple.png'), fullPage: true });
  expect((await translateFromOptions()).at(-1)).toMatchObject({ type: 'result' });
  expect((await capturedRequests()).at(-1)?.authorization).toBe('Bearer fake-test-deepseek-key');

  const second = await context.newPage();
  const article = await context.newPage();
  const debug = await context.newCDPSession(article);
  const worlds: Array<{ id: number; origin: string; name: string }> = [];
  debug.on('Runtime.executionContextCreated', ({ context }) => { worlds.push(context); });
  await debug.send('Runtime.enable');
  const fixtureUrl = 'http://127.0.0.1:4177/private-settings-boundary';
  await context.route(fixtureUrl, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="en"><body><article><h1>Private settings test</h1><p>This isolated article contains no API credential.</p></article></body></html>' }));
  try {
    await second.goto(`chrome-extension://${extensionId}/options.html`);
    await expect(second.getByLabel('DeepSeek API Key', { exact: true })).toHaveValue('');
    expect((await translateFromOptions(second)).at(-1)).toMatchObject({ type: 'result' });
    expect((await capturedRequests()).at(-1)?.authorization).toBe('Bearer fake-test-deepseek-key');
    await article.goto(fixtureUrl);
    await expect(article.locator('near-translate')).toHaveCount(1);
    expect(await article.content()).not.toContain('fake-test-deepseek-key');
    const findWorld = () => worlds.find(world => world.origin === `chrome-extension://${extensionId}` || world.name === extensionId);
    await expect.poll(findWorld).toBeTruthy();
    const read = await debug.send('Runtime.evaluate', { contextId: findWorld()!.id, awaitPromise: true, returnByValue: true,
      expression: `(async () => {
        let storageReadable = false;
        try { await chrome.storage.local.get('connection-settings:v2'); storageReadable = true; } catch {}
        const settings = await chrome.runtime.sendMessage({ type: 'get-settings' });
        return { storageReadable, settings };
      })()` });
    expect(read.exceptionDetails).toBeUndefined();
    expect(read.result.value).toMatchObject({ storageReadable: false, settings: { hasApiKey: true, keyVaultLocked: false } });
    expect(JSON.stringify(read.result.value)).not.toContain('fake-test-deepseek-key');
  } finally {
    await debug.detach(); await second.close(); await article.close(); await context.unroute(fixtureUrl);
  }
});

test('saving a Key enables an already open article without reloading it', async () => {
  await worker.evaluate(async () => {
    const global = globalThis as unknown as {
      chrome: { scripting: { unregisterContentScripts(options: { ids: string[] }): Promise<void> } };
    };
    await global.chrome.scripting.unregisterContentScripts({ ids: ['near-translate-selection'] });
  });
  const fixtureUrl = 'http://127.0.0.1:4177/already-open-article';
  await context.route(fixtureUrl, route => route.fulfill({ contentType: 'text/html', body:
    '<!doctype html><html lang="en"><body><article><p id="already-open">This article was already open before the user saved a new API Key.</p></article></body></html>' }));
  const article = await context.newPage();
  try {
    await article.goto(fixtureUrl);
    await expect(article.locator('near-translate')).toHaveCount(0);
    await article.evaluate(() => { (globalThis as unknown as { __nearDocumentMarker: string }).__nearDocumentMarker = 'same-open-document'; });
    await options.getByLabel('DeepSeek API Key', { exact: true }).fill('fake-test-injected-key');
    await saveForm();
    await expect(article.locator('near-translate')).toHaveCount(1);
    expect(await article.evaluate(() => (globalThis as unknown as { __nearDocumentMarker: string }).__nearDocumentMarker)).toBe('same-open-document');
    await article.locator('#already-open').evaluate(element => {
      const range = document.createRange(); range.selectNodeContents(element);
      const selection = document.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
      const rect = element.getBoundingClientRect();
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true, clientX: rect.right - 4, clientY: rect.bottom - 4 }));
    });
    await article.getByRole('button', { name: '翻译选中文字' }).click();
    await expect(article.locator('.nt-text')).toHaveText('模拟接口翻译成功。');
    expect((await capturedRequests()).at(-1)).toMatchObject({
      url: 'https://api.deepseek.com/chat/completions', authorization: 'Bearer fake-test-injected-key',
    });
    expect(await article.content()).not.toContain('fake-test-injected-key');
  } finally {
    await article.close();
    await context.unroute(fixtureUrl);
  }
});

test('a required-key model can be saved disabled before a Key is configured', async () => {
  await options.getByLabel('API 服务商', { exact: true }).selectOption('qwen');
  await expect(options.getByLabel('通义千问（百炼） API Key', { exact: true })).toHaveValue('');
  await options.getByLabel('启用翻译', { exact: true }).uncheck();
  await saveForm();
  expect(await readConnection()).toMatchObject({ provider: 'qwen', enabled: false, hasApiKey: false, requiresApiKey: true });
  expect((await translateFromOptions()).at(-1)).toMatchObject({ type: 'error', error: { code: 'CONFIG' } });
  expect(await capturedRequests()).toHaveLength(0);
});

test('an anonymous custom local endpoint translates through the background with its chosen model', async () => {
  await options.getByLabel('API 服务商', { exact: true }).selectOption('custom');
  await options.getByLabel('API Base URL', { exact: true }).fill('http://localhost:11434/v1/chat/completions/');
  await options.getByLabel('模型名', { exact: true }).fill('local-translation-model');
  await options.getByLabel('JSON 模式', { exact: true }).uncheck();
  await saveForm();
  const settings = await readConnection();
  expect(settings).toMatchObject({ provider: 'custom', baseUrl: 'http://localhost:11434/v1', hasApiKey: false, requiresApiKey: false, apiAccess: true });
  const events = await translateFromOptions();
  expect(events.at(-1)).toMatchObject({ type: 'result', result: { kind: 'text', translation: '模拟接口翻译成功。' } });
  expect(await capturedRequests()).toEqual([{
    url: 'http://localhost:11434/v1/chat/completions', authorization: null,
    body: expect.objectContaining({ model: 'local-translation-model', stream: true, max_tokens: 8192 }),
    credentials: 'omit', redirect: 'error',
  }]);
  expect((await capturedRequests())[0]?.body).not.toHaveProperty('thinking');
});

test('changing a saved API destination cannot reuse its previous credential', async () => {
  await seedConnection({ provider: 'custom', baseUrl: 'https://first-gateway.example/v1', model: 'custom-model', jsonMode: false, apiKey: 'fake-test-private-gateway-key' });
  await options.reload();
  await expect(options.getByLabel('API Base URL', { exact: true })).toHaveValue('https://first-gateway.example/v1');
  await expect(options.getByLabel('自定义 OpenAI 兼容接口 API Key', { exact: true })).toHaveValue('');
  await options.getByLabel('API Base URL', { exact: true }).fill('https://second-gateway.example/v1');
  await saveForm();
  expect(await readConnection()).toMatchObject({ provider: 'custom', baseUrl: 'https://second-gateway.example/v1', hasApiKey: false });
  expect((await translateFromOptions()).at(-1)).toMatchObject({ type: 'result' });
  expect((await capturedRequests()).at(-1)).toMatchObject({ url: 'https://second-gateway.example/v1/chat/completions', authorization: null });
});

test('changing the model terminates a streaming request and the next translation uses the new model', async () => {
  await worker.evaluate(() => { (globalThis as unknown as { __nearConnectionsTest: TestState }).__nearConnectionsTest.slowNext = true; });
  const pending = translateFromOptions().then(messages => ({ messages, error: undefined }), error => ({ messages: undefined, error }));
  await expect.poll(() => options.evaluate(() =>
    (globalThis as unknown as { __nearConnectionMessages?: TranslationServerMessage[] }).__nearConnectionMessages?.some(message => message.type === 'delta') ?? false,
  )).toBe(true);
  await options.getByLabel('模型名', { exact: true }).fill('deepseek-replacement-model');
  await saveForm();
  const oldRequest = await pending;
  expect(oldRequest.error).toBeUndefined();
  expect(oldRequest.messages?.at(-1)).toMatchObject({ type: 'error', error: { code: 'CONFIG', retryable: false } });
  expect(oldRequest.messages?.some(message => message.type === 'result')).toBe(false);
  await expect.poll(() => worker.evaluate(() => (globalThis as unknown as { __nearConnectionsTest: TestState }).__nearConnectionsTest.aborts)).toBe(1);
  expect((await translateFromOptions()).at(-1)).toMatchObject({ type: 'result' });
  const requests = await capturedRequests();
  expect(requests).toHaveLength(2);
  expect(requests[0]?.body.model).toBe('deepseek-test-model');
  expect(requests[1]?.body.model).toBe('deepseek-replacement-model');
});

test('concurrent saves from two options pages preserve both provider profiles and leave translation usable', async () => {
  const second = await context.newPage();
  try {
    await second.goto(`chrome-extension://${extensionId}/options.html`);
    await expect(second.getByRole('button', { name: '保存设置', exact: true })).toBeEnabled();
    await Promise.all([
      seedConnection({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'concurrent-deepseek-model', jsonMode: true, apiKey: 'fake-concurrent-deepseek-key' }),
      seedConnection({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'concurrent-openai-model', jsonMode: true, apiKey: 'fake-concurrent-openai-key' }, second),
    ]);
    const settings = await readConnection();
    expect(settings.profiles.deepseek).toMatchObject({ model: 'concurrent-deepseek-model', hasApiKey: true });
    expect(settings.profiles.openai).toMatchObject({ model: 'concurrent-openai-model', hasApiKey: true });
    expect(settings.model).toBe(settings.profiles[settings.provider]?.model);
    expect((await translateFromOptions()).at(-1)).toMatchObject({ type: 'result' });
    expect((await capturedRequests()).at(-1)?.body.model).toBe(settings.model);
  } finally {
    await second.close();
  }
});

for (const action of ['delete-key', 'disable-translation'] as const) {
  test(`${action} can be saved when requesting API permissions is denied`, async () => {
    await options.evaluate(() => {
      const global = globalThis as unknown as {
        chrome: { permissions: { request: (permissions: object) => Promise<boolean> } };
        browser?: { permissions: { request: (permissions: object) => Promise<boolean> } };
        __nearDeniedPermissionCalls: number;
      };
      global.__nearDeniedPermissionCalls = 0;
      const denied = async () => { global.__nearDeniedPermissionCalls++; return false; };
      global.chrome.permissions.request = denied;
      if (global.browser) global.browser.permissions.request = denied;
    });
    // Verify the refusal actually reaches the form, despite the E2E manifest's granted hosts.
    await options.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(options.getByRole('alert')).toContainText('未获得翻译所需权限');
    expect(await options.evaluate(() => (globalThis as unknown as { __nearDeniedPermissionCalls: number }).__nearDeniedPermissionCalls)).toBe(1);
    expect(await readConnection()).toMatchObject({ enabled: true, hasApiKey: true });

    if (action === 'delete-key') await options.getByRole('button', { name: '删除已保存的 Key', exact: true }).click();
    else await options.getByLabel('启用翻译', { exact: true }).uncheck();
    await saveForm();
    expect(await readConnection()).toMatchObject(action === 'delete-key' ? { hasApiKey: false } : { enabled: false, hasApiKey: true });
    expect(await options.evaluate(() => (globalThis as unknown as { __nearDeniedPermissionCalls: number }).__nearDeniedPermissionCalls)).toBe(1);
    expect((await translateFromOptions()).at(-1)).toMatchObject({ type: 'error', error: { code: 'CONFIG' } });
    expect(await capturedRequests()).toHaveLength(0);
  });
}

test('an old authenticated Ollama Key can be discarded without its old passphrase', async () => {
  const { vault } = await createEncryptedKeyVault('fixture-only-forgotten-old-passphrase', {
    ollama: { baseUrl: 'http://localhost:11434/v1', apiKey: 'fake-test-legacy-ollama-auth' },
  });
  await options.evaluate(async vault => {
    const global = globalThis as unknown as {
      chrome: { storage: { local: { set(data: Record<string, unknown>): Promise<void>; remove(key: string): Promise<void> } } };
    };
    await global.chrome.storage.local.set({
      'key-vault:v1': vault,
      'settings:v1': {
        schemaVersion: 3, translationEngine: 'model', enabled: true, includeContext: true, sentenceAnalysisEnabled: false,
        provider: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'legacy-ollama-model', jsonMode: false,
        profiles: { ollama: { baseUrl: 'http://localhost:11434/v1', model: 'legacy-ollama-model', jsonMode: false } },
      },
    });
    await global.chrome.storage.local.remove('connection-settings:v2');
  }, vault);
  await options.reload();
  await expect(options.getByLabel('API 服务商', { exact: true })).toHaveValue('ollama');
  expect(await readConnection()).toMatchObject({ hasApiKey: false, requiresApiKey: false, apiKeyMigrationRequired: true, legacyKeyProviders: ['ollama'] });
  expect((await translateFromOptions()).at(-1)).toMatchObject({ type: 'error', error: { code: 'CONFIG' } });
  expect(await capturedRequests()).toHaveLength(0);
  await options.getByRole('button', { name: '删除已保存的 Key', exact: true }).click();
  await saveForm();
  expect(await readConnection()).toMatchObject({ hasApiKey: false, apiKeyMigrationRequired: false, legacyKeyProviders: [] });
  expect((await translateFromOptions()).at(-1)).toMatchObject({ type: 'result' });
  expect((await capturedRequests()).at(-1)).toMatchObject({
    url: 'http://localhost:11434/v1/chat/completions', authorization: null, body: { model: 'legacy-ollama-model' },
  });
  const preserved = await options.evaluate(() => (globalThis as unknown as {
    chrome: { storage: { local: { get(key: string): Promise<Record<string, unknown>> } } };
  }).chrome.storage.local.get('key-vault:v1'));
  expect(preserved['key-vault:v1']).toEqual(vault);
});
