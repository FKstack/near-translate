import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Real browser/native transport probe. No user profile, saved credential, fetch
// replacement, permission rewriting, or successful/billable API request is used.
const RUN_LIMIT_MS = 35_000;
const NETWORK_LIMIT_MS = 30_000;
const started = Date.now();
const workDeadline = started + RUN_LIMIT_MS - 3_000;
const placeholderKey = 'sk-native-fetch-probe-deliberately-invalid-not-a-user-key';
const workspace = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const output = await realpath(resolve(workspace, '.output'));
assert.equal(relative(workspace, output), '.output', 'Unexpected output directory.');
const extension = await realpath(resolve(workspace, process.env.NEAR_EXTENSION_DIR || '.output/chrome-mv3'));
assert(!relative(output, extension).startsWith('..') && !relative(output, extension).startsWith(sep), 'The production extension must be inside workspace .output.');
const manifestPath = resolve(extension, 'manifest.json');
const manifestText = await readFile(manifestPath, 'utf8');
const manifest = JSON.parse(manifestText);
assert(manifest.host_permissions?.includes('https://api.deepseek.com/*'), 'Production API permission is missing.');
assert(manifest.optional_host_permissions?.includes('https://*/*'), 'Use the unchanged production manifest, not the E2E permission copy.');
assert(!manifest.host_permissions?.includes('https://*/*'), 'Use the unchanged production website permissions.');

let stage = 'launch';
let context;
let profile;
let networkDeadline;
let success = false;
const report = (value) => console.log(JSON.stringify(value));
const failure = (code) => Object.assign(new Error(code), { probeCode: code });
function remaining(deadline = workDeadline) {
  const milliseconds = Math.min(deadline, workDeadline) - Date.now();
  if (milliseconds <= 0) throw failure('PROBE_DEADLINE');
  return milliseconds;
}
async function bounded(operation, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => { timer = setTimeout(() => reject(failure('PROBE_DEADLINE')), Math.max(1, milliseconds)); }),
    ]);
  } finally { clearTimeout(timer); }
}

