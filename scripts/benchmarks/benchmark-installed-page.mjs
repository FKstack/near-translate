import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, unlink, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { runBrowserBenchmark } from './driver.mjs';

// Numeric diagnostics only. Never read credentials, headers, request text or private tabs.
export function normalizeMetrics(value) {
  const source = value?.metrics ?? value;
  if (!source || typeof source !== 'object' || !Number.isSafeInteger(source.requestCount) || source.requestCount < 0) return undefined;
  const count = item => typeof item === 'number' && Number.isFinite(item) && item >= 0 && item <= Number.MAX_SAFE_INTEGER ? item : 0;
  const counts = (items, allowed) => Object.fromEntries(Object.entries(items ?? {})
    .filter(([key, item]) => allowed(key) && typeof item === 'number' && Number.isFinite(item) && item >= 0));
  const rows = (items, limit, withTextCounts) => Array.isArray(items) ? items.slice(-limit)
    .filter(item => item && Number.isSafeInteger(item.sequence) && item.sequence > 0).map(item => ({
    sequence: item.sequence, startedAt: count(item.startedAt),
    ...(withTextCounts ? { textCount: count(item.textCount), charCount: count(item.charCount) } : {}),
    ...(withTextCounts && Number.isSafeInteger(item.maxTextChars) && item.maxTextChars >= 0 && item.maxTextChars <= 1_500
      ? { maxTextChars: item.maxTextChars } : {}),
    ...(typeof item.endedAt === 'number' ? { endedAt: count(item.endedAt) } : {}),
    ...(Number.isInteger(item.status) && item.status >= 100 && item.status <= 599 ? { status: item.status } : {}),
    ...(['NETWORK', 'ABORTED'].includes(item.errorCode) ? { errorCode: item.errorCode } : {}),
    ...(item.networkTiming && typeof item.networkTiming === 'object' ? { networkTiming: {
      ...Object.fromEntries(['dnsMs', 'connectMs', 'tlsMs', 'waitMs', 'downloadMs', 'totalMs']
        .filter(key => typeof item.networkTiming[key] === 'number' && Number.isFinite(item.networkTiming[key]) && item.networkTiming[key] >= 0)
        .map(key => [key, item.networkTiming[key]])),
      ...(['h2', 'h3', 'http/1.1', 'unknown'].includes(item.networkTiming.protocol) ? { protocol: item.networkTiming.protocol } : {}),
    } } : {}),
  })) : [];
  const requests = rows(source.requests, 256, true);
  const preparations = rows(source.preparations, 64, false);
  const rateLimitDiagnostics = Array.isArray(source.rateLimitDiagnostics) ? source.rateLimitDiagnostics.slice(-64)
    .filter(item => item && Number.isFinite(item.at) && item.httpStatus === 429
      && ['json', 'empty', 'non-json', 'truncated', 'timeout', 'read-error', 'aborted'].includes(item.bodyOutcome))
    .map(item => ({ at: count(item.at), httpStatus: 429, bodyOutcome: item.bodyOutcome, bodyCompletedAt: count(item.bodyCompletedAt),
      ...(Number.isSafeInteger(item.rpcErrorCode) ? { rpcErrorCode: item.rpcErrorCode } : {}),
      ...(['rate-limit', 'quota', 'concurrency', 'payload-limit', 'authentication'].includes(item.responseReason)
        ? { responseReason: item.responseReason } : {}),
      ...Object.fromEntries(['rateLimitLimit', 'rateLimitRemaining', 'rateLimitReset']
        .filter(key => Number.isSafeInteger(item[key]) && item[key] >= 0).map(key => [key, item[key]])),
      ...(typeof item.retryAfterMs === 'number' && Number.isFinite(item.retryAfterMs) && item.retryAfterMs >= 0 ? { retryAfterMs: item.retryAfterMs } : {}),
    })) : [];
  return {
    requestCount: source.requestCount, totalTexts: count(source.totalTexts), totalChars: count(source.totalChars),
    activeRequests: count(source.activeRequests), maxConcurrent: count(source.maxConcurrent),
    preparationCount: Number.isSafeInteger(source.preparationCount) && source.preparationCount >= 0 ? source.preparationCount : 0,
    activePreparations: count(source.activePreparations), preparations,
    statusCounts: counts(source.statusCounts, key => /^[1-5]\d\d$/.test(key)),
    errorCounts: counts(source.errorCounts, key => ['NETWORK', 'ABORTED'].includes(key)), requests, rateLimitDiagnostics,
    ...Object.fromEntries(['counterReset', 'requestRowsTruncated', 'preparationCounterReset', 'preparationRowsTruncated']
      .filter(key => typeof source[key] === 'boolean').map(key => [key, source[key]])),
  };
}

