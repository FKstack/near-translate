// Browser-mechanism experiment only. No real account, Cookie, API or translation.
// Uses a fresh Edge profile, a loopback HTTP fixture, and native browser fetch.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const workspace = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
const output = resolve(workspace, '.output');
await mkdir(output, { recursive: true });
assert.equal(relative(workspace, await realpath(output)), '.output');
const runDirectory = await mkdtemp(resolve(output, 'session-feasibility-'));
const manifestBefore = await readFile(resolve(workspace, 'wxt.config.ts'), 'utf8');
const fixtureSession = randomBytes(16).toString('hex');
const checks = [];
const observations = {};
const contexts = [];
function check(name, actual, expected) {
  checks.push({ name, passed: JSON.stringify(actual) === JSON.stringify(expected), actual, expected });
}
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://127.0.0.1').pathname;
  const authenticated = (request.headers.cookie || '').split('; ')
    .includes(`near_lab_session=${fixtureSession}`);
  const send = (status, payload) => {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify(payload));
  };
  if (path === '/login') {
    response.setHeader('set-cookie', `near_lab_session=${fixtureSession}; HttpOnly; SameSite=Strict; Path=/`);
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><title>Isolated session fixture</title><p>Local test only.</p>');
  } else if (path === '/logout') {
    response.setHeader('set-cookie', 'near_lab_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    send(200, { loggedOut: true });
  } else if (path === '/session') {
    send(authenticated ? 200 : 401, { authenticated });
  } else if (path === '/requires-bearer') {
    // This is NOT an emulation of any real provider's private protocol.
    send(401, { cookiePresent: authenticated, required: 'separate-fixture-bearer' });
  } else if (path === '/requires-csrf') {
    const accepted = authenticated && request.headers['x-fixture-csrf'] === 'public-fixture-csrf';
    send(accepted ? 200 : 403, { cookiePresent: authenticated, accepted });
  } else if (path === '/slow') {
    const timer = setTimeout(() => send(200, { completed: true }), 2000);
    response.once('close', () => clearTimeout(timer));
  } else {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><title>Local probe</title><p>Public fixture page.</p>');
  }
});
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
const origin = `http://127.0.0.1:${server.address().port}`;

