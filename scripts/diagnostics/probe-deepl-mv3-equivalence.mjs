// Explicit live qualification probe. Running this file can send at most three
// anonymous public-text requests; node --check does not execute the probe.
// Protocol reference: OJBetter 860106c63ef7bb7d4ec5dcd709f80a9f9a6f1a46.
// This independently implements its request format, without importing the
// archived GPL userscript or adding any production translation dependency.
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ENDPOINT = 'https://www2.deepl.com/jsonrpc';
const ENDPOINT_PATTERN = '^https://www2\\.deepl\\.com/jsonrpc$';
const ORIGIN = 'https://www.deepl.com';
const REFERER = 'https://www.deepl.com/';
const HOST_PERMISSION = 'https://www2.deepl.com/*';
const REQUEST_TIMEOUT_MS = 15_000;
const WIRE_TIMEOUT_MS = 5_000;
const MINIMUM_GAP_MS = 1_000;
const RUN_TIMEOUT_MS = 90_000;
const BODY_LIMIT = 64_000;
const PUBLIC_CASES = [
  { stage: 'single-sentence', text: 'The library is open from nine to five.' },
  { stage: 'serial-sentence-1', text: 'The train arrives at the station at noon.' },
  { stage: 'serial-sentence-2', text: 'Please close the window before you leave.' },
];