export function metricsDelta(before, after) {
  const b = normalizeMetrics(before); const a = normalizeMetrics(after);
  if (!b || !a) throw new Error('后台请求统计不可用，请更新并重新加载扩展。');
  const preparationCounterReset = a.preparationCount < b.preparationCount;
  const counterReset = a.requestCount < b.requestCount || a.totalTexts < b.totalTexts || a.totalChars < b.totalChars || preparationCounterReset;
  const subtract = (left, right) => Object.fromEntries(Object.entries(left).map(([key, value]) => [key, Math.max(0, value - (right[key] ?? 0))]).filter(([, value]) => value > 0));
  const requests = a.requests.filter(item => item.sequence > b.requestCount);
  const carried = new Set(b.preparations.filter(item => item.endedAt === undefined).map(item => item.sequence));
  const newPreparations = a.preparations.filter(item => item.sequence > b.preparationCount);
  // A preparation can start during navigation and finish after the click. Keep
  // that row's original start and final outcome even though its counter is old.
  const preparations = a.preparations.filter(item => item.sequence > b.preparationCount || carried.has(item.sequence));
  const preparationCount = Math.max(0, a.preparationCount - b.preparationCount);
  const preparationRowsTruncated = newPreparations.length < preparationCount || b.activePreparations > carried.size
    || [...carried].some(sequence => !a.preparations.some(item => item.sequence === sequence));
  const timeline = requests.filter(item => item.endedAt !== item.startedAt).flatMap(item => [{ time: item.startedAt, amount: 1 },
    ...(item.endedAt === undefined ? [] : [{ time: item.endedAt, amount: -1 }])]);
  timeline.sort((left, right) => left.time - right.time || left.amount - right.amount);
  let active = 0; let peak = requests.length ? 1 : 0;
  for (const event of timeline) { active = Math.max(0, active + event.amount); peak = Math.max(peak, active); }
  const requestCount = Math.max(0, a.requestCount - b.requestCount);
  const diagnosticKey = item => `${item.at}:${item.bodyCompletedAt}:${item.rpcErrorCode ?? ''}:${item.bodyOutcome}:${item.responseReason ?? ''}:${item.rateLimitLimit ?? ''}:${item.rateLimitRemaining ?? ''}:${item.rateLimitReset ?? ''}`;
  const knownDiagnostics = new Set(b.rateLimitDiagnostics.map(diagnosticKey));
  return {
    requestCount, totalTexts: Math.max(0, a.totalTexts - b.totalTexts), totalChars: Math.max(0, a.totalChars - b.totalChars),
    activeRequests: a.activeRequests, maxConcurrent: a.maxConcurrent > b.maxConcurrent ? a.maxConcurrent : peak,
    preparationCount, activePreparations: a.activePreparations, preparations,
    statusCounts: subtract(a.statusCounts, b.statusCounts), errorCounts: subtract(a.errorCounts, b.errorCounts),
    requests, rateLimitDiagnostics: a.rateLimitDiagnostics.filter(item => !knownDiagnostics.has(diagnosticKey(item))),
    counterReset, requestRowsTruncated: requests.length < requestCount, preparationCounterReset, preparationRowsTruncated,
  };
}