async function launch(profileName) {
  const context = await chromium.launchPersistentContext(resolve(runDirectory, profileName), {
    channel: 'msedge', headless: true, timeout: 15000,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging', '--disable-background-networking'],
  });
  contexts.push(context);
  return context;
}
async function extension(context, name, cookiePermission, hostPermission) {
  const extensionDirectory = resolve(runDirectory, name);
  await mkdir(extensionDirectory);
  await writeFile(resolve(extensionDirectory, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name, version: '0.0.1',
    permissions: cookiePermission ? ['cookies'] : [],
    host_permissions: hostPermission ? ['http://127.0.0.1/*'] : [],
    background: { service_worker: 'worker.js' },
  }));
  await writeFile(resolve(extensionDirectory, 'worker.js'), 'chrome.runtime.onInstalled.addListener(() => {});');
  const session = await context.browser().newBrowserCDPSession();
  let loaded;
  try { loaded = await session.send('Extensions.loadUnpacked', { path: extensionDirectory }); }
  finally { await session.detach(); }
  const worker = context.serviceWorkers().find(value => new URL(value.url()).host === loaded.id)
    ?? await context.waitForEvent('serviceworker', {
      predicate: value => new URL(value.url()).host === loaded.id, timeout: 8000,
    });
  return worker;
}
async function request(worker, path, credentials = 'include', headers = {}) {
  return worker.evaluate(async ({ url, credentials, headers }) => {
    const response = await globalThis.fetch(url, { credentials, headers, signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.json() };
  }, { url: origin + path, credentials, headers });
}

let fatal;
try {
  const context = await launch('profile-a');
  observations.browser = context.browser().version();
  const fetchOnly = await extension(context, 'fetch-without-cookie-read', false, true);
  const native = await fetchOnly.evaluate(() => /\[native code\]/.test(Function.prototype.toString.call(globalThis.fetch)));
  check('native-browser-fetch-not-mocked', native, true);
  check('no-session-before-fixture-login', (await request(fetchOnly, '/session')).status, 401);

  const page = await context.newPage();
  await page.goto(origin + '/login');
  check('httponly-cookie-hidden-from-document-cookie',
    await page.evaluate(() => document.cookie.includes('near_lab_session=')), false);
  check('cookie-api-unavailable-without-cookie-permission',
    await fetchOnly.evaluate(() => typeof chrome.cookies), 'undefined');
  check('credentials-omit-does-not-send-session', (await request(fetchOnly, '/session', 'omit')).status, 401);
  check('credentials-include-reuses-fixture-session-without-reading-cookie',
    (await request(fetchOnly, '/session')).status, 200);

  const cookieReader = await extension(context, 'scoped-cookie-metadata', true, true);
  const metadata = await cookieReader.evaluate(async url => {
    const cookie = await chrome.cookies.get({ url, name: 'near_lab_session' });
    return { exists: !!cookie, httpOnly: cookie?.httpOnly, sameSite: cookie?.sameSite };
  }, origin);
  check('cookie-api-can-read-httponly-with-scoped-permission', metadata,
    { exists: true, httpOnly: true, sameSite: 'strict' });
  const noHost = await extension(context, 'cookie-permission-without-host', true, false);
  const unavailable = await noHost.evaluate(async url => {
    try { return !await chrome.cookies.get({ url, name: 'near_lab_session' }); }
    catch { return true; }
  }, origin);
  check('cookie-read-needs-host-permission-too', unavailable, true);

  const differentAuth = await request(fetchOnly, '/requires-bearer');
  check('cookie-auth-does-not-satisfy-separate-fixture-bearer',
    { status: differentAuth.status, cookiePresent: differentAuth.body.cookiePresent },
    { status: 401, cookiePresent: true });
  check('session-alone-does-not-satisfy-fixture-csrf',
    (await request(fetchOnly, '/requires-csrf')).status, 403);
  check('fixture-session-and-explicit-csrf-together-work',
    (await request(fetchOnly, '/requires-csrf', 'include', { 'x-fixture-csrf': 'public-fixture-csrf' })).status, 200);
  check('service-worker-has-no-localStorage', await fetchOnly.evaluate(() => typeof localStorage), 'undefined');

  const cancellation = await fetchOnly.evaluate(async url => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 50);
    try { await globalThis.fetch(url, { signal: controller.signal, credentials: 'include' }); return 'not-aborted'; }
    catch (error) { return error.name; }
    finally { clearTimeout(timer); }
  }, origin + '/slow');
  check('native-fetch-cancellation', cancellation, 'AbortError');

  const otherContext = await launch('profile-b');
  const otherWorker = await extension(otherContext, 'other-profile-fetch', false, true);
  check('different-profile-does-not-share-login', (await request(otherWorker, '/session')).status, 401);
  await page.goto(origin + '/logout');
  check('logout-removes-session-for-subsequent-fetch', (await request(fetchOnly, '/session')).status, 401);

  observations.builtinTranslator = await page.evaluate(async () => {
    if (!('Translator' in globalThis)) return { exposed: false, translated: false };
    try {
      const availability = await Promise.race([
        Translator.availability({ sourceLanguage: 'en', targetLanguage: 'zh' }),
        new Promise(resolveTimeout => setTimeout(() => resolveTimeout('probe-timeout'), 5000)),
      ]);
      // Do not download models or misrepresent availability as a translation test.
      return { exposed: true, availability, translated: false };
    } catch (error) { return { exposed: true, errorName: error.name, translated: false }; }
  });
  check('production-manifest-source-unchanged',
    await readFile(resolve(workspace, 'wxt.config.ts'), 'utf8') === manifestBefore, true);
} catch (error) {
  fatal = { name: error.name, message: String(error.message).slice(0, 500) };
} finally {
  for (const context of contexts.reverse()) await context.close().catch(() => {});
  server.closeAllConnections();
  await new Promise(resolveClose => server.close(resolveClose));
  // Only this run's generated directory; resolve and verify before recursive removal.
  const resolvedRun = await realpath(runDirectory);
  const resolvedOutput = await realpath(output);
  const child = relative(resolvedOutput, resolvedRun);
  assert(child.startsWith('session-feasibility-') && !child.includes(sep) && !child.startsWith('..'));
  await rm(resolvedRun, { recursive: true, force: true });
}

const result = {
  generatedAt: new Date().toISOString(), scope: 'isolated-native-browser-and-loopback-fixture-only',
  realUserProfileAccessed: false, realProviderTranslationTested: false,
  rawCookieValuesInReport: false, temporaryProfileRemoved: true,
  passed: checks.filter(item => item.passed).length, total: checks.length,
  checks, observations, ...(fatal ? { fatal } : {}),
};
const evidenceDirectory = resolve(workspace, 'docs/evidence');
await mkdir(evidenceDirectory, { recursive: true });
await writeFile(resolve(evidenceDirectory, 'session-translation-browser-probe-2026-10-21.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
if (fatal || checks.some(item => !item.passed)) process.exitCode = 1;
