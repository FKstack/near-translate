import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { realpath, writeFile, unlink, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';

// Public, fixed sample only. Credentials stay behind the production Port API.
async function runPublicProbe(config) {
  const page = await chrome.tabs.getCurrent();
  const report = async data => {
    document.getElementById('result').textContent = JSON.stringify(data, null, 2);
    await fetch(config.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  };
  if (new URL(location.href).searchParams.has('reload')) {
    await report({ phase: 'reloading', version: chrome.runtime.getManifest().version });
    chrome.runtime.reload(); return;
  }
  const timed = (promise, ms) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('deadline')), ms))]);
  const settings = await timed(chrome.runtime.sendMessage({ type: 'get-settings' }), 10000);
  const state = { version: chrome.runtime.getManifest().version, translationEngine: settings.translationEngine || 'model',
    provider: settings.provider || 'deepseek', model: settings.model, enabled: settings.enabled, hasApiKey: settings.hasApiKey,
    apiAccess: settings.apiAccess, webAccess: settings.webAccess, includeContext: settings.includeContext };
  await report({ phase: 'settings', ...state });
  if (state.translationEngine !== 'model' || state.provider !== 'deepseek' || !state.enabled || !state.hasApiKey || state.apiAccess === false) {
    await report({ phase: 'skipped', ...state }); return;
  }
  const sentence = 'Go is efficient, scalable, and productive.';
  async function measure(kind) {
    return await new Promise(resolve => {
      const port = chrome.runtime.connect({ name: 'near-translate:v1' });
      const requestId = 'public-speed-' + kind + '-' + Date.now();
      const started = performance.now();
      const row = { phase: 'measurement', ...state, kind, sampleChars: kind === 'word' ? 8 : sentence.length };
      const preview = {};
      let settled = false;
      const finish = outcome => {
        if (settled) return;
        settled = true; clearTimeout(timer); clearInterval(heartbeat);
        try { port.postMessage({ type: 'cancel', requestId }); port.disconnect(); } catch {}
        resolve({ ...row, outcome, totalMs: Math.round((performance.now() - started) * 1000) / 1000 });
      };
      const timer = setTimeout(() => finish('timeout'), 65000);
      const heartbeat = setInterval(() => { try { port.postMessage({ type: 'heartbeat', requestId }); } catch {} }, 15000);
      port.onDisconnect.addListener(() => finish('disconnected'));
      port.onMessage.addListener(message => {
        if (message.requestId !== requestId || settled) return;
        const elapsed = Math.round((performance.now() - started) * 1000) / 1000;
        if (message.type === 'started') row.startedMs = elapsed;
        if (message.type === 'progress' && row.progressMs === undefined) row.progressMs = elapsed;
        if (message.type === 'word-preview' && message.preview && typeof message.preview === 'object') {
          for (const key of ['translation', 'partOfSpeech', 'explanation']) {
            if (typeof message.preview[key] === 'string' && message.preview[key].trim()) preview[key] = message.preview[key];
          }
          if (preview.translation && row.firstPreviewMs === undefined) row.firstPreviewMs = elapsed;
          if (preview.translation && preview.partOfSpeech && preview.explanation && row.contextReadyMs === undefined) row.contextReadyMs = elapsed;
        }
        if (message.type === 'delta' && message.text && row.firstDeltaMs === undefined) row.firstDeltaMs = elapsed;
        if (message.type === 'result') {
          row.resultMs = elapsed; row.translation = message.result?.translation;
          row.senseCount = message.result?.kind === 'word' ? message.result.senses?.length : 0;
          finish('complete');
        }
        if (message.type === 'error') { row.errorCode = message.error?.code; finish('error'); }
      });
      port.postMessage({ type: 'translate', requestId, input: kind === 'word'
        ? { kind: 'word', text: 'scalable', context: sentence }
        : { kind: 'text', text: sentence } });
    });
  }
  for (const kind of config.kinds) {
    const result = await measure(kind);
    await report(result);
    if (result.outcome !== 'complete') break;
  }
  await report({ phase: 'complete', ...state });
  return page?.id;
}

