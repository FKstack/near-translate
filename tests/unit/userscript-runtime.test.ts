import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GMRequest } from '../../src/userscript/gm';
import type { TranslationServerMessage } from '../../src/shared/contracts';
import { KEY_VAULT_SESSION_KEY } from '../../src/shared/key-vault';

const shim = vi.hoisted(() => ({ browser: undefined as typeof import('../../src/userscript/browser')['browser'] | undefined }));
vi.mock('wxt/browser', () => ({ get browser() { return shim.browser; } }));

const PREFIX = 'near-translate:userscript:v1:';
const DEEPL = 'https://oneshot-free.www.deepl.com/v1/translate';
const PASS = 'fixture-only userscript passphrase';
const KEY = 'fixture-only-private-api-key';
let persisted: Map<string, unknown>;
let listeners: Map<number, { key: string; listener: (key: string, oldValue: unknown, newValue: unknown, remote: boolean) => void }>;
let nextListener: number;
let requests: { details: GMRequest; abort: ReturnType<typeof vi.fn>; startedAt: number }[];
let cleanup: (() => void) | undefined;
let api: typeof import('../../src/userscript/browser');
let runtime: typeof import('../../src/userscript/runtime');

function write(key: string, value: unknown, remote = false) {
  const oldValue = persisted.get(key);
  if (value === undefined) persisted.delete(key); else persisted.set(key, structuredClone(value));
  for (const entry of listeners.values()) if (entry.key === key) entry.listener(key, oldValue, value, remote);
}

async function settle() { for (let index = 0; index < 30; index++) await Promise.resolve(); }
async function until(predicate: () => boolean) { await vi.waitFor(() => expect(predicate()).toBe(true), { interval: 5 }); }
function respond(index: number, payload: unknown, status = 200) {
  const request = requests[index]!;
  request.details.onload({ status, finalUrl: request.details.url, responseHeaders: 'content-type: application/json', responseText: JSON.stringify(payload) });
}
async function install() { cleanup = await runtime.installRuntime({ onOpenSettings: vi.fn() }); }
async function configureModel(options: { includeContext?: boolean } = {}) {
  expect(await api.browser.runtime.sendMessage({ type: 'save-settings', settings: {
    translationEngine: 'model', enabled: true, includeContext: false, sentenceAnalysisEnabled: true,
    provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: KEY, jsonMode: true,
    ...options,
  } })).toMatchObject({ ok: true });
}

