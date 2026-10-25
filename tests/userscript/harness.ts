import type { JSHandle, Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const FIXTURE_ORIGIN = 'http://127.0.0.1:4178';
export const SETTINGS_URL = 'https://fkstack.github.io/near-translate/userscript/settings.html';
export const DEEPL_ENDPOINT = 'https://oneshot-free.www.deepl.com/v1/translate';
export const MODEL_ENDPOINT = 'https://api.deepseek.com/chat/completions';
export const OLLAMA_ENDPOINT = 'http://localhost:11434/v1/chat/completions';
export const SELECTED_TEXT = 'Concurrency does not imply parallelism.';
export const SELECTED_TRANSLATION = '并发不意味着并行。';
export const INERT_TRANSLATION = '<img src=x onerror="window.translationExecuted=true">译文保持纯文本。';

type MockRequest = { url: string; method: string; responseType?: string; anonymous?: boolean; headers?: Record<string, string>; data: string;
  body: { text: string[]; target_lang: string; messages?: Array<{ role: string; content: string }> } };
type TransportEvent = { url: string; type: 'start' | 'load' | 'chunk' | 'partial' | 'eof' | 'failure' | 'cancel' | 'abort' | 'text'; crossRealm?: boolean; splitsUtf8?: boolean };
export type HarnessState = { requests: MockRequest[]; rejected: string[]; tabs: string[]; menus: Map<number, { title: string; callback: () => unknown }>;
  metadataRequests: Array<{ url: string; anonymous?: boolean; redirect?: string; method?: string }>;
  transportEvents: TransportEvent[]; releaseStreams(): void; failNextRequests(count: number): void;
  storage: Map<string, unknown>; settingsRoot?: ShadowRoot; remoteWrite(key: string, value: unknown): void };

interface UpdateFixture { installedVersion?: string; availableVersion?: string; metadataFailure?: boolean }
interface NetworkFixture { responseMode?: 'stream' | 'text'; pauseAfterFirstDelta?: boolean; failAfterFirstDelta?: boolean; failRequests?: number }

/**
 * Execute the real release bundle with grants in a function closure, as a
 * userscript manager does. No GM function, private store, or runtime test hook
 * is installed on window. Playwright alone retains this remote state handle.
 */
export async function installUserscript(page: Page, settingsPage = false, update: UpdateFixture = {}, initialStorage: Record<string, unknown> = {}, network: NetworkFixture = {}): Promise<JSHandle<HarnessState>> {
  const greasyfork = process.env.NEAR_USERSCRIPT_DISTRIBUTION === 'greasyfork';
  const application = await readFile(resolve(greasyfork ? '.output/greasyfork/near-translate.user.js' : '.output/userscript/near-translate.user.js'), 'utf8');
  // The manager evaluates @require before the application in the same sandbox.
  // Tests use the exact pinned npm bytes instead of contacting a real CDN.
  const library = greasyfork ? (await Promise.all([
    readFile(resolve('node_modules/opencc-js/dist/umd/full.js'), 'utf8'),
    readFile(resolve('node_modules/@mozilla/readability/Readability.js'), 'utf8'),
  ])).join('\n') : '';
  const source = `${library}\n${application}`;
  const fixture = await readFile(new URL('./fixture.html', import.meta.url), 'utf8');
  const settings = settingsPage ? await readFile(resolve(greasyfork ? '.output/greasyfork/settings.html' : '.output/userscript-site/userscript/settings.html'), 'utf8') : '';
  await page.route('**/*', route => {
    const url = route.request().url();
    if (url === `${FIXTURE_ORIGIN}/article`) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture });
    if (settingsPage && url === SETTINGS_URL) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: settings });
    return route.abort('blockedbyclient');
  });
  await page.goto(settingsPage ? SETTINGS_URL : `${FIXTURE_ORIGIN}/article`);
  const metadataUrl = greasyfork
    ? 'https://update.greasyfork.org/scripts/601973/%E8%BF%91%E8%AF%91%20%C2%B7%20%E7%BD%91%E9%A1%B5%E9%98%85%E8%AF%BB%E4%B8%8E%E7%BF%BB%E8%AF%91.meta.js'
    : 'https://fkstack.github.io/near-translate/userscript/near-translate.meta.js';
  return page.evaluateHandle(({ source, endpoint, modelEndpoint, ollamaEndpoint, selected, translated, inert, settingsPage, update, metadataUrl, initialStorage, network }) => {
    type XhrOptions = { url: string; method?: string; data?: string; responseType?: string; anonymous?: boolean; redirect?: string; headers?: Record<string, string>;
      onloadstart?: (response: object) => void; onreadystatechange?: (response: object) => void; onprogress?: (response: object) => void;
      onload?: (response: object) => void; onerror?: (response: object) => void; onabort?: (response: object) => void };
    type ValueListener = (key: string, previous: unknown, next: unknown, remote: boolean) => void;
    const values = new Map<string, unknown>(Object.entries(structuredClone(initialStorage)));
    const listeners = new Map<number, { key: string; callback: ValueListener }>();
    const continuations = new Set<() => void>();
    let failures = network.failRequests ?? 0;
    const state: HarnessState = { requests: [], rejected: [], metadataRequests: [], transportEvents: [], tabs: [], menus: new Map(), storage: values,
      releaseStreams() { const pending = [...continuations]; continuations.clear(); for (const resume of pending) resume(); },
      failNextRequests(count) { failures = count; },
      remoteWrite(key, value) {
        const previous = values.get(key);
        values.set(key, copy(value));
        notify(key, previous, value, true);
      },
    };
    // GM can deliver byte views from its own realm. Retain only the constructor,
    // remove the fixture frame before the application starts, and never expose
    // either the manager grants or this private harness state on page window.
    const frame = document.createElement('iframe');
    document.documentElement.append(frame);
    const ForeignBytes = (frame.contentWindow as unknown as { Uint8Array: typeof Uint8Array }).Uint8Array;
    frame.remove();
    if (settingsPage) {
      const original = Element.prototype.attachShadow;
      Element.prototype.attachShadow = function (options) {
        const shadow = original.call(this, options);
        if (this.localName === 'near-userscript-settings') {
          state.settingsRoot = shadow;
          Element.prototype.attachShadow = original;
        }
        return shadow;
      };
    }
    let nextId = 0;
    const copy = <T,>(value: T): T => value === undefined ? value : structuredClone(value);
    const translate = (text: string) => text === selected ? translated
      : text === 'Render translated HTML as plain text.' ? inert : `译文：${text}`;
    const notify = (key: string, previous: unknown, next: unknown, remote = false) => {
      for (const listener of listeners.values()) if (listener.key === key) {
        queueMicrotask(() => listener.callback(key, copy(previous), copy(next), remote));
      }
    };
    const grants = {
      GM_getValue: (key: string, fallback?: unknown) => copy(values.has(key) ? values.get(key) : fallback),
      GM_setValue: (key: string, value: unknown) => {
        const previous = values.get(key); values.set(key, copy(value)); notify(key, previous, value);
      },
      GM_deleteValue: (key: string) => { const previous = values.get(key); values.delete(key); notify(key, previous, undefined); },
      GM_listValues: () => [...values.keys()],
      GM_addValueChangeListener: (key: string, callback: ValueListener) => { const id = ++nextId; listeners.set(id, { key, callback }); return id; },
      GM_removeValueChangeListener: (id: number) => { listeners.delete(id); },
      GM_registerMenuCommand: (title: string, callback: () => unknown) => { const id = ++nextId; state.menus.set(id, { title, callback }); return id; },
      GM_unregisterMenuCommand: (id: number) => { state.menus.delete(id); },
      GM_openInTab: (url: string) => { state.tabs.push(url); return { close() {} }; },
      GM_xmlhttpRequest: (options: XhrOptions) => {
        let done = false;
        let aborted = false;
        let complete = false;
        let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
        let resume: (() => void) | undefined;
        const timers = new Set<ReturnType<typeof setTimeout>>();
        const event = (type: TransportEvent['type'], extra: Partial<TransportEvent> = {}) => state.transportEvents.push({ url: options.url, type, ...extra });
        const clear = () => { for (const timer of timers) clearTimeout(timer); timers.clear(); if (resume) continuations.delete(resume); };
        const later = (callback: () => void, delay = 5) => {
          const timer = setTimeout(() => { timers.delete(timer); if (!done) callback(); }, delay);
          timers.add(timer);
        };
        const deliver = (first: string, rest: string, contentType: string) => {
          const response = { status: 200, statusText: 'OK', responseHeaders: `Content-Type: ${contentType}\r\n`, finalUrl: options.url };
          if (options.responseType !== 'stream' || network.responseMode === 'text') {
            if (options.responseType === 'text') {
              options.onloadstart?.({ status: 0, readyState: 1 });
              options.onreadystatechange?.({ ...response, readyState: 2 });
              options.onprogress?.({ ...response, readyState: 3, responseText: first.slice(0, 5) });
            }
            done = true; complete = true; event('text');
            options.onload?.({ ...response, responseText: first + rest });
            return;
          }
          const stream = new ReadableStream<Uint8Array>({
            start(value) { controller = value; },
            cancel() { if (!complete) { done = true; clear(); event('cancel'); } },
          });
          // The stream can be supplied before usable headers; later events do
          // not have to repeat it. This matches the manager callback boundary.
          event('start'); options.onloadstart?.({ status: 0, readyState: 1, response: stream });
          options.onreadystatechange?.({ ...response, readyState: 2 });
          // GM's load callback need not wait until consumers finish the stream.
          event('load'); options.onload?.({ ...response, readyState: 4 });
          const pump = (text: string, finish: () => void) => {
            const bytes = new TextEncoder().encode(text);
            const unicode = bytes.findIndex(value => value >= 0x80);
            const cuts = [...new Set([1, 9, 27, unicode + 1, unicode + 2, bytes.length - 1, bytes.length])]
              .filter(offset => offset > 0 && offset <= bytes.length).sort((a, b) => a - b);
            let offset = 0;
            const next = () => {
              const end = cuts.shift();
              if (end === undefined) { finish(); return; }
              const chunk = new ForeignBytes(bytes.subarray(offset, end));
              offset = end;
              event('chunk', { crossRealm: !(chunk instanceof Uint8Array), splitsUtf8: end < bytes.length && (bytes[end]! & 0xc0) === 0x80 });
              controller!.enqueue(chunk); options.onprogress?.({ ...response, readyState: 3 });
              if (cuts.length) later(next); else finish();
            };
            later(next);
          };
          pump(first, () => {
            const finish = () => {
              if (done) return;
              if (network.failAfterFirstDelta && contentType === 'text/event-stream') {
                done = true; event('failure'); controller!.error(new Error('Simulated GM stream read failure')); return;
              }
              pump(rest, () => { done = true; complete = true; event('eof'); controller!.close(); });
            };
            if (rest && contentType === 'text/event-stream') {
              event('partial'); resume = finish;
              if (network.pauseAfterFirstDelta) continuations.add(finish);
              else later(finish);
            } else { done = true; complete = true; event('eof'); controller!.close(); }
          });
        };
        later(() => {
          if (done) return;
          if (options.url === metadataUrl && options.method === 'GET') {
            done = true; complete = true;
            state.metadataRequests.push({ url: options.url, anonymous: options.anonymous, redirect: options.redirect, method: options.method });
            if (update.metadataFailure) options.onerror?.({ error: 'Simulated metadata network failure.' });
            else options.onload?.({ status: 200, finalUrl: metadataUrl,
              responseText: `// ==UserScript==\n// @version ${update.availableVersion ?? update.installedVersion ?? '0.0.0-test'}\n// ==/UserScript==\n` });
            return;
          }
          if ((options.url === modelEndpoint || options.url === ollamaEndpoint) && options.method === 'POST') {
            const data = options.data ?? '';
            const body = JSON.parse(data) as MockRequest['body'];
            state.requests.push({ url: options.url, method: options.method, responseType: options.responseType, anonymous: options.anonymous, headers: options.headers, data, body });
            if (failures > 0) { failures--; done = true; event('failure'); options.onerror?.({ error: 'Simulated GM network failure' }); return; }
            const sse = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
            const user = body.messages?.find(message => message.role === 'user');
            const envelope = user ? JSON.parse(user.content) as { segments?: Array<{ i: number; text: string }> } : {};
            // Page translation has its own NDJSON protocol inside SSE. Return
            // every requested index, so the real incremental batch decoder runs.
            const deltas = envelope.segments ? envelope.segments.map(segment => JSON.stringify({ i: segment.i, t: translate(segment.text) }) + '\n')
              : [translated.slice(0, 2), translated.slice(2)];
            deliver(sse(deltas[0]!), deltas.slice(1).map(sse).join('') + 'data: [DONE]\n\n', 'text/event-stream');
            return;
          }
          if (options.url !== endpoint || options.method !== 'POST') {
            done = true;
            state.rejected.push(options.url);
            options.onerror?.({ error: 'Unexpected remote request in isolated userscript E2E.' });
            return;
          }
          const data = options.data ?? '';
          const body = JSON.parse(data) as { text: string[]; target_lang: string };
          state.requests.push({ url: options.url, method: options.method, responseType: options.responseType, anonymous: options.anonymous, data, body });
          if (failures > 0) { failures--; done = true; event('failure'); options.onerror?.({ error: 'Simulated GM network failure' }); return; }
          const payload = { translations: body.text.map(text => ({ text: translate(text) })) };
          deliver(JSON.stringify(payload), '', 'application/json');
        }, 35);
        return { abort() {
          if (aborted || complete) return;
          aborted = true; done = true; clear(); event('abort');
          try { controller?.error(new DOMException('Fixture request cancelled', 'AbortError')); } catch { /* Already cancelled by the reader. */ }
          options.onabort?.({});
        } };
      },
      GM_info: { script: { version: update.installedVersion ?? '0.0.0-test' }, scriptHandler: 'Tampermonkey', version: '5.4.0' },
    };
    new Function(...Object.keys(grants), source)(...Object.values(grants));
    return state;
  }, { source, endpoint: DEEPL_ENDPOINT, modelEndpoint: MODEL_ENDPOINT, ollamaEndpoint: OLLAMA_ENDPOINT, selected: SELECTED_TEXT, translated: SELECTED_TRANSLATION, inert: INERT_TRANSLATION, settingsPage, update, metadataUrl, initialStorage, network });
}