try {
  profile = await mkdtemp(resolve(output, 'native-fetch-profile-'));
  const channel = process.env.NEAR_BROWSER_CHANNEL || 'msedge';
  const executablePath = process.env.NEAR_BROWSER_EXECUTABLE;
  const branded = channel !== 'chromium' || !!executablePath;
  context = await chromium.launchPersistentContext(profile, {
    channel, executablePath, headless: true,
    timeout: Math.min(10_000, remaining()),
    ignoreDefaultArgs: ['--disable-extensions'],
    args: branded ? ['--enable-unsafe-extension-debugging']
      : [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  if (branded) {
    const debug = await bounded(context.browser().newBrowserCDPSession(), remaining());
    try { await bounded(debug.send('Extensions.loadUnpacked', { path: extension }), remaining()); }
    finally { await debug.detach().catch(() => {}); }
  }
  report({ stage: 'browser', channel, version: context.browser()?.version(), productionManifest: true, isolatedProfile: true });
  const worker = context.serviceWorkers()[0]
    || await context.waitForEvent('serviceworker', { timeout: Math.min(8_000, remaining()) });
  const extensionId = new URL(worker.url()).host;

  stage = 'native-receiver';
  const receiver = await bounded(worker.evaluate(async () => {
    const native = /\[native code\]/.test(Function.prototype.toString.call(globalThis.fetch));
    const response = await globalThis.fetch('data:text/plain,native-fetch-ok');
    const dataOk = response.status === 200 && await response.text() === 'native-fetch-ok';
    const holder = { fetch: globalThis.fetch };
    let illegalInvocation = false;
    try { await holder.fetch('data:text/plain,must-not-work'); }
    catch (error) { illegalInvocation = error instanceof TypeError && /Illegal invocation/i.test(error.message); }
    return { native, dataOk, illegalInvocation };
  }), remaining());
  report({ stage, ...receiver });
  assert(receiver.native && receiver.dataOk && receiver.illegalInvocation, 'Native receiver regression was not reproduced.');

  stage = 'native-network';
  networkDeadline = Math.min(Date.now() + NETWORK_LIMIT_MS, workDeadline);
  const network = await bounded(worker.evaluate(async ({ key, timeout }) => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeout);
    try {
      const response = await globalThis.fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST', credentials: 'omit', signal: abort.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: 'deepseek-flash', messages: [{ role: 'user', content: 'Translate: test' }],
          thinking: { type: 'disabled' }, max_tokens: 1, stream: false,
        }),
      });
      void response.body?.cancel().catch(() => {});
      return { status: response.status, errorName: null };
    } catch (error) { return { status: null, errorName: error instanceof Error ? error.name : 'UnknownError' }; }
    finally { clearTimeout(timer); }
  }, { key: placeholderKey, timeout: Math.min(10_000, remaining(networkDeadline)) }), remaining(networkDeadline));
  report({ stage, status: network.status, errorName: network.errorName });

  stage = 'save-isolated-settings';
  const options = await bounded(context.newPage(), remaining());
  await options.goto(`chrome-extension://${extensionId}/options.html`, { timeout: remaining() });
  const saved = await bounded(options.evaluate(async (key) => {
    const result = await chrome.runtime.sendMessage({
      type: 'save-settings', keepExistingKey: false,
      settings: { enabled: true, includeContext: false, model: 'deepseek-flash', apiKey: key },
    });
    return { ok: result?.ok === true, hasApiKey: result?.settings?.hasApiKey === true };
  }, placeholderKey), remaining());
  assert(saved.ok && saved.hasApiKey, 'Isolated placeholder configuration failed.');

  stage = 'translation-port';
  const portResult = await bounded(options.evaluate((timeout) => new Promise((resolve) => {
    const requestId = `native-fetch-probe-${Date.now()}`;
    const port = chrome.runtime.connect({ name: 'near-translate:v1' });
    let finished = false;
    let started = false;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { port.postMessage({ type: 'cancel', requestId }); } catch {}
      port.disconnect();
      resolve({ ...value, started });
    };
    const timer = setTimeout(() => finish({ code: 'PROBE_TIMEOUT' }), timeout);
    port.onMessage.addListener((message) => {
      if (message.requestId !== requestId) return;
      if (message.type === 'started') started = true;
      if (message.type === 'error') finish({ code: message.error?.code || 'MISSING_ERROR_CODE' });
      if (message.type === 'result') finish({ code: 'UNEXPECTED_RESULT' });
    });
    port.onDisconnect.addListener(() => { if (!finished) finish({ code: 'DISCONNECTED' }); });
    port.postMessage({ type: 'translate', requestId, input: { kind: 'word', text: 'test' } });
  }), Math.max(1, remaining(networkDeadline) - 200)), remaining(networkDeadline));
  report({ stage, code: portResult.code, started: portResult.started });
  assert.equal(network.status, 401, 'Native network probe must reach API authentication.');
  assert.equal(portResult.code, 'AUTH', 'Production translation must reach AUTH, not NETWORK.');
  assert.equal(portResult.started, true, 'Background translation request did not start.');
  success = true;
} catch (error) {
  process.exitCode = 1;
  // Deliberately omit error messages/stacks and all request material.
  report({ stage, outcome: 'failed', code: error?.probeCode || (error instanceof assert.AssertionError ? 'ASSERTION_FAILED' : error?.name || 'PROBE_FAILED') });
} finally {
  stage = 'cleanup';
  try {
    if (context) await bounded(context.close(), Math.max(1, started + RUN_LIMIT_MS - Date.now()));
    if (profile) {
      const actual = await realpath(profile);
      const local = relative(output, actual);
      assert(local.startsWith('native-fetch-profile-') && !local.includes(sep), 'Refuse profile cleanup outside the isolated workspace folder.');
      await bounded(rm(actual, { recursive: true, force: true }), Math.max(1, started + RUN_LIMIT_MS - Date.now()));
    }
    assert.equal(await readFile(manifestPath, 'utf8'), manifestText, 'Production manifest changed.');
  } catch {
    process.exitCode = 1;
    success = false;
    report({ stage, outcome: 'failed', code: 'CLEANUP_FAILED' });
  }
  report({ stage: 'complete', outcome: success ? 'passed' : 'failed', elapsedMs: Date.now() - started, runLimitMs: RUN_LIMIT_MS, networkLimitMs: NETWORK_LIMIT_MS });
}