function inside(parent, child) {
  const part = relative(parent, child);
  return !!part && !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`);
}

function cleanHeaders(headers = {}) {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [
    name, /cookie|authorization/i.test(name) ? '[present; redacted]' : value,
  ]));
}

function headerValue(headers, name) {
  return Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

// Public protocol compatibility, expressed separately from transport and CDP.
function encodeRequest(text, now = Date.now()) {
  const id = randomInt(100_000, 199_999) * 1_000;
  const iCount = [...text].filter(character => character === 'i').length;
  const divisor = iCount + 1;
  const timestamp = iCount ? (Math.floor(now / divisor) + 1) * divisor : now;
  const payload = {
    jsonrpc: '2.0', method: 'LMT_handle_texts', id,
    params: {
      splitting: 'newlines',
      lang: { source_lang_user_selected: 'auto', target_lang: 'ZH' },
      texts: [{ text, requestAlternatives: 3 }], timestamp,
    },
  };
  const spacedColon = (id + 5) % 29 === 0 || (id + 3) % 13 === 0;
  const body = JSON.stringify(payload).replace('"method":', spacedColon ? '"method" : ' : '"method": ');
  return { payload, body, iCount, spacing: spacedColon ? 'space-before-and-after-colon' : 'space-after-colon' };
}

// Owns the extra CDP target sessions, bounded command promises and passive
// network evidence. It never sends translation requests or changes headers.
function createWireObserver(cdp, extensionId) {
  const sessions = new Map();
  const attaching = new Map();
  const pending = new Map();
  const records = new Map();
  const errors = [];
  let commandId = 0;
  let requestSequence = 0;
  let stopped = false;

  function send(sessionId, method, params = {}) {
    return new Promise((fulfill, reject) => {
      if (stopped) return reject(new Error('CDP observer is stopped.'));
      const id = ++commandId;
      const key = `${sessionId}:${id}`;
      const timer = setTimeout(() => {
        pending.delete(key);
        reject(new Error(`CDP command timed out: ${method}`));
      }, WIRE_TIMEOUT_MS);
      const finish = (callback, value) => {
        clearTimeout(timer);
        pending.delete(key);
        callback(value);
      };
      pending.set(key, { resolve: value => finish(fulfill, value), reject: error => finish(reject, error) });
      cdp.send('Target.sendMessageToTarget', {
        sessionId, message: JSON.stringify({ id, method, params }),
      }).catch(error => pending.get(key)?.reject(error));
    });
  }

  function recordFor(sessionId, requestId) {
    const key = `${sessionId}:${requestId}`;
    if (!records.has(key)) records.set(key, { sessionId, requestId });
    return records.get(key);
  }

  const onMessage = ({ sessionId, message }) => {
    if (stopped || !sessions.has(sessionId)) return;
    let event;
    try { event = JSON.parse(message); }
    catch { errors.push('Invalid CDP target message.'); return; }
    if (event.id !== undefined) {
      const command = pending.get(`${sessionId}:${event.id}`);
      if (command) event.error ? command.reject(new Error(event.error.message)) : command.resolve(event.result);
      return;
    }
    const data = event.params ?? {};
    if (!data.requestId || !event.method?.startsWith('Network.')) return;
    const record = recordFor(sessionId, data.requestId);
    if (event.method === 'Network.requestWillBeSent' && data.request.url === ENDPOINT) {
      record.sequence = ++requestSequence;
      record.target = sessions.get(sessionId);
      record.request = {
        url: data.request.url, method: data.request.method,
        headers: cleanHeaders(data.request.headers), postData: data.request.postData ?? null,
        resourceType: data.type, timestamp: data.timestamp, wallTime: data.wallTime,
        initiator: data.initiator,
      };
    } else if (event.method === 'Network.requestWillBeSentExtraInfo') {
      // ExtraInfo can precede requestWillBeSent, so retain it until the URL is known.
      record.wire = {
        headers: cleanHeaders(data.headers),
        credentialHeaderNames: Object.keys(data.headers ?? {}).filter(name => /cookie|authorization/i.test(name)),
        associatedCookieCount: data.associatedCookies?.length ?? null,
      };
    } else if (event.method === 'Network.responseReceived') {
      record.response = {
        status: data.response.status, url: data.response.url,
        headers: cleanHeaders(data.response.headers), protocol: data.response.protocol,
        fromDiskCache: data.response.fromDiskCache ?? false,
        fromServiceWorker: data.response.fromServiceWorker ?? false,
      };
    } else if (event.method === 'Network.responseReceivedExtraInfo') {
      record.responseExtra = { statusCode: data.statusCode, headers: cleanHeaders(data.headers) };
    } else if (event.method === 'Network.loadingFailed') {
      record.failed = { errorText: data.errorText, canceled: data.canceled ?? false, blockedReason: data.blockedReason ?? null };
    } else if (event.method === 'Network.loadingFinished' && record.request) {
      record.finished = { timestamp: data.timestamp, encodedDataLength: data.encodedDataLength };
      record.bodyPending = true;
      send(sessionId, 'Network.getResponseBody', { requestId: data.requestId }).then(body => {
        const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
        record.body = { text: text.slice(0, BODY_LIMIT), truncated: text.length > BODY_LIMIT };
      }).catch(error => { record.bodyError = error.message; }).finally(() => { record.bodyPending = false; });
    }
  };

  async function attach(target) {
    if (stopped || !['service_worker', 'page', 'background_page'].includes(target.type)
      || !target.url.startsWith(`chrome-extension://${extensionId}/`)) return;
    if (attaching.has(target.targetId)) return attaching.get(target.targetId);
    const operation = (async () => {
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
      sessions.set(sessionId, { id: target.targetId, type: target.type, url: target.url });
      await send(sessionId, 'Network.enable', {
        maxTotalBufferSize: 1_000_000, maxResourceBufferSize: 250_000, maxPostDataSize: BODY_LIMIT,
      });
    })();
    attaching.set(target.targetId, operation);
    return operation;
  }

  const onCreated = ({ targetInfo }) => { attach(targetInfo).catch(error => errors.push(error.message)); };
  const onDetached = ({ sessionId }) => {
    sessions.delete(sessionId);
    for (const [key, command] of pending) if (key.startsWith(`${sessionId}:`)) command.reject(new Error('CDP target detached.'));
  };
  const ordered = () => [...records.values()].filter(record => record.request).sort((a, b) => a.sequence - b.sequence);

  return {
    errors,
    async start() {
      cdp.on('Target.receivedMessageFromTarget', onMessage);
      cdp.on('Target.targetCreated', onCreated);
      cdp.on('Target.detachedFromTarget', onDetached);
      await cdp.send('Target.setDiscoverTargets', { discover: true });
      for (const target of (await cdp.send('Target.getTargets')).targetInfos) await attach(target);
      assert(sessions.size > 0, 'The extension network observer is not attached.');
      assert.equal(errors.length, 0, 'CDP network setup failed.');
    },
    async completion(expectedCount) {
      const deadline = Date.now() + WIRE_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const matching = ordered();
        assert(matching.length <= expectedCount, 'Unexpected extra translation request; no further calls allowed.');
        const record = matching[expectedCount - 1];
        if (matching.length === expectedCount && record?.wire
          && (record.failed || (record.finished && !record.bodyPending))) return record;
        await delay(25);
      }
      throw new Error('Timed out collecting the actual request headers and response body.');
    },
    snapshot() {
      return ordered().map(({ bodyPending, ...record }) => ({ ...record, responseBodyPending: bodyPending ?? false }));
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      cdp.off('Target.receivedMessageFromTarget', onMessage);
      cdp.off('Target.targetCreated', onCreated);
      cdp.off('Target.detachedFromTarget', onDetached);
      for (const command of [...pending.values()]) command.reject(new Error('CDP observer stopped.'));
      await Promise.allSettled([...sessions.keys()].map(sessionId => cdp.send('Target.detachFromTarget', { sessionId })));
      sessions.clear();
    },
  };
}