export function classifyBenchmarkSnapshot(state) {
  if (state.errorCode === 'RATE_LIMIT') return 'rate-limit';
  if (state.status === 'stopped') return 'stopped';
  if (state.errorCode && state.status !== 'running') return 'error';
  if (state.status === 'done') {
    if (state.total > 0 && state.completed === state.total && state.failed === 0 && state.pending === 0
      && (state.renderedSegments === undefined || state.renderedSegments === state.completed)) return 'complete';
    return state.total === 0 ? 'empty' : 'incomplete';
  }
  if (state.statusText?.includes('没有找到')) return 'empty';
  return undefined;
}

// Kept as an exported seam for the existing inspect unit tests and helper serialization.
export async function browserMain(config) {
  return runBrowserBenchmark(config, { normalizeMetrics, metricsDelta, classifyBenchmarkSnapshot, assessBenchmarkCompletion });
}

/** A complete DOM state is accepted only after an idle, foreground observation window. */
export function assessBenchmarkCompletion({ snapshot, delta, navigationDelta, atTerminal, observedForMs, pass, cold, expectedSourceSegments, expectedSourceChars }) {
  const lateRequestCount = snapshot?.doneAt == null ? 0 : delta.requests.filter(row => row.startedAt > Math.floor(snapshot.doneAt)).length;
  // atTerminal is cumulative, while delta is relative to the pass's before snapshot.
  const terminalSequence = atTerminal?.requestCount ?? Infinity;
  const afterTerminal = delta.requests.filter(row => row.sequence > terminalSequence).length;
  const preparationMetrics = navigationDelta ?? delta;
  const preparationRows = preparationMetrics.preparations ?? [];
  const latePreparationCount = snapshot?.doneAt == null ? 0 : preparationRows.filter(row => row.startedAt > Math.floor(snapshot.doneAt)).length;
  const postTerminalPreparationCount = preparationRows.filter(row => row.sequence > (atTerminal?.preparationCount ?? Infinity)).length;
  const preClickRequestCount = pass === 'cold' && navigationDelta && Number.isFinite(snapshot?.clickedAt)
    ? navigationDelta.requests.filter(row => row.startedAt < Math.floor(snapshot.clickedAt)).length : 0;
  const cacheOutputMatches = !!cold && !!snapshot?.outputFingerprint
    && snapshot.outputFingerprint === cold.outputFingerprint && snapshot.sourceSegments === cold.sourceSegments
    && snapshot.sourceChars === cold.sourceChars && snapshot.total === cold.total;
  let message;
  if (!snapshot || classifyBenchmarkSnapshot(snapshot) !== 'complete' || snapshot.fullDoneMs == null)
    message = '页面未完成全部原文目标。';
  else if (snapshot.sourceSegments !== snapshot.total || snapshot.renderedSegments !== snapshot.sourceSegments
    || snapshot.sourceChanged || snapshot.mappingConflicts || snapshot.unexpectedTranslations)
    message = '原文身份或完整范围不一致，不能确认全文完成。';
  else if ((expectedSourceSegments !== undefined && snapshot.sourceSegments !== expectedSourceSegments)
    || (expectedSourceChars !== undefined && snapshot.sourceChars !== expectedSourceChars))
    message = '公开文章的完整源范围与预期不一致。';
  else if (!snapshot.visible || !snapshot.focused || snapshot.visibilityFailures)
    message = '测速期间目标页隐藏或失去焦点，首屏时间不可采信。';
  else if (!(snapshot.viewportTargets > 0) || snapshot.viewportCompleted !== snapshot.viewportTargets
    || snapshot.firstVisibleProseDomReadyMs == null || snapshot.firstVisibleProseRafMs == null || snapshot.initialViewportAllDoneMs == null)
    message = '初始合格可见正文及下一可见帧尚未完整观测。';
  else if (observedForMs < 1000) message = '完成后的静默观察不足一秒。';
  else if (delta.counterReset || delta.requestRowsTruncated || delta.preparationRowsTruncated
    || navigationDelta?.counterReset || navigationDelta?.requestRowsTruncated || navigationDelta?.preparationRowsTruncated)
    message = '后台指标重置或记录截断，无法审计本轮网络请求。';
  else if (preClickRequestCount) message = '点击翻译前已经发送正文请求，不能作为本轮冷翻译成绩。';
  else if (delta.activeRequests || lateRequestCount || afterTerminal)
    message = '页面完成后仍有活动或额外翻译请求，本轮受到干扰。';
  else if (Object.values(delta.errorCounts).some(value => value > 0)
    || Object.entries(delta.statusCounts).some(([status, value]) => status !== '200' && value > 0))
    message = '本轮含失败网络请求，不能判为完整成功。';
  else if (preparationMetrics.activePreparations || latePreparationCount || postTerminalPreparationCount)
    message = '页面完成后仍有活动或额外连接准备请求，本轮受到干扰。';
  else if (preparationRows.some(row => row.errorCode || !(row.status >= 200 && row.status < 300)))
    message = '本轮含未成功的连接准备请求，不能判为合格的连接优化。';
  else if (pass === 'cached' && (!cacheOutputMatches || delta.requestCount !== 0
    || (delta.preparationCount ?? 0) !== 0 || (delta.preparations?.length ?? 0) !== 0 || delta.activePreparations))
    message = '缓存覆盖必须包含恢复原文至完成后的观察窗，且零请求、输出一致。';
  else if (pass === 'cold' && (!delta.requestCount || delta.totalChars !== snapshot.sourceChars))
    message = '本轮请求字数没有覆盖完整公开原文，或混入额外请求。';
  return { message, lateRequestCount, postTerminalRequestCount: afterTerminal, cacheOutputMatches,
    latePreparationCount, postTerminalPreparationCount, preClickRequestCount };
}