beforeEach(async () => {
  vi.resetModules(); persisted = new Map(); listeners = new Map(); nextListener = 0; requests = []; cleanup = undefined;
  vi.stubGlobal('GM_getValue', (key: string, fallback?: unknown) => persisted.has(key) ? structuredClone(persisted.get(key)) : fallback);
  vi.stubGlobal('GM_setValue', vi.fn((key: string, value: unknown) => write(key, value)));
  vi.stubGlobal('GM_deleteValue', (key: string) => write(key, undefined));
  vi.stubGlobal('GM_listValues', () => [...persisted.keys()]);
  vi.stubGlobal('GM_info', { scriptHandler: 'Tampermonkey', version: '5.4.0' });
  vi.stubGlobal('location', { href: 'https://fkstack.github.io/near-translate/userscript/settings.html' });
  vi.stubGlobal('navigator', { locks: { request: vi.fn(async (_name: string, _options: unknown, action: () => Promise<unknown>) => action()) } });
  vi.stubGlobal('GM_addValueChangeListener', (key: string, listener: typeof listeners extends Map<number, infer T> ? T extends { listener: infer L } ? L : never : never) => {
    const id = ++nextListener; listeners.set(id, { key, listener }); return id;
  });
  vi.stubGlobal('GM_removeValueChangeListener', (id: number) => listeners.delete(id));
  vi.stubGlobal('GM_xmlhttpRequest', (details: GMRequest) => {
    const abort = vi.fn(() => details.onabort()); requests.push({ details, abort, startedAt: Date.now() }); return { abort };
  });
  api = await import('../../src/userscript/browser'); shim.browser = api.browser; runtime = await import('../../src/userscript/runtime');
});
afterEach(async () => { cleanup?.(); await settle(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('userscript sandbox storage and runtime', () => {
  it('persists only GM local data, isolates session secrets, and never uses page storage', async () => {
    vi.stubGlobal('localStorage', { getItem() { throw new Error('Page storage must not be read'); }, setItem() { throw new Error('Page storage must not be written'); } });
    await api.browser.storage.local.set({ 'settings:v1': { enabled: false } });
    await api.browser.storage.session.set({ [KEY_VAULT_SESSION_KEY]: { key: 'private-session' } });
    expect(persisted.get(PREFIX + 'settings:v1')).toEqual({ enabled: false });
    expect(JSON.stringify([...persisted])).not.toContain('private-session');
    expect(await api.browser.storage.session.get(KEY_VAULT_SESSION_KEY)).toEqual({ [KEY_VAULT_SESSION_KEY]: { key: 'private-session' } });
    vi.resetModules();
    const fresh = await import('../../src/userscript/browser');
    expect(await fresh.browser.storage.session.get(KEY_VAULT_SESSION_KEY)).toEqual({});
    expect(await fresh.browser.storage.local.get('settings:v1')).toEqual({ 'settings:v1': { enabled: false } });
    expect((globalThis as Record<string, unknown>).browser).toBeUndefined();
  });

  it('returns public settings and reading preferences through private messages', async () => {
    await install();
    expect(await api.browser.runtime.sendMessage({ type: 'get-settings' })).toMatchObject({ translationEngine: 'deepl-web', enabled: true, hasApiKey: false });
    const settings = await api.browser.runtime.sendMessage({ type: 'get-connection-settings' });
    expect(settings).toMatchObject({ networkPreparationAccess: false });
    expect(await api.browser.runtime.sendMessage({ type: 'save-reading-preferences', preferences: { fontSize: 24 } })).toMatchObject({ ok: true });
    expect(await api.browser.runtime.sendMessage({ type: 'get-reading-preferences' })).toMatchObject({ ok: true });
    expect(persisted.has(PREFIX + 'reading-preferences:v1')).toBe(true);
    expect(await api.browser.runtime.sendMessage({ type: 'fetch', url: 'https://unapproved.example' })).toEqual({ ok: false });
    expect(requests).toHaveLength(0);
  });

  it('reuses TranslationClient with the DeepL protocol and preserves source segments', async () => {
    await install();
    const { TranslationClient } = await import('../../src/platform/translation-client');
    const events: TranslationServerMessage[] = [];
    const client = new TranslationClient(event => events.push(event));
    client.start({ kind: 'text', text: 'Hello\n\nWorld', pageSegments: ['Hello', 'World'] });
    await until(() => requests.length === 1);
    expect(requests[0]!.details).toMatchObject({ url: DEEPL + '?near_translate_lane=0', anonymous: true, redirect: 'error', method: 'POST', responseType: 'text' });
    expect(JSON.parse(requests[0]!.details.data).text).toEqual(['Hello', 'World']);
    respond(0, { translations: [{ text: '你好' }, { text: '世界' }] });
    await until(() => events.some(event => event.type === 'result'));
    expect(events.at(-1)).toMatchObject({ type: 'result', result: { translation: '你好\n\n世界', segments: ['你好', '世界'] } });
    client.dispose();
  });

  it('saves model keys privately without a passphrase and streams SSE while public messages omit them', async () => {
    await install(); await configureModel();
    const publicValue = await api.browser.runtime.sendMessage({ type: 'get-settings' });
    const connectionValue = await api.browser.runtime.sendMessage({ type: 'get-connection-settings' });
    expect(publicValue).toMatchObject({ hasApiKey: true, translationEngine: 'model' });
    expect(JSON.stringify([publicValue, connectionValue])).not.toContain(KEY);
    expect(JSON.stringify([...persisted])).toContain(KEY);
    expect([...persisted.keys()].some(key => key.includes(KEY_VAULT_SESSION_KEY))).toBe(false);
    const { TranslationClient } = await import('../../src/platform/translation-client');
    const events: TranslationServerMessage[] = [];
    const client = new TranslationClient(event => events.push(event));
    client.start({ kind: 'text', text: 'Hello there.' });
    await until(() => requests.length === 1);
    expect(requests[0]!.details.url).toBe('https://api.deepseek.com/chat/completions');
    expect(requests[0]!.details.responseType).toBe('stream');
    expect(requests[0]!.details.headers.authorization).toBe(`Bearer ${KEY}`);
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    requests[0]!.details.onloadstart!({ status: 200, finalUrl: requests[0]!.details.url, response: stream });
    controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"你好"},"finish_reason":null}]}\n\n'));
    await until(() => events.some(event => event.type === 'delta'));
    controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
    controller.close();
    await until(() => events.some(event => event.type === 'result'));
    expect(events.at(-1)).toMatchObject({ type: 'result', result: { translation: '你好' } });
    client.dispose();
  });

  it('cancels the actual GM request when a client disposes', async () => {
    await install();
    const { TranslationClient } = await import('../../src/platform/translation-client');
    const events: TranslationServerMessage[] = [];
    const client = new TranslationClient(event => events.push(event));
    client.start({ kind: 'text', text: 'Hello' });
    await until(() => requests.length === 1);
    client.dispose();
    await until(() => requests[0]!.abort.mock.calls.length > 0);
    respond(0, { translations: [{ text: '你好' }] });
    await settle(); expect(events.some(event => event.type === 'result')).toBe(false);
  });

  it('cancels requests and broadcasts fresh usable settings after a remote configuration change', async () => {
    await install(); await configureModel();
    const broadcasts: unknown[] = [];
    api.browser.runtime.onMessage.addListener((message, sender) => {
      expect(sender).toMatchObject({ id: api.browser.runtime.id, url: api.browser.runtime.getURL('') });
      broadcasts.push(message);
    });
    const { TranslationClient } = await import('../../src/platform/translation-client');
    const events: TranslationServerMessage[] = [];
    const client = new TranslationClient(event => events.push(event));
    client.start({ kind: 'text', text: 'Hello' });
    await until(() => requests.length === 1);
    const saved = persisted.get(PREFIX + 'connection-settings:v2') as { settings: Record<string, unknown> };
    write(PREFIX + 'connection-settings:v2', { ...saved, settings: { ...saved.settings, connectionRevision: 999 } }, true);
    await until(() => requests[0]!.abort.mock.calls.length > 0);
    expect(await api.browser.runtime.sendMessage({ type: 'get-settings' })).toMatchObject({ hasApiKey: true, apiKeyMigrationRequired: false });
    expect(events.some(event => event.type === 'error' && event.error.code === 'CONFIG')).toBe(true);
    await settle(); expect(broadcasts.some(message => (message as { type?: string }).type === 'settings-changed')).toBe(true);
    expect(JSON.stringify(broadcasts)).not.toContain(KEY);
    client.dispose();
  });

  it('persists a DeepL cooldown and rejects work in a fresh page without another network call', async () => {
    await install();
    const { TranslationClient } = await import('../../src/platform/translation-client');
    const events: TranslationServerMessage[] = [];
    const client = new TranslationClient(event => events.push(event));
    client.start({ kind: 'text', text: 'Hello' });
    await until(() => requests.length === 1);
    respond(0, { error: { message: 'Too many requests' } }, 429);
    await until(() => events.some(event => event.type === 'error'));
    expect(persisted.get(PREFIX + 'deepl-web:cooldown-until:v1')).toBeGreaterThan(Date.now());
    client.dispose(); cleanup!(); cleanup = undefined;
    vi.resetModules();
    api = await import('../../src/userscript/browser'); shim.browser = api.browser; runtime = await import('../../src/userscript/runtime');
    await install();
    const next = await import('../../src/platform/translation-client');
    const freshEvents: TranslationServerMessage[] = [];
    const fresh = new next.TranslationClient(event => freshEvents.push(event));
    fresh.start({ kind: 'text', text: 'Another request' });
    await until(() => freshEvents.some(event => event.type === 'error'));
    expect(freshEvents.at(-1)).toMatchObject({ type: 'error', error: { code: 'RATE_LIMIT' } });
    expect(requests).toHaveLength(1); fresh.dispose();
  });

  it('admits eight DeepL requests, holds the ninth, and removes cancelled waiting work', async () => {
    vi.useFakeTimers();
    await install();
    const { TranslationClient } = await import('../../src/platform/translation-client');
    const events: TranslationServerMessage[][] = Array.from({ length: 10 }, () => []);
    const clients = events.map(events => new TranslationClient(event => events.push(event)));
    clients.slice(0, 9).forEach((client, index) => client.start({ kind: 'text', text: `Public passage ${index}.` }));
    await vi.advanceTimersByTimeAsync(800);
    expect(requests).toHaveLength(8);
    expect(requests.every(request => request.details.responseType === 'text')).toBe(true);
    expect(new Set(requests.map(request => request.details.url)).size).toBe(8);
    expect(requests.slice(1).map((request, index) => request.startedAt - requests[index]!.startedAt)).toEqual(Array(7).fill(100));
    respond(0, { translations: [{ text: '第一' }] });
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toHaveLength(9);
    expect(events[0]!.some(event => event.type === 'result')).toBe(true);
    clients[9]!.start({ kind: 'text', text: 'Cancelled waiting passage.' });
    await vi.advanceTimersByTimeAsync(0);
    clients[9]!.cancel();
    respond(1, { translations: [{ text: '第二' }] });
    await vi.advanceTimersByTimeAsync(300);
    expect(requests).toHaveLength(9);
    clients.forEach(client => client.dispose());
    expect(requests.slice(2).every(request => request.abort.mock.calls.length > 0)).toBe(true);
    respond(2, { translations: [{ text: '迟到结果' }] });
    await vi.advanceTimersByTimeAsync(0);
    expect(events[2]!.some(event => event.type === 'result')).toBe(false);
  });

  it('keeps the DeepL rolling 30-start budget when completed requests release slots immediately', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('GM_xmlhttpRequest', (details: GMRequest) => {
      const abort = vi.fn(() => details.onabort());
      requests.push({ details, abort, startedAt: Date.now() });
      queueMicrotask(() => details.onload({ status: 200, finalUrl: details.url,
        responseText: JSON.stringify({ translations: [{ text: '测试译文' }] }) }));
      return { abort };
    });
    await install();
    const { TranslationClient } = await import('../../src/platform/translation-client');
    const clients = Array.from({ length: 31 }, (_, index) => {
      const client = new TranslationClient(() => {});
      client.start({ kind: 'text', text: `Public rolling-window passage ${index}.` });
      return client;
    });
    await vi.advanceTimersByTimeAsync(11_999);
    expect(requests).toHaveLength(30);
    await vi.advanceTimersByTimeAsync(1);
    expect(requests).toHaveLength(31);
    expect(requests[30]!.startedAt - requests[0]!.startedAt).toBe(12_000);
    clients.forEach(client => client.dispose());
  });

  it('cancels active and waiting DeepL work on a remote cooldown without admitting late work', async () => {
    vi.useFakeTimers();
    await install();
    const { TranslationClient } = await import('../../src/platform/translation-client');
    const events: TranslationServerMessage[][] = Array.from({ length: 10 }, () => []);
    const clients = events.map(events => new TranslationClient(event => events.push(event)));
    clients.slice(0, 9).forEach((client, index) => client.start({ kind: 'text', text: `Public cooldown passage ${index}.` }));
    await vi.advanceTimersByTimeAsync(800);
    expect(requests).toHaveLength(8);
    const retryAt = Date.now() + 60_000;
    write(PREFIX + 'deepl-web:cooldown-until:v1', retryAt, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(events.slice(0, 9).every(events => events.some(event => event.type === 'error' && event.error.code === 'RATE_LIMIT'))).toBe(true);
    expect(requests.every(request => request.abort.mock.calls.length > 0)).toBe(true);
    clients[9]!.start({ kind: 'text', text: 'Request after restored remote cooldown.' });
    respond(0, { translations: [{ text: '迟到译文' }] });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(requests).toHaveLength(8);
    expect(events[0]!.some(event => event.type === 'result')).toBe(false);
    expect(events[9]!.at(-1)).toMatchObject({ type: 'error', error: { code: 'RATE_LIMIT', retryAt } });
    clients.forEach(client => client.dispose());
  });

  it('flushes DeepL peers and waiting work when one concurrent request returns 429', async () => {
    vi.useFakeTimers();
    await install();
    const { TranslationClient } = await import('../../src/platform/translation-client');
    const events: TranslationServerMessage[][] = Array.from({ length: 9 }, () => []);
    const clients = events.map((events, index) => {
      const client = new TranslationClient(event => events.push(event));
      client.start({ kind: 'text', text: `Public limited passage ${index}.` });
      return client;
    });
    await vi.advanceTimersByTimeAsync(800);
    expect(requests).toHaveLength(8);
    respond(0, { message: 'Rate limit exceeded' }, 429);
    await vi.advanceTimersByTimeAsync(0);
    expect(events.every(events => events.some(event => event.type === 'error' && event.error.code === 'RATE_LIMIT'))).toBe(true);
    expect(requests.slice(1).every(request => request.abort.mock.calls.length > 0)).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(requests).toHaveLength(8);
    clients.forEach(client => client.dispose());
  });

  it('stops DeepL peers on early 429 headers before the text body finishes', async () => {
    vi.useFakeTimers();
    await install();
    const { TranslationClient } = await import('../../src/platform/translation-client');
    const events: TranslationServerMessage[][] = Array.from({ length: 9 }, () => []);
    const clients = events.map((events, index) => {
      const client = new TranslationClient(event => events.push(event));
      client.start({ kind: 'text', text: `Public early-limit passage ${index}.` });
      return client;
    });
    await vi.advanceTimersByTimeAsync(800);
    expect(requests).toHaveLength(8);
    expect(requests.every(({ details }) => !details.onloadstart && !details.onprogress)).toBe(true);
    requests[0]!.details.onreadystatechange({ status: 429, readyState: 2, finalUrl: requests[0]!.details.url });
    await vi.advanceTimersByTimeAsync(0);
    expect(requests.slice(1).every(request => request.abort.mock.calls.length > 0)).toBe(true);
    expect(events.slice(1).every(events => events.some(event => event.type === 'error' && event.error.code === 'RATE_LIMIT'))).toBe(true);
    expect(persisted.get(PREFIX + 'deepl-web:cooldown-until:v1')).toBeGreaterThan(Date.now());
    respond(0, { message: 'Rate limit exceeded' }, 429);
    await vi.advanceTimersByTimeAsync(0);
    expect(events[0]!.at(-1)).toMatchObject({ type: 'error', error: { code: 'RATE_LIMIT' } });
    expect(requests).toHaveLength(8);
    clients.forEach(client => client.dispose());
  });

  it('cancels the old DeepL generation before switching engines, including waiting work', async () => {
    vi.useFakeTimers();
    await install();
    const { TranslationClient } = await import('../../src/platform/translation-client');
    const events: TranslationServerMessage[][] = Array.from({ length: 9 }, () => []);
    const clients = events.map((events, index) => {
      const client = new TranslationClient(event => events.push(event));
      client.start({ kind: 'text', text: `Public prior-generation passage ${index}.` });
      return client;
    });
    await vi.advanceTimersByTimeAsync(800);
    expect(requests).toHaveLength(8);
    await configureModel();
    await vi.advanceTimersByTimeAsync(0);
    expect(requests.every(request => request.abort.mock.calls.length > 0)).toBe(true);
    expect(events.every(events => events.some(event => event.type === 'error' && event.error.code === 'CONFIG'))).toBe(true);
    respond(0, { translations: [{ text: '旧配置迟到译文' }] });
    const next = new TranslationClient(() => {});
    next.start({ kind: 'text', text: 'New model generation.' });
    await vi.advanceTimersByTimeAsync(300);
    expect(requests).toHaveLength(9);
    expect(requests[8]!.details).toMatchObject({ url: 'https://api.deepseek.com/chat/completions', responseType: 'stream' });
    expect(events[0]!.some(event => event.type === 'result')).toBe(false);
    clients.forEach(client => client.dispose()); next.dispose();
  });

  it.each([
    ['enabled', false], ['translationEngine', 'model'], ['targetLanguage', 'ja'], ['sourceLanguage', 'ja'],
  ] as const)('rechecks %s after a DeepL batch waits for a slot even before remote notification', async (field, value) => {
    vi.useFakeTimers();
    await install();
    expect(await api.browser.runtime.sendMessage({ type: 'enable-free-translation' })).toMatchObject({ ok: true });
    const { TranslationClient } = await import('../../src/platform/translation-client');
    const events: TranslationServerMessage[][] = Array.from({ length: 9 }, () => []);
    const clients = events.map((events, index) => {
      const client = new TranslationClient(event => events.push(event));
      client.start({ kind: 'text', text: `Public waiting passage ${index}.` });
      return client;
    });
    await vi.advanceTimersByTimeAsync(800);
    expect(requests).toHaveLength(8);
    const key = PREFIX + 'connection-settings:v2';
    const saved = persisted.get(key) as { settings: Record<string, unknown> };
    // Keep the GM notification pending while releasing a real provider slot.
    persisted.set(key, { ...saved, settings: { ...saved.settings, [field]: value } });
    respond(0, { translations: [{ text: '第一段译文' }] });
    await vi.advanceTimersByTimeAsync(200);
    expect(requests).toHaveLength(8);
    expect(events[8]!.at(-1)).toMatchObject({ type: 'error', error: { code: 'CONFIG' } });
    clients.forEach(client => client.dispose());
  });

  it('keeps model requests serial and streaming while remote DeepL cooldowns leave them running', async () => {
    vi.useFakeTimers();
    await install(); await configureModel();
    const { TranslationClient } = await import('../../src/platform/translation-client');
    const firstEvents: TranslationServerMessage[] = [];
    const first = new TranslationClient(event => firstEvents.push(event));
    const second = new TranslationClient(() => {});
    first.start({ kind: 'text', text: 'First model passage.' });
    second.start({ kind: 'text', text: 'Second model passage.' });
    await vi.advanceTimersByTimeAsync(800);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.details.responseType).toBe('stream');
    write(PREFIX + 'deepl-web:cooldown-until:v1', Date.now() + 60_000, true);
    expect(requests[0]!.abort).not.toHaveBeenCalled();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    requests[0]!.details.onloadstart!({ status: 200, finalUrl: requests[0]!.details.url, response: stream });
    controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"第一"}}]}\n\n'));
    await vi.advanceTimersByTimeAsync(0);
    expect(firstEvents.some(event => event.type === 'delta')).toBe(true);
    expect(requests).toHaveLength(1);
    controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
    controller.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(firstEvents.some(event => event.type === 'result')).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.details.responseType).toBe('stream');
    first.dispose(); second.dispose();
  });

  it.each(['includeContext', 'sentenceAnalysisEnabled'] as const)(
    'does not send a queued model request after %s changes before its storage notification arrives', async flag => {
      vi.useFakeTimers();
      await install(); await configureModel({ includeContext: true });
      const { TranslationClient } = await import('../../src/platform/translation-client');
      const first = new TranslationClient(() => {});
      const events: TranslationServerMessage[] = [];
      const waiting = new TranslationClient(event => events.push(event));
      first.start({ kind: 'text', text: 'First model passage.' });
      waiting.start({ kind: 'text', text: 'This waiting model passage contains enough English words.', context: 'Private nearby context.',
        ...(flag === 'sentenceAnalysisEnabled' ? { task: 'sentence-analysis' as const } : {}) });
      await vi.advanceTimersByTimeAsync(800);
      expect(requests).toHaveLength(1);
      const key = PREFIX + 'connection-settings:v2';
      const saved = persisted.get(key) as { settings: Record<string, unknown> };
      // GM storage can change before its remote listener is delivered. These
      // capability flags intentionally do not increment connectionRevision.
      persisted.set(key, { ...saved, settings: { ...saved.settings, [flag]: false } });
      first.cancel();
      await vi.advanceTimersByTimeAsync(0);
      expect(requests).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'CONFIG' } });
      first.dispose(); waiting.dispose();
    });

  it('honours a remotely extended cooldown after this provider has already loaded its state', async () => {
    await install();
    await api.browser.runtime.sendMessage({ type: 'get-translation-status' });
    const retryAt = Date.now() + 60_000;
    write(PREFIX + 'deepl-web:cooldown-until:v1', retryAt, true);
    const { TranslationClient } = await import('../../src/platform/translation-client');
    const events: TranslationServerMessage[] = [];
    const client = new TranslationClient(event => events.push(event));
    client.start({ kind: 'text', text: 'Hello' });
    await until(() => events.some(event => event.type === 'error'));
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'RATE_LIMIT', retryAt } });
    expect(requests).toHaveLength(0); client.dispose();
  });

  it('uses a saved Key in a new article document without unlocking or changing storage', async () => {
    await install(); await configureModel();
    const snapshot = JSON.stringify([...persisted]);
    cleanup?.(); await settle(); vi.resetModules();
    vi.stubGlobal('location', { href: 'http://article.example/another' });
    api = await import('../../src/userscript/browser'); shim.browser = api.browser;
    runtime = await import('../../src/userscript/runtime'); await install();
    const publicValue = await api.browser.runtime.sendMessage({ type: 'get-settings' });
    expect(publicValue).toMatchObject({ hasApiKey: true, apiKeyMigrationRequired: false });
    expect(JSON.stringify(publicValue)).not.toContain(KEY);
    const { TranslationClient } = await import('../../src/platform/translation-client');
    const events: TranslationServerMessage[] = [];
    const client = new TranslationClient(event => events.push(event));
    client.start({ kind: 'text', text: 'A newly opened article.' });
    await until(() => requests.length === 1);
    expect(requests[0]!.details.headers.authorization).toBe('Bearer ' + KEY);
    expect(JSON.stringify([...persisted])).toEqual(snapshot);
    client.dispose();
  });

  it('limits saves and legacy import to the canonical settings page with Web Locks', async () => {
    await install();
    vi.stubGlobal('location', { href: 'https://article.example/near-translate/userscript/settings.html' });
    for (const message of [{ type: 'save-settings', settings: {} }, { type: 'import-legacy-keys', passphrase: PASS }]) {
      expect(await api.browser.runtime.sendMessage(message)).toMatchObject({ ok: false, error: expect.stringContaining('专用设置页') });
    }
    expect(await api.browser.runtime.sendMessage({ type: 'enable-free-translation' })).toMatchObject({ ok: false });
    expect(persisted.size).toBe(0);
    vi.stubGlobal('location', { href: 'https://fkstack.github.io/near-translate/userscript/settings.html' });
    vi.stubGlobal('navigator', { locks: undefined });
    for (const message of [{ type: 'save-settings', settings: {} }, { type: 'import-legacy-keys', passphrase: PASS }]) {
      expect(await api.browser.runtime.sendMessage(message)).toMatchObject({ ok: false, error: expect.stringContaining('Web Locks') });
    }
    expect(persisted.size).toBe(0);
    for (const type of ['create-key-vault','unlock-key-vault','lock-key-vault','change-key-vault-passphrase']) {
      expect(await api.browser.runtime.sendMessage({ type, passphrase: PASS })).toEqual({ ok: false });
    }
  });

  it.each([undefined, { scriptHandler: 'Violentmonkey', version: '99.0' }, { scriptHandler: 'Tampermonkey', version: '5.3.9' },
    { scriptHandler: 'Tampermonkey', version: '5.4.0beta' }, { scriptHandler: 'Tampermonkey', version: 'invalid' }])(
    'requires a verified Tampermonkey version before sending a network request (%j)', async info => {
      vi.stubGlobal('GM_info', info);
      await install();
      expect(await api.browser.runtime.sendMessage({ type: 'get-reading-preferences' })).toMatchObject({ ok: true });
      const { createGMFetch } = await import('../../src/userscript/transport');
      await expect(createGMFetch(DEEPL)(DEEPL, { method: 'POST', body: '{}', credentials: 'omit', redirect: 'error' })).rejects.toMatchObject({ code: 'CONFIG' });
      expect(requests).toHaveLength(0);
    });

  it('rejects arbitrary destinations, redirects and cookie-bearing request modes', async () => {
    const { createGMFetch } = await import('../../src/userscript/transport');
    const fetcher = createGMFetch('https://api.deepseek.com/chat/completions');
    const init = { method: 'POST', body: '{}', credentials: 'omit', redirect: 'error' } as const;
    await expect(fetcher('https://attacker.example', init)).rejects.toMatchObject({ code: 'CONFIG' });
    await expect(fetcher('https://api.deepseek.com/chat/completions', { ...init, credentials: 'include' })).rejects.toMatchObject({ code: 'CONFIG' });
    expect(requests).toHaveLength(0);
    const response = fetcher('https://api.deepseek.com/chat/completions', init);
    requests[0]!.details.onload({ status: 200, finalUrl: 'https://attacker.example', responseText: 'private data' });
    await expect(response).rejects.toMatchObject({ code: 'NETWORK' });
    expect(requests[0]!.abort).toHaveBeenCalled();
  });

  it('aborts a stalled request on its own deadline even when GM ignores timeout', async () => {
    vi.useFakeTimers();
    try {
      const { createGMFetch } = await import('../../src/userscript/transport');
      const fetcher = createGMFetch(DEEPL);
      const response = fetcher(DEEPL, { method: 'POST', body: '{}', credentials: 'omit', redirect: 'error' });
      const rejection = expect(response).rejects.toMatchObject({ code: 'TIMEOUT' });
      await vi.advanceTimersByTimeAsync(90_000);
      await rejection;
      expect(requests[0]!.abort).toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