const workspace = await realpath(process.cwd());
assert(process.env.NEAR_INSTALLED_EXTENSION_DIR, 'Set NEAR_INSTALLED_EXTENSION_DIR to the loaded extension directory inside this workspace.');
const installed = await realpath(path.resolve(workspace, process.env.NEAR_INSTALLED_EXTENSION_DIR));
const relative = path.relative(workspace, installed);
assert(relative && !path.isAbsolute(relative) && !relative.startsWith('..'), 'Installation must stay inside workspace.');
const extensionId = process.env.NEAR_INSTALLED_EXTENSION_ID;
assert(typeof extensionId === 'string' && /^[a-p]{32}$/.test(extensionId), 'Set NEAR_INSTALLED_EXTENSION_ID to the browser extension ID.');
const executable = process.env.NEAR_BROWSER_EXECUTABLE;
assert(executable && path.isAbsolute(executable), 'Set NEAR_BROWSER_EXECUTABLE to an absolute browser executable path.');
const profile = process.env.NEAR_BROWSER_PROFILE_DIRECTORY || 'Default';
const args = process.argv.slice(2);
const label = args.includes('--label') ? args[args.indexOf('--label') + 1] : 'baseline';
assert(/^[a-z0-9-]+$/.test(label));
const kinds = args.includes('--word-only') ? ['word'] : ['word', 'text'];
const token = randomBytes(24).toString('hex');
const basename = 'near-public-model-probe-' + token;
const html = path.join(installed, basename + '.html');
const script = path.join(installed, basename + '.js');
const events = [];
let settle;
const done = new Promise(resolve => { settle = resolve; });
function sanitize(data) {
  const strings = { phase: ['reloading', 'settings', 'measurement', 'complete', 'skipped', 'failure'], translationEngine: ['model', 'deepl-web'],
    provider: ['deepseek'], kind: ['word', 'text'], outcome: ['complete', 'error', 'timeout', 'disconnected'],
    errorCode: ['CONFIG', 'AUTH', 'BALANCE', 'RATE_LIMIT', 'NETWORK', 'TIMEOUT', 'INVALID_RESPONSE', 'INVALID_INPUT', 'DISCONNECTED', 'SERVER'] };
  const safe = {};
  for (const [key, allowed] of Object.entries(strings)) if (allowed.includes(data[key])) safe[key] = data[key];
  for (const key of ['enabled', 'hasApiKey', 'apiAccess', 'webAccess', 'includeContext']) if (typeof data[key] === 'boolean') safe[key] = data[key];
  for (const key of ['sampleChars', 'startedMs', 'progressMs', 'firstPreviewMs', 'contextReadyMs', 'firstDeltaMs', 'resultMs', 'totalMs', 'senseCount'])
    if (typeof data[key] === 'number' && Number.isFinite(data[key]) && data[key] >= 0) safe[key] = data[key];
  if (typeof data.version === 'string' && /^\d+(?:\.\d+){1,3}$/.test(data.version)) safe.version = data.version;
  if (typeof data.model === 'string' && /^[a-zA-Z0-9._:/-]{1,100}$/.test(data.model)) safe.model = data.model;
  if (typeof data.translation === 'string') safe.translation = data.translation.slice(0, 300);
  return safe;
}
const server = createServer(async (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', 'chrome-extension://' + extensionId);
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Private-Network', 'true');
  if (request.url !== '/' + token) { response.writeHead(404).end(); return; }
  if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
  if (request.method !== 'POST') { response.writeHead(405).end(); return; }
  let body = '';
  for await (const bytes of request) { body += bytes; if (body.length > 10000) { response.writeHead(413).end(); return; } }
  try {
    const event = sanitize(JSON.parse(body)); events.push(event);
    console.log(JSON.stringify(event)); response.writeHead(200).end('ok');
    if (['complete', 'skipped', 'failure'].includes(event.phase)) settle(event);
  } catch { response.writeHead(400).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let deadline;
try {
  const endpoint = 'http://127.0.0.1:' + server.address().port + '/' + token;
  await writeFile(html, '<!doctype html><meta charset="utf-8"><title>近译 · 公开模型速度诊断</title><p>只翻译公开 Go 例句，密钥留在扩展内部。</p><pre id="result"></pre><script src="' + basename + '.js"></script>');
  const wrapper = `(${runPublicProbe.toString()})(${JSON.stringify({ endpoint, kinds })}).catch(async () => { try { await fetch(${JSON.stringify(endpoint)}, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phase:'failure'})}); } catch {} }).finally(async () => { try { const tab = await chrome.tabs.getCurrent(); if (tab?.id) await chrome.tabs.remove(tab.id); } catch {} });`;
  await writeFile(script, wrapper);
  const open = query => {
    const child = spawn(executable, ['--profile-directory=' + profile, 'chrome-extension://' + extensionId + '/' + basename + '.html' + query], { windowsHide: true, stdio: 'ignore' });
    child.unref();
  };
  if (args.includes('--reload')) {
    open('?reload=1'); await new Promise(resolve => setTimeout(resolve, 1800));
  }
  open('');
  deadline = setTimeout(() => settle({ phase: 'harness-timeout' }), 150000);
  const result = await done;
  await mkdir(path.join(workspace, '.output'), { recursive: true });
  const evidence = path.join(workspace, '.output', 'installed-model-' + label + '-' + Date.now() + '.json');
  await writeFile(evidence, JSON.stringify({ label, publicSample: 'Go is efficient, scalable, and productive.', events, result }, null, 2) + '\n');
  console.log(JSON.stringify({ evidence }));
} finally {
  clearTimeout(deadline); await new Promise(resolve => server.close(resolve));
  await Promise.all([unlink(html).catch(() => {}), unlink(script).catch(() => {})]);
}