/** The local evidence sink accepts only explicit public fields and safe metrics. */
export function normalizeBenchmarkEvent(incoming) {
  if (!incoming || typeof incoming !== 'object') return {};
  const keys = ['phase', 'pass', 'version', 'model', 'translationEngine', 'enabled', 'hasApiKey', 'webAccess', 'apiAccess',
    'networkPreparationPermission', 'cooldownUntil', 'cooldownRemainingMs', 'metricsAvailable', 'elapsedMs', 'firstMs', 'firstProseMs', 'firstViewportProseMs',
    'completed', 'failed', 'pending', 'total', 'renderedSegments', 'translatedChars', 'chineseSegments', 'viewportTargets', 'viewportCompleted',
    'status', 'statusText', 'errorCode', 'message', 'cacheOutputMatches', 'cacheNoNetwork', 'counterReset', 'requestRowsTruncated',
    'preparationCounterReset', 'preparationRowsTruncated', 'latePreparationCount', 'postTerminalPreparationCount', 'preClickRequestCount',
    'navigationRequestedAt', 'navigationStartedAt', 'navigationToFirstProseMs', 'navigationToFullMs',
    'toolbarReadyAt', 'toolbarReady', 'canStart', 'clickedAt', 'selectionLength',
    'firstVisibleProseDomReadyMs', 'firstVisibleProseRafMs', 'firstVisibleProseSourceId', 'initialViewportAllDoneMs',
    'fullDoneMs', 'doneAt', 'visible', 'focused', 'visibilityFailures', 'sourceChanged', 'rootTag',
    'sourceSegments', 'sourceChars', 'uniqueSourceTexts', 'unexpectedTranslations', 'mappingConflicts', 'outputFingerprint',
    'terminalObservationMs', 'lateRequestCount', 'postTerminalRequestCount', 'inputScope', 'paintMeasurement', 'toolbarMeasurement', 'passTimerOrigin'];
  const event = Object.fromEntries(keys.filter(key => ['string', 'number', 'boolean'].includes(typeof incoming[key])
    && (typeof incoming[key] !== 'number' || Number.isFinite(incoming[key])))
    .map(key => [key, typeof incoming[key] === 'string' ? incoming[key].slice(0, 500) : incoming[key]]));
  if (incoming.metrics) event.metrics = normalizeMetrics(incoming.metrics);
  if (incoming.navigationMetrics) event.navigationMetrics = normalizeMetrics(incoming.navigationMetrics);
  if (Array.isArray(incoming.initialViewportSourceIds)) event.initialViewportSourceIds = incoming.initialViewportSourceIds
    .filter(value => Number.isSafeInteger(value) && value >= 0 && value < 1500).slice(0, 1500);
  return event;
}