function validateResult(observation, record, request) {
  assert.equal(observation.status, 200, 'Non-200 response; stop without retries.');
  assert(record, 'No CDP record for this translation.');
  assert.equal(record.request.method, 'POST');
  assert.equal(record.request.resourceType, 'Fetch');
  assert.equal(record.request.postData, request.body, 'The wire request differs from the complete protocol.');
  assert.deepEqual(JSON.parse(record.request.postData), request.payload);
  assert.equal(headerValue(record.wire.headers, 'origin'), ORIGIN, 'DNR Origin did not reach the wire.');
  assert.equal(headerValue(record.wire.headers, 'referer'), REFERER, 'DNR Referer did not reach the wire.');
  assert.equal(headerValue(record.wire.headers, 'content-type'), 'application/json');
  assert.deepEqual(record.wire.credentialHeaderNames, [], 'A Cookie or authorization header reached the wire.');
  assert.equal(record.response?.status, 200);
  if (record.responseExtra) assert.equal(record.responseExtra.statusCode, 200);
  assert(!record.failed && record.body && !record.body.truncated, 'Response evidence is incomplete.');
  assert.equal(record.response.fromDiskCache, false);
  assert.equal(record.response.fromServiceWorker, false);
  assert.equal(record.body.text, observation.responseText, 'Worker and CDP response bodies differ.');
  const payload = JSON.parse(observation.responseText);
  assert(!payload.error, 'Provider error payload; stop without retries.');
  assert.equal(payload.jsonrpc, '2.0');
  assert.equal(payload.id, request.payload.id, 'Response request ID is out of order.');
  assert(Array.isArray(payload.result?.texts) && payload.result.texts.length === 1, 'Expected exactly one translated text per original-format request.');
  const translation = payload.result.texts[0]?.text;
  assert(typeof translation === 'string' && translation.trim() && /\p{Script=Han}/u.test(translation), 'Expected a nonempty Chinese translation.');
  return translation;
}

