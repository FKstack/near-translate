import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const { version: EXPECTED_VERSION } = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
const CHECKS = ['runtimeVersion', 'publicSettingsReadable', 'readingPreferencesReadable', 'ownedFixtureOnly', 'contentReady',
  'readerReady', 'paragraphsPreserved', 'codePreserved', 'presetsVisibleEnabled', 'themesVisibleEnabled', 'selectedThemeMatches',
  'fontSizeMatches', 'advancedDetailsOpened', 'advancedControlsVisibleEnabled', 'personalControlsVisibleEnabled',
  'applyPersonalMatchesPresence', 'importExportVisibleEnabled', 'fileInputConfigured', 'saveStatusVisible', 'saveStatusIdle',
  'translationIdle', 'translationControlsInHeader', 'noArticleToolbar', 'toolsVisibleAfterScroll',
  'preferencesUnchanged', 'ownedTabClosed'];
const REASONS = ['none', 'version', 'public-settings', 'reading-preferences', 'fixture-create', 'fixture-load', 'fixture-scope',
  'content-open', 'dom-check', 'preference-check', 'tab-cleanup', 'harness-timeout', 'cleanup'];

// Content-free allowlist only. Never pass public model settings or raw storage to evidence.
export function safeReadingPreferences(input, styleOnly = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const safe = {};
  const choices = { theme: ['paper', 'sepia', 'dark', 'system', 'contrast', 'custom'],
    width: ['narrow', 'comfortable', 'wide', 'custom'], fontFamily: ['serif', 'sans'], textAlign: ['start', 'justify'],
    translationStyle: ['line', 'card', 'plain'] };
  for (const [key, allowed] of Object.entries(choices)) if (allowed.includes(input[key])) safe[key] = input[key];
  const ranges = { fontSize: [14, 36], lineHeight: [1.4, 2.4], columnWidth: [480, 1080], letterSpacing: [0, .12],
    wordSpacing: [0, .2], paragraphSpacing: [.6, 2], translationScale: [.8, 1.2] };
  for (const [key, [min, max]] of Object.entries(ranges))
    if (typeof input[key] === 'number' && Number.isFinite(input[key]) && input[key] >= min && input[key] <= max) safe[key] = input[key];
  for (const key of ['focus', 'codeWrap']) if (typeof input[key] === 'boolean') safe[key] = input[key];
  if (input.colors && typeof input.colors === 'object') {
    safe.colors = {};
    for (const key of ['background', 'text', 'accent'])
      if (typeof input.colors[key] === 'string' && /^#[a-f\d]{6}$/i.test(input.colors[key])) safe.colors[key] = input.colors[key].toLowerCase();
  }
  if (!styleOnly) {
    if (['original', 'bilingual', 'translation'].includes(input.mode)) safe.mode = input.mode;
    safe.savedStyle = input.savedStyle === null ? null : safeReadingPreferences(input.savedStyle, true);
  }
  return safe;
}

export function safeInstalledEvent(input) {
  if (!input || typeof input !== 'object') return {};
  const safe = {};
  if (['reloading', 'complete', 'failure', 'cleanup'].includes(input.phase)) safe.phase = input.phase;
  if (['passed', 'failed', 'shown', 'cleanup'].includes(input.outcome)) safe.outcome = input.outcome;
  if (REASONS.includes(input.reason)) safe.reason = input.reason;
  if (typeof input.version === 'string' && /^\d+(?:\.\d+){1,3}$/.test(input.version)) safe.version = input.version;
  if (input.checks && typeof input.checks === 'object') safe.checks = Object.fromEntries(CHECKS
    .filter(key => typeof input.checks[key] === 'boolean').map(key => [key, input.checks[key]]));
  if (input.numbers && typeof input.numbers === 'object') safe.numbers = Object.fromEntries(
    ['paragraphCount', 'codeBlockCount', 'presetCount', 'themeCount', 'displayedFontSize', 'computedFontSize', 'elapsedMs']
      .filter(key => typeof input.numbers[key] === 'number' && Number.isFinite(input.numbers[key]) && input.numbers[key] >= 0 && input.numbers[key] < 1e8)
      .map(key => [key, input.numbers[key]]));
  for (const key of ['preferencesBefore', 'preferencesAfter']) {
    const preferences = safeReadingPreferences(input[key]);
    if (preferences) safe[key] = preferences;
  }
  return safe;
}

// Serialized into the extension helper and then executed ONLY in its newly created exact fixture URL.
async function inspectOwnedReading(config) {
  const scope = () => location.href === config.fixtureUrl;
  if (!scope()) return { checks: { ownedFixtureOnly: false } };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const wait = async predicate => {
    const deadline = performance.now() + 15000;
    while (scope() && performance.now() < deadline) { if (predicate()) return true; await sleep(100); }
    return false;
  };
  const root = () => document.querySelector('near-reading-mode[data-near-page-ui]')?.shadowRoot;
  const ready = await wait(() => root()?.querySelector('.nr-content article')
    && Number(root()?.querySelector('input[aria-label="阅读字号"]')?.value) === config.preferences.fontSize);
  if (!scope()) return { checks: { ownedFixtureOnly: false } };
  if (!ready) return { checks: { ownedFixtureOnly: true, readerReady: false } };
  const shadow = root();
  const reader = shadow.querySelector('.nr-reader');
  const panel = shadow.querySelector('.nr-settings');
  const visible = element => {
    if (!element?.isConnected) return false;
    const rect = element.getBoundingClientRect(); const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const enabled = element => !!element && !element.disabled && !element.closest('[inert]');
  const button = label => [...shadow.querySelectorAll('button')]
    .find(element => element.getAttribute('aria-label') === label || element.textContent.trim() === label);
  const header = shadow.querySelector('.nr-header');
  const tools = header?.querySelector('[role="group"][aria-label="阅读翻译工具"]');
  const modes = tools?.querySelector('[role="group"][aria-label="正文显示模式"]');
  const primary = tools?.querySelector('.nr-translate-button');
  const modeButtons = [...modes?.querySelectorAll('button') ?? []];
  const modeNames = ['original', 'bilingual', 'translation'];
  const expectedModes = ['原文', '双语', '仅译文'];
  const controlsVisible = () => [tools, modes, primary, ...modeButtons].every(element => {
    if (!visible(element) || !header?.contains(element)) return false;
    const rect = element.getBoundingClientRect(); const bounds = reader.getBoundingClientRect();
    return rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1
      && rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1;
  });
  const translationControlsInHeader = !!tools && !!modes && !!primary && modeButtons.length === 3
    && modeButtons.every((element, index) => element.textContent.trim() === expectedModes[index]
      && element.getAttribute('aria-pressed') === String(modeNames[index] === config.preferences.mode))
    && controlsVisible();
  const noArticleToolbar = !shadow.querySelector('.nr-paper .nr-reading-tools');
  const articleScroll = shadow.querySelector('.nr-scroll');
  let toolsVisibleAfterScroll = false;
  if (scope() && articleScroll) {
    const originalScroll = articleScroll.scrollTop;
    try {
      articleScroll.scrollTo({ top: (articleScroll.scrollHeight - articleScroll.clientHeight) / 2, behavior: 'instant' });
      await sleep(100);
      toolsVisibleAfterScroll = scope() && articleScroll.scrollTop > 0 && controlsVisible();
    } finally {
      if (scope()) articleScroll.scrollTo({ top: originalScroll, behavior: 'instant' });
    }
  }
  // Drawer and details state is local UI only; these clicks do not invoke onPreferences.
  if (!visible(panel)) {
    const trigger = [...shadow.querySelectorAll('button[aria-label="显示设置"]')].find(visible);
    if (trigger && scope()) { trigger.click(); await sleep(100); }
  }
  const inspectControl = element => {
    if (!scope() || !element) return false;
    element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    return visible(element) && enabled(element);
  };
  const presets = [...shadow.querySelectorAll('.nr-preset')];
  const themes = [...shadow.querySelectorAll('.nr-theme')];
  const presetsOK = presets.length === 3 && ['longform', 'technical', 'night']
    .every(id => inspectControl(presets.find(element => element.dataset.preset === id)));
  const themeLabels = ['跟随系统主题', '纸白主题', '暖纸主题', '深色主题', '高对比主题', '自定义主题'];
  const themesOK = themes.length === 6 && themeLabels.every(label => inspectControl(button(label)));
  const advanced = shadow.querySelector('details.nr-advanced-settings');
  if (advanced && !advanced.open && scope()) { advanced.querySelector('summary')?.click(); await sleep(100); }
  const advancedControls = ['阅读自定义栏宽', '阅读字间距', '阅读词间距', '阅读段落间距', '阅读译文字号比例']
    .every(label => inspectControl(shadow.querySelector('input[aria-label="' + label + '"]')))
    && ['左侧对齐', '两端对齐', '代码自动换行', '边线对照', '卡片对照', '简洁对照'].every(label => inspectControl(button(label)));
  const personalSave = button('保存为我的样式'); const personalApply = button('应用我的样式');
  const personalOK = inspectControl(personalSave) && !!personalApply && visible(personalApply);
  const importExportOK = ['导出版式', '导入版式'].every(label => inspectControl(button(label)));
  const fileInput = shadow.querySelector('input[aria-label="导入阅读版式文件"]');
  const status = shadow.querySelector('.nr-save-status');
  if (status && scope()) status.scrollIntoView({ block: 'center', behavior: 'instant' });
  const statusVisible = visible(status) && visible(status?.querySelector('[role="status"]'));
  const input = shadow.querySelector('input[aria-label="阅读字号"]');
  const displayedFontSize = Number(input?.value); const computedFontSize = parseFloat(getComputedStyle(shadow.querySelector('.nr-content')).fontSize);
  const selected = themes.find(element => element.getAttribute('aria-pressed') === 'true')?.querySelector('[data-theme]')?.getAttribute('data-theme');
  const result = { checks: { ownedFixtureOnly: scope(), readerReady: !!shadow.querySelector('dialog[open][aria-label="近译阅读模式"]'),
    paragraphsPreserved: shadow.querySelectorAll('.nr-content p').length === 20, codePreserved: shadow.querySelectorAll('.nr-content pre code').length === 1,
    presetsVisibleEnabled: presetsOK, themesVisibleEnabled: themesOK, selectedThemeMatches: selected === config.preferences.theme,
    fontSizeMatches: displayedFontSize === config.preferences.fontSize && computedFontSize === config.preferences.fontSize
      && input?.getAttribute('aria-valuetext') === config.preferences.fontSize + ' 像素',
    advancedDetailsOpened: !!advanced?.open, advancedControlsVisibleEnabled: advancedControls, personalControlsVisibleEnabled: personalOK,
    applyPersonalMatchesPresence: !!personalApply && personalApply.disabled === !config.preferences.savedStyle,
    importExportVisibleEnabled: importExportOK, fileInputConfigured: !!fileInput?.hidden && fileInput.type === 'file' && fileInput.accept === '.json,application/json',
    saveStatusVisible: statusVisible, saveStatusIdle: status?.getAttribute('data-status') === 'idle', translationIdle: reader?.getAttribute('data-status') === 'idle',
    translationControlsInHeader, noArticleToolbar, toolsVisibleAfterScroll },
    numbers: { paragraphCount: shadow.querySelectorAll('.nr-content p').length, codeBlockCount: shadow.querySelectorAll('.nr-content pre code').length,
      presetCount: presets.length, themeCount: themes.length, displayedFontSize, computedFontSize } };
  // Leave --show at the beginning of the settings panel; do not change stored appearance.
  if (scope() && panel) panel.scrollTop = 0;
  return result;
}

async function runInstalledReadingCheck(config) {
  const started = performance.now();
  const helper = await chrome.tabs.getCurrent();
  if (!helper?.id || ![config.helperUrl, config.helperUrl + '?reload=1', config.helperUrl + '?cleanup=1'].includes(location.href)) return;
  const report = async event => {
    const safe = safeInstalledEvent(event);
    document.getElementById('result').textContent = JSON.stringify(safe, null, 2);
    await fetch(config.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(safe) });
  };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const timed = (promise, ms = 10000) => Promise.race([promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('deadline')), ms))]);
  if (new URL(location.href).searchParams.has('reload')) {
    await report({ phase: 'reloading', version: chrome.runtime.getManifest().version });
    chrome.runtime.reload(); return;
  }
  let ownedId; let reason = 'none'; let succeeded = false;
  const checks = {}; const numbers = {}; let before; let after;
  const assertScope = async () => {
    const tab = await chrome.tabs.get(ownedId);
    if (tab.id !== ownedId || tab.url !== config.fixtureUrl) throw new Error('scope');
    return tab;
  };
  const removeOwned = async () => {
    if (!Number.isInteger(ownedId)) return true;
    const tab = await chrome.tabs.get(ownedId).catch(() => undefined);
    if (!tab) return true;
    if (tab.url !== config.fixtureUrl) return false;
    await chrome.tabs.remove(ownedId); return true;
  };
  try {
    // Query only this run's unique helper URL; never inventory or inspect unrelated tabs.
    const helpers = await chrome.tabs.query({ url: config.helperUrl + '*' });
    for (const tab of helpers) if (tab.id !== helper.id && [config.helperUrl, config.helperUrl + '?reload=1', config.helperUrl + '?cleanup=1'].includes(tab.url))
      await chrome.tabs.remove(tab.id);
    if (new URL(location.href).searchParams.has('cleanup')) {
      const fixtures = await chrome.tabs.query({ url: config.fixtureUrl });
      for (const tab of fixtures) if (tab.url === config.fixtureUrl) await chrome.tabs.remove(tab.id);
      await report({ phase: 'cleanup', outcome: 'cleanup', reason: 'cleanup' }); return;
    }
    reason = 'version'; checks.runtimeVersion = chrome.runtime.getManifest().version === config.expectedVersion;
    if (!checks.runtimeVersion) throw new Error('version');
    reason = 'public-settings';
    // Merely verify the existing public RPC is available. Do not inspect or retain model fields.
    checks.publicSettingsReadable = typeof await timed(chrome.runtime.sendMessage({ type: 'get-settings' })) === 'object';
    if (!checks.publicSettingsReadable) throw new Error('public-settings');
    reason = 'reading-preferences';
    const preferences = await timed(chrome.runtime.sendMessage({ type: 'get-reading-preferences' }));
    before = safeReadingPreferences(preferences?.preferences);
    checks.readingPreferencesReadable = preferences?.ok === true && typeof before?.fontSize === 'number';
    if (!checks.readingPreferencesReadable) throw new Error('reading-preferences');
    reason = 'fixture-create';
    const owned = await chrome.tabs.create({ url: config.fixtureUrl, active: true }); ownedId = owned.id;
    if (!Number.isInteger(ownedId)) throw new Error('fixture-create');
    reason = 'fixture-load'; let loaded = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const tab = await chrome.tabs.get(ownedId);
      if (tab.url && tab.url !== config.fixtureUrl && tab.url !== 'about:blank') { reason = 'fixture-scope'; throw new Error('scope'); }
      if (tab.url === config.fixtureUrl && tab.status === 'complete') { loaded = true; break; }
      await sleep(100);
    }
    if (!loaded) throw new Error('fixture-load');
    reason = 'content-open'; let opened = false; let injected = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      await assertScope();
      try { opened = (await chrome.tabs.sendMessage(ownedId, { type: 'open-reading-mode' }))?.ok === true; } catch {}
      if (opened) break;
      if (attempt === 5 && !injected) {
        await assertScope();
        await chrome.scripting.executeScript({ target: { tabId: ownedId }, files: ['content-scripts/selection.js'] }); injected = true;
      }
      await sleep(150);
    }
    checks.contentReady = opened;
    if (!opened) throw new Error('content-open');
    reason = 'dom-check'; await assertScope();
    const rows = await chrome.scripting.executeScript({ target: { tabId: ownedId }, func: inspectOwnedReading,
      args: [{ fixtureUrl: config.fixtureUrl, preferences: before }] });
    const dom = rows[0]?.result;
    Object.assign(checks, dom?.checks); Object.assign(numbers, dom?.numbers);
    reason = 'preference-check';
    const reread = await timed(chrome.runtime.sendMessage({ type: 'get-reading-preferences' }));
    after = safeReadingPreferences(reread?.preferences);
    checks.preferencesUnchanged = reread?.ok === true && JSON.stringify(before) === JSON.stringify(after);
    succeeded = config.checkNames.filter(name => name !== 'ownedTabClosed').every(name => checks[name] === true);
    reason = succeeded ? 'none' : 'dom-check';
  } catch { succeeded = false; }
  finally {
    try {
    if (!new URL(location.href).searchParams.has('cleanup')) {
      try { checks.ownedTabClosed = config.show && succeeded ? false : await removeOwned(); }
      catch { checks.ownedTabClosed = false; succeeded = false; reason = 'tab-cleanup'; }
      if (!config.show && !checks.ownedTabClosed) { succeeded = false; reason = 'tab-cleanup'; }
      numbers.elapsedMs = Math.round(performance.now() - started);
      await report({ phase: succeeded ? 'complete' : 'failure', outcome: succeeded ? config.show ? 'shown' : 'passed' : 'failed',
        reason, version: chrome.runtime.getManifest().version, checks, numbers, preferencesBefore: before, preferencesAfter: after });
    }
    } finally {
      // This is the exact unique helper created by this run, never a preexisting tab.
      await chrome.tabs.remove(helper.id).catch(() => {});
    }
  }
}

