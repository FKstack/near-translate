// One anonymous public-text request from an isolated MV3 browser extension.
// No Cookie, API key, spoofed identity headers, retries, proxies or challenge handling.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const workspace = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
const output = await realpath(resolve(workspace, '.output'));
assert.equal(relative(workspace, output), '.output');
const temporary = await mkdtemp(resolve(output, 'deepl-anonymous-probe-'));
const extension = resolve(temporary, 'extension');
const sourceText = 'The library is open from nine to five.';
let context;
let observation;
try {
  await mkdir(extension);
  await writeFile(resolve(extension, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: 'Near Translate anonymous transport qualification', version: '0.0.1',
    host_permissions: ['https://www2.deepl.com/*'], background: { service_worker: 'worker.js' },
  }));
  await writeFile(resolve(extension, 'worker.js'), 'chrome.runtime.onInstalled.addListener(() => {});');
  context = await chromium.launchPersistentContext(resolve(temporary, 'profile'), {
    channel: 'msedge', headless: true, timeout: 15000,
    ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'],
  });
  const debuggerSession = await context.browser().newBrowserCDPSession();
  let loaded;
  try { loaded = await debuggerSession.send('Extensions.loadUnpacked', { path: extension }); }
  finally { await debuggerSession.detach(); }
  const worker = context.serviceWorkers().find(item => new URL(item.url()).host === loaded.id)
    ?? await context.waitForEvent('serviceworker', { predicate: item => new URL(item.url()).host === loaded.id, timeout: 8000 });
  observation = await worker.evaluate(async text => {
    const started = performance.now();
    const request = { jsonrpc: '2.0', id: 1, method: 'LMT_handle_texts', params: {
      splitting: 'newlines', lang: { source_lang_user_selected: 'EN', target_lang: 'ZH' },
      texts: [{ text, requestAlternatives: 0 }], timestamp: Date.now(),
    } };
    try {
      const response = await globalThis.fetch('https://www2.deepl.com/jsonrpc', {
        method: 'POST', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
      });
      const payload = await response.json().catch(() => undefined);
      const texts = payload?.result?.texts;
      const translated = response.ok && !payload?.error && Array.isArray(texts)
        && texts.length === 1 && typeof texts[0]?.text === 'string' && !!texts[0].text.trim();
      return {
        status: response.status, milliseconds: Math.round(performance.now() - started), translated,
        translation: translated ? texts[0].text : null,
        errorCode: typeof payload?.error?.code === 'number' ? payload.error.code : null,
        errorMessage: typeof payload?.error?.message === 'string' ? payload.error.message.slice(0, 200) : null,
        retryAfter: response.headers.get('retry-after'),
      };
    } catch (error) {
      return { status: null, translated: false, errorName: error.name, milliseconds: Math.round(performance.now() - started) };
    }
  }, sourceText);
  observation.browser = context.browser().version();
} catch (error) {
  observation = { status: null, translated: false, stage: 'browser-launch-or-setup', errorName: error.name };
} finally {
  await context?.close().catch(() => {});
  const canonical = await realpath(temporary);
  const child = relative(output, canonical);
  assert(child.startsWith('deepl-anonymous-probe-') && !child.includes(sep) && !child.startsWith('..'));
  await rm(canonical, { recursive: true, force: true });
}
const report = {
  generatedAt: new Date().toISOString(), sourceText,
  endpoint: 'https://www2.deepl.com/jsonrpc', attemptLimit: 1,
  userCookiesOrKeysUsed: false, identityHeadersSpoofed: false,
  originalOJBetterRequestReproduced: false,
  qualification: 'minimal-native-MV3-request; not an exact OJBetter client emulation',
  observation,
};
await mkdir(resolve(workspace, 'docs/evidence'), { recursive: true });
await writeFile(resolve(workspace, 'docs/evidence/deepl-anonymous-probe-2026-10-21.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