const workspace = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
const output = await realpath(resolve(workspace, '.output'));
assert.equal(relative(workspace, output), '.output');
const evidencePath = resolve(workspace, 'docs/evidence/deepl-mv3-equivalence-2026-10-21.json');
const deadline = Date.now() + RUN_TIMEOUT_MS;
const bounded = async (operation, timeout = 10_000) => {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Probe stage deadline exceeded.')), Math.max(1, Math.min(timeout, deadline - Date.now()))); }),
    ]);
  } finally { clearTimeout(timer); }
};
const report = {
  schemaVersion: 1,
  endpoint: ENDPOINT,
  reference: { repository: 'https://github.com/beijixiaohu/OJBetter', commit: '860106c63ef7bb7d4ec5dcd709f80a9f9a6f1a46', file: 'script/release/atcoder-better.user.js', version: '1.25.1' },
  qualification: 'complete-OJBetter-request-format-over-native-MV3-with-own-extension-scoped-DNR',
  sourceTexts: PUBLIC_CASES.map(item => item.text),
  attemptLimit: PUBLIC_CASES.length, retries: 0, minimumGapMs: MINIMUM_GAP_MS,
  isolatedProfile: true, userCookiesOrKeysUsed: false,
  fetchOptions: { credentials: 'omit', redirect: 'error', cache: 'no-store' },
  dnrModifiesOnly: ['Origin', 'Referer'], hostAutomaticallyManaged: true,
  attempts: [], qualified: false, stage: 'create-isolated-fixture',
};
let temporary;
let context;
let cdp;
let observer;
try {
  temporary = await mkdtemp(resolve(output, 'deepl-mv3-equivalence-'));
  const extension = resolve(temporary, 'extension');
  await mkdir(extension);
  await writeFile(resolve(extension, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: 'Near Translate MV3 transport equivalence qualification', version: '0.0.1',
    permissions: ['declarativeNetRequestWithHostAccess'], host_permissions: [HOST_PERMISSION],
    background: { service_worker: 'worker.js' },
  }, null, 2));
  await writeFile(resolve(extension, 'worker.js'), 'chrome.runtime.onInstalled.addListener(() => {});\n');
  report.stage = 'launch-isolated-edge';
  context = await bounded(chromium.launchPersistentContext(resolve(temporary, 'profile'), {
    channel: 'msedge', headless: true, timeout: 15_000,
    ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'],
  }), 20_000);
  report.browser = { channel: 'msedge', version: context.browser().version() };
  assert.match(report.browser.version, /^155\./, 'This qualification requires the reviewed Edge 155 environment.');
  cdp = await bounded(context.browser().newBrowserCDPSession());
  report.browser.protocol = await bounded(cdp.send('Browser.getVersion'));
  const loaded = await bounded(cdp.send('Extensions.loadUnpacked', { path: extension }));
  assert.match(loaded.id, /^[a-p]{32}$/);
  report.extensionId = loaded.id;
  const worker = context.serviceWorkers().find(item => new URL(item.url()).host === loaded.id)
    ?? await context.waitForEvent('serviceworker', { predicate: item => new URL(item.url()).host === loaded.id, timeout: 8_000 });

  report.stage = 'prepare-permissions-and-session-rule';
  report.runtime = await bounded(worker.evaluate(async ({ extensionId, permission, pattern, origin, referer }) => {
    if (chrome.runtime.id !== extensionId) throw new Error('Unexpected extension runtime.');
    const granted = await chrome.permissions.contains({ permissions: ['declarativeNetRequestWithHostAccess'], origins: [permission] });
    if (!granted || !chrome.declarativeNetRequest?.updateSessionRules) throw new Error('Required DNR and host permissions are unavailable.');
    const supported = await chrome.declarativeNetRequest.isRegexSupported({ regex: pattern, isCaseSensitive: true });
    if (!supported.isSupported) throw new Error('Exact endpoint regex is unsupported.');
    const rule = {
      id: 1, priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [
        { header: 'Origin', operation: 'set', value: origin },
        { header: 'Referer', operation: 'set', value: referer },
      ] },
      condition: { initiatorDomains: [extensionId], requestMethods: ['post'], resourceTypes: ['xmlhttprequest'], regexFilter: pattern, isUrlFilterCaseSensitive: true },
    };
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [rule.id], addRules: [rule] });
    return { granted, manifest: chrome.runtime.getManifest(), sessionRules: await chrome.declarativeNetRequest.getSessionRules(), nativeFetch: /\[native code\]/.test(Function.prototype.toString.call(globalThis.fetch)) };
  }, { extensionId: loaded.id, permission: HOST_PERMISSION, pattern: ENDPOINT_PATTERN, origin: ORIGIN, referer: REFERER }));
  assert.equal(report.runtime.granted, true);
  assert.equal(report.runtime.nativeFetch, true);
  assert.deepEqual(report.runtime.manifest.permissions, ['declarativeNetRequestWithHostAccess']);
  assert.deepEqual(report.runtime.manifest.host_permissions, [HOST_PERMISSION]);
  assert.equal(report.runtime.sessionRules.length, 1);
  const [rule] = report.runtime.sessionRules;
  assert.equal(rule.action.type, 'modifyHeaders');
  assert.deepEqual(rule.action.requestHeaders.map(header => ({ ...header, header: header.header.toLowerCase() })), [
    { header: 'origin', operation: 'set', value: ORIGIN }, { header: 'referer', operation: 'set', value: REFERER },
  ]);
  assert.deepEqual(rule.condition.initiatorDomains, [loaded.id]);
  assert.deepEqual(rule.condition.requestMethods, ['post']);
  assert.deepEqual(rule.condition.resourceTypes, ['xmlhttprequest']);
  assert.equal(rule.condition.regexFilter, ENDPOINT_PATTERN);
  assert.equal(rule.condition.isUrlFilterCaseSensitive, true);

  report.stage = 'prepare-passive-wire-capture';
  observer = createWireObserver(cdp, loaded.id);
  await bounded(observer.start());
  let previousFinishedAt = 0;
  for (let index = 0; index < PUBLIC_CASES.length; index++) {
    if (previousFinishedAt) await delay(Math.max(0, MINIMUM_GAP_MS - (Date.now() - previousFinishedAt)));
    assert(Date.now() + REQUEST_TIMEOUT_MS + WIRE_TIMEOUT_MS < deadline, 'Insufficient time for another bounded request.');
    report.stage = PUBLIC_CASES[index].stage;
    const request = encodeRequest(PUBLIC_CASES[index].text);
    const attempt = { index, stage: report.stage, sourceText: PUBLIC_CASES[index].text, request, passed: false };
    report.attempts.push(attempt);
    attempt.observation = await bounded(worker.evaluate(async ({ endpoint, body, timeout }) => {
      const startedAt = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await globalThis.fetch(endpoint, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
          credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal,
        });
        const responseText = await response.text();
        return { startedAt, finishedAt: Date.now(), status: response.status, responseText, retryAfter: response.headers.get('retry-after') };
      } catch (error) {
        return { startedAt, finishedAt: Date.now(), status: null, errorName: error.name, errorMessage: error.message };
      } finally { clearTimeout(timer); }
    }, { endpoint: ENDPOINT, body: request.body, timeout: REQUEST_TIMEOUT_MS }), REQUEST_TIMEOUT_MS + 2_000);
    previousFinishedAt = attempt.observation.finishedAt;
    attempt.gapAfterPreviousCompletionMs = index ? attempt.observation.startedAt - report.attempts[index - 1].observation.finishedAt : null;
    if (index) assert(attempt.gapAfterPreviousCompletionMs >= MINIMUM_GAP_MS, 'Requests were not separated by the required completion gap.');
    // Collect failure evidence too; a non-200 never advances to another case.
    attempt.networkRecord = await observer.completion(index + 1).catch(error => {
      attempt.captureError = error.message;
      return null;
    });
    attempt.translation = validateResult(attempt.observation, attempt.networkRecord, request);
    attempt.passed = true;
  }
  assert.equal(observer.errors.length, 0, 'Unexpected passive observer error.');
  assert.equal(observer.snapshot().length, PUBLIC_CASES.length, 'Unexpected actual translation request count.');
  assert.deepEqual(report.attempts.map(item => item.networkRecord.request.postData), report.attempts.map(item => item.request.body));
  report.translationsInSourceOrder = report.attempts.map(item => item.translation);
  report.qualified = report.attempts.length === 3 && report.attempts.every(item => item.passed);
  report.stage = 'complete';
} catch (error) {
  process.exitCode = 1;
  report.failure = { stage: report.stage, name: error.name, message: error.message };
} finally {
  report.wireRecords = observer?.snapshot() ?? [];
  report.observerErrors = observer?.errors ?? [];
  const cleanupErrors = [];
  await observer?.stop().catch(error => cleanupErrors.push(error.message));
  await cdp?.detach().catch(error => cleanupErrors.push(error.message));
  let closed = !context;
  if (context) {
    await bounded(context.close(), 8_000).then(() => { closed = true; }).catch(error => cleanupErrors.push(error.message));
  }
  if (temporary && closed) {
    try {
      const canonical = await realpath(temporary);
      const leaf = relative(output, canonical);
      assert(inside(output, canonical) && leaf.startsWith('deepl-mv3-equivalence-') && !leaf.includes(sep), 'Refuse cleanup outside the isolated probe directory.');
      await rm(canonical, { recursive: true, force: true });
    } catch (error) { cleanupErrors.push(error.message); }
  }
  report.cleanup = { browserClosed: closed, errors: cleanupErrors };
  if (cleanupErrors.length) { report.qualified = false; process.exitCode = 1; }
  report.generatedAt = new Date().toISOString();
  await mkdir(dirname(evidencePath), { recursive: true });
  assert(inside(workspace, await realpath(dirname(evidencePath))), 'Evidence path escaped the workspace.');
  await writeFile(evidencePath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ evidencePath, qualified: report.qualified, attempts: report.attempts.length, statuses: report.attempts.map(item => item.observation?.status ?? null), failure: report.failure ?? null, cleanup: report.cleanup }, null, 2));
}