export async function buildPageProbe(workspace = process.cwd()) {
  const { build } = await import('vite');
  const result = await build({ configFile: false, root: workspace, publicDir: false, logLevel: 'silent',
    build: { write: false, sourcemap: false, minify: false, target: 'chrome120',
      lib: { entry: path.resolve(workspace, 'scripts/benchmarks/page-probe.ts'), name: 'NearInstalledBenchmarkProbe', formats: ['iife'] } } });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(value => value.output ?? []);
  const chunks = outputs.filter(item => item.type === 'chunk');
  assert.equal(chunks.length, 1, 'Page probe must be a single self-contained IIFE.');
  assert.equal(chunks[0].imports.length, 0);
  assert.equal(chunks[0].dynamicImports.length, 0);
  return chunks[0].code;
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; };
  const label = option('--label', 'page');
  assert.match(label, /^[a-z0-9-]+$/);
  const deadlineMs = Number(option('--timeout-ms', '360000'));
  const inspect = args.includes('--inspect'); const reload = args.includes('--reload');
  const cacheRepeat = args.includes('--warm') || args.includes('--cache-repeat'); const show = args.includes('--show');
  const expectedEngine = option('--engine', 'deepl-web');
  assert(['model', 'deepl-web'].includes(expectedEngine), '--engine only validates the current engine.');
  assert(deadlineMs >= 15000 && deadlineMs <= 600000);
  const workspace = await realpath(process.cwd());
  assert(process.env.NEAR_INSTALLED_EXTENSION_DIR, 'Set NEAR_INSTALLED_EXTENSION_DIR to the loaded extension directory inside this workspace.');
  const installed = await realpath(path.resolve(workspace, process.env.NEAR_INSTALLED_EXTENSION_DIR));
  const relative = path.relative(workspace, installed);
  assert(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep), 'The installed extension must be inside this workspace.');
  const extensionId = process.env.NEAR_INSTALLED_EXTENSION_ID;
  assert(typeof extensionId === 'string' && /^[a-p]{32}$/.test(extensionId), 'Set NEAR_INSTALLED_EXTENSION_ID to the browser extension ID.');
  const browserExecutable = process.env.NEAR_BROWSER_EXECUTABLE;
  assert(browserExecutable && path.isAbsolute(browserExecutable), 'Set NEAR_BROWSER_EXECUTABLE to an absolute browser executable path.');
  const profileDirectory = process.env.NEAR_BROWSER_PROFILE_DIRECTORY || 'Default';
  assert(/^[a-zA-Z0-9 ._-]{1,100}$/.test(profileDirectory), 'Invalid browser profile directory name.');
  const sourceUrl = 'https://go.dev/talks/2012/splash.article?utm_source=chatgpt.com';
  const version = JSON.parse(await readFile(path.join(installed, 'manifest.json'), 'utf8')).version;
  const token = randomBytes(20).toString('hex'); const basename = 'near-speed-' + token;
  const html = path.join(installed, basename + '.html'); const script = path.join(installed, basename + '.js');
  const pageScript = path.join(installed, basename + '.page.js');
  const events = []; let finish; let timeout;
  const done = new Promise(resolve => { finish = resolve; });
  const terminal = new Set(['inspect', 'blocked-existing-cooldown', 'complete', 'error', 'timeout', 'rate-limit', 'stopped', 'empty', 'incomplete']);
  const server = createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', 'chrome-extension://' + extensionId);
    response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS'); response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    response.setHeader('Access-Control-Allow-Private-Network', 'true');
    if (request.url !== '/' + token) { response.writeHead(404).end(); return; }
    if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
    if (request.method !== 'POST') { response.writeHead(405).end(); return; }
    let body = '';
    for await (const bytes of request) { body += bytes; if (body.length > 200000) { response.writeHead(413).end(); return; } }
    try {
      const incoming = JSON.parse(body);
      const event = normalizeBenchmarkEvent(incoming);
      events.push(event); console.log(JSON.stringify(event)); response.writeHead(200).end('ok');
      if (terminal.has(event.phase)) finish(event);
    } catch { response.writeHead(400).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = 'http://127.0.0.1:' + server.address().port + '/' + token;
  try {
    await writeFile(html, '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>近译 · 整页速度测试</title><h1>近译 · 整页速度测试</h1><p id="status">只检查当前引擎及公开 Go 文章；不读取 Key。</p><pre id="result"></pre><script src="' + basename + '.js"></script></html>');
    if (!inspect) await writeFile(pageScript, await buildPageProbe(workspace));
    const config = { endpoint, sourceUrl, deadlineMs, inspect, expectedEngine, expectedVersion: version, cacheRepeat, show,
      probeFile: basename + '.page.js', expectedSourceSegments: 251, expectedSourceChars: 53505, observationMs: 1000 };
    const helperSource = 'const normalizeMetrics=' + normalizeMetrics.toString() + ';\nconst metricsDelta=' + metricsDelta.toString()
      + ';\nconst classifyBenchmarkSnapshot=' + classifyBenchmarkSnapshot.toString()
      + ';\nconst assessBenchmarkCompletion=' + assessBenchmarkCompletion.toString()
      + ';\nconst runBrowserBenchmark=' + runBrowserBenchmark.toString() + ';\n(' + browserMain.toString() + ')(' + JSON.stringify(config) + ');';
    await writeFile(script, helperSource);
    const open = query => {
      const child = spawn(browserExecutable, ['--profile-directory=' + profileDirectory, 'chrome-extension://' + extensionId + '/' + basename + '.html' + query],
        { windowsHide: true, stdio: 'ignore' }); child.unref();
    };
    if (reload && !inspect) { open('?reload=1'); await new Promise(resolve => setTimeout(resolve, 1800)); }
    open('');
    timeout = setTimeout(() => finish({ phase: 'harness-timeout', message: 'No final response from installed extension.' }),
      inspect ? 30000 : deadlineMs * (cacheRepeat ? 2 : 1) + 45000);
    const result = await done;
    await mkdir(path.join(workspace, '.output'), { recursive: true });
    const evidence = path.join(workspace, '.output/go-page-' + label + '-' + token + '.json');
    await writeFile(evidence, JSON.stringify({ label, sourceUrl, expectedEngine, expectedVersion: version, inspect, events, result }, null, 2) + '\n');
    console.log(JSON.stringify({ evidence }));
    if (!['complete', 'inspect'].includes(result.phase)) process.exitCode = result.phase === 'blocked-existing-cooldown' ? 2 : 1;
  } finally {
    clearTimeout(timeout); await new Promise(resolve => server.close(resolve));
    await Promise.all([unlink(html).catch(() => {}), unlink(script).catch(() => {}), unlink(pageScript).catch(() => {})]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