function fixtureHtml() {
  const paragraphs = Array.from({ length: 20 }, (_, index) => {
    const heading = index % 5 === 0 ? '<h2>Reading section ' + (index / 5 + 1) + '</h2>' : '';
    const text = index % 2 === 0
      ? 'Reading paragraph ' + (index + 1) + '. A comfortable reading view keeps the original technical explanation intact. Readers can adjust typography without leaving the article, losing their place, or requesting a translation. This is a fixed public sample created only for a local installation check.'
      : '阅读段落 ' + (index + 1) + '。这是安装核验专用的固定中文样例，所有文字均为公开测试内容。阅读模式应保留完整正文、清晰的章节和必要的代码。检查显示设置时不应更改用户原有偏好，不应发送翻译请求，也不应访问其他标签页。';
    return heading + '<p>' + text + '</p>';
  }).join('');
  return '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="author" content="Near Translate"><title>Local reading customization check</title>'
    + '<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{max-width:840px;margin:30px auto;padding:24px;font:18px/1.8 system-ui;color:#263d30;background:#f7f3e9}pre{white-space:pre-wrap;background:#e6ede4;padding:18px}</style>'
    + '<main><article><h1>Local reading customization check</h1>' + paragraphs
    + '<pre><code>const article = { paragraphs: 20, translationRequested: false };\nconsole.log(article.paragraphs);</code></pre></article></main></html>';
}