/** Native DOM interactions held behind the test's remote closed-root handle. */
export async function settingsField(state: JSHandle<HarnessState>, label: string, value: string | boolean): Promise<void> {
  await state.evaluate((state, { label, value }) => {
    const root = state.settingsRoot;
    const wrapper = [...root?.querySelectorAll('label') ?? []].find(element => element.firstChild?.textContent?.trim() === label
      || [...element.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join('').trim() === label);
    const input = wrapper?.querySelector('input,select');
    if (!(input instanceof HTMLInputElement || input instanceof HTMLSelectElement)) throw new Error(`Missing settings field: ${label}`);
    if (input.disabled) throw new Error(`Disabled settings field: ${label}`);
    if (typeof value === 'boolean' && input instanceof HTMLInputElement) {
      if (input.checked !== value) input.click();
    } else if (typeof value === 'string') {
      const prototype = input instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLSelectElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    }
  }, { label, value });
}

export async function settingsClick(state: JSHandle<HarnessState>, text: string): Promise<void> {
  await state.evaluate((state, text) => {
    const button = [...state.settingsRoot?.querySelectorAll('button,summary') ?? []].find(element => element.textContent?.trim() === text);
    if (!button || (button instanceof HTMLButtonElement && button.disabled)) throw new Error(`Missing enabled settings button: ${text}`);
    (button as HTMLElement).click();
  }, text);
}

export async function selectParagraph(page: Page, selector: string): Promise<void> {
  await page.locator(selector).scrollIntoViewIfNeeded();
  await page.locator(selector).evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = document.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    const rect = element.getBoundingClientRect();
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true, clientX: rect.right - 4, clientY: rect.bottom - 4 }));
  });
}