async function main() {
  const args = process.argv.slice(2);
  assert(args.every(arg => ['--reload', '--show'].includes(arg)), 'Supported options: --reload, --show.');
  const workspace = await realpath(process.cwd());
  assert(process.env.NEAR_INSTALLED_EXTENSION_DIR, 'Set NEAR_INSTALLED_EXTENSION_DIR to the loaded extension directory inside this workspace.');
  const installed = await realpath(path.resolve(workspace, process.env.NEAR_INSTALLED_EXTENSION_DIR));
  const relative = path.relative(workspace, installed);
  assert(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep), 'Installation must stay inside the workspace.');
  const extensionId = process.env.NEAR_INSTALLED_EXTENSION_ID;
  assert(typeof extensionId === 'string' && /^[a-p]{32}$/.test(extensionId), 'Set NEAR_INSTALLED_EXTENSION_ID to the browser extension ID.');
  const executable = process.env.NEAR_BROWSER_EXECUTABLE;
  assert(executable && path.isAbsolute(executable), 'Set NEAR_BROWSER_EXECUTABLE to an absolute browser executable path.');
  const profile = process.env.NEAR_BROWSER_PROFILE_DIRECTORY || 'Default';
  assert.match(profile, /^[a-zA-Z0-9 ._-]{1,100}$/);
  const manifest = JSON.parse(await readFile(path.join(installed, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, EXPECTED_VERSION, 'Install the ' + EXPECTED_VERSION + ' build before running the check.');
  const token = randomBytes(24).toString('hex'); const basename = 'near-reading-customization-check-' + token;
  const html = path.join(installed, basename + '.html'); const script = path.join(installed, basename + '.js');
  const helperUrl = 'chrome-extension://' + extensionId + '/' + basename + '.html';
  const events = []; let settle; let settleCleanup; let timer;
  const done = new Promise(resolve => { settle = resolve; }); const cleaned = new Promise(resolve => { settleCleanup = resolve; });
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (request.url === '/fixture/' + token && request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
      response.end(fixtureHtml()); return;
    }
    response.setHeader('Access-Control-Allow-Origin', 'chrome-extension://' + extensionId);
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type'); response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Private-Network', 'true');
    if (request.url !== '/evidence/' + token) { response.writeHead(404).end(); return; }
    if (request.headers.origin !== 'chrome-extension://' + extensionId) { response.writeHead(403).end(); return; }
    if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
    if (request.method !== 'POST') { response.writeHead(405).end(); return; }
    let body = '';
    for await (const bytes of request) { body += bytes; if (body.length > 16000) { response.writeHead(413).end(); return; } }
    try {
      const event = safeInstalledEvent(JSON.parse(body)); events.push(event);
      response.writeHead(200).end('ok'); console.log(JSON.stringify({ phase: event.phase, outcome: event.outcome, reason: event.reason, checks: event.checks }));
      if (['complete', 'failure'].includes(event.phase)) settle(event);
      if (event.phase === 'cleanup') settleCleanup(event);
    } catch { response.writeHead(400).end(); }
  });
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const config = { endpoint: base + '/evidence/' + token, fixtureUrl: base + '/fixture/' + token, helperUrl,
    expectedVersion: EXPECTED_VERSION, show: args.includes('--show'), checkNames: CHECKS };
  const open = query => {
    const child = spawn(executable, ['--profile-directory=' + profile, helperUrl + query], { windowsHide: true, stdio: 'ignore' }); child.unref();
  };
  try {
    await writeFile(html, '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>近译 · 阅读自定义安装核验</title><h1>阅读自定义安装核验</h1><p>只检查本机固定样例，不修改显示偏好，不请求翻译。</p><pre id="result"></pre><script src="' + basename + '.js"></script></html>', { flag: 'wx' });
    await writeFile(script, 'const safeReadingPreferences=' + safeReadingPreferences.toString() + ';\nconst CHECKS=' + JSON.stringify(CHECKS)
      + ';\nconst REASONS=' + JSON.stringify(REASONS) + ';\nconst safeInstalledEvent=' + safeInstalledEvent.toString()
      + ';\nconst inspectOwnedReading=' + inspectOwnedReading.toString() + ';\n(' + runInstalledReadingCheck.toString() + ')(' + JSON.stringify(config) + ').catch(()=>{});', { flag: 'wx' });
    if (args.includes('--reload')) { open('?reload=1'); await new Promise(resolve => setTimeout(resolve, 1800)); }
    open(''); timer = setTimeout(() => settle({ phase: 'failure', outcome: 'failed', reason: 'harness-timeout' }), 70000);
    const result = await done;
    if (result.reason === 'harness-timeout') {
      open('?cleanup=1'); await Promise.race([cleaned, new Promise(resolve => setTimeout(resolve, 5000))]);
    }
    const evidence = path.join(workspace, 'docs/evidence/installed-reading-v' + EXPECTED_VERSION + '.json');
    await mkdir(path.dirname(evidence), { recursive: true });
    await writeFile(evidence, JSON.stringify({ schemaVersion: 1, expectedVersion: EXPECTED_VERSION,
      safety: { publicFixtureOnly: true, preferenceWrites: false, translationActions: false, keyAccess: false, tabCapture: false },
      events, result }, null, 2) + '\n');
    console.log(JSON.stringify({ evidence }));
    if (result.phase !== 'complete') process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    await new Promise(resolve => { server.close(resolve); for (const socket of sockets) socket.destroy(); });
    await Promise.all([unlink(html).catch(() => {}), unlink(script).catch(() => {})]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await main().catch(error => { console.error(error.message); process.exitCode = 1; });
