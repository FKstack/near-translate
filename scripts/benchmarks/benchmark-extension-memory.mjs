import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';

// An offline, owned-fixture benchmark. This never connects to a user's browser,
// reads their storage, or sends a translation request. Only its temporary copy
// receives website permission, matching the existing isolated E2E harness.
const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(name); return at < 0 ? fallback : args[at + 1]; };
const root = await realpath(path.resolve(import.meta.dirname, '../..'));
const inside = value => { const relative = path.relative(root, value); assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Path must stay inside workspace.'); return value; };
const source = inside(await realpath(path.resolve(root, option('--extension', '.output/chrome-mv3'))));
const label = option('--label', 'current');
assert(/^[a-z0-9.-]+$/i.test(label), 'Label must contain only letters, digits, dots and hyphens.');
const runs = Number(option('--runs', '3'));
assert(Number.isInteger(runs) && runs >= 1 && runs <= 10);
const cycles = Number(option('--cycles', '5'));
assert(Number.isInteger(cycles) && cycles >= 5 && cycles <= 30);
const modes = option('--modes', 'plain,installed-no-web-access,enabled-web-access').split(',');
assert(modes.length && new Set(modes).size === modes.length && modes.every(mode => ['plain', 'installed-no-web-access', 'enabled-web-access'].includes(mode)));
const includeProcessMetrics = !args.includes('--no-process');
const idleIpcSeconds = Number(option('--idle-ipc-seconds', '0'));
assert(Number.isInteger(idleIpcSeconds) && idleIpcSeconds >= 0 && idleIpcSeconds <= 30);
const idleIpcOnly = args.includes('--idle-ipc-only');
assert(!idleIpcOnly || idleIpcSeconds > 0, '--idle-ipc-only requires an observation duration.');
const output = inside(path.resolve(root, option('--output', `.output/extension-memory-${label}.json`)));
const executablePath = process.env.NEAR_BROWSER_EXECUTABLE;
assert(executablePath && path.isAbsolute(executablePath), 'Set NEAR_BROWSER_EXECUTABLE to an absolute path for a browser that supports loading unpacked extensions.');
const manifestText = await readFile(path.resolve(source, 'manifest.json'), 'utf8');
const manifest = JSON.parse(manifestText);
const artifactsRoot = path.resolve(root, '.output/memory-benchmark');
await mkdir(artifactsRoot, { recursive: true });
const sessionRoot = await mkdtemp(path.resolve(artifactsRoot, `${label}-`));
const activeCopy = path.resolve(sessionRoot, 'extension');
await cp(source, activeCopy, { recursive: true });
await writeFile(path.resolve(activeCopy, 'manifest.json'), JSON.stringify({ ...manifest,
  host_permissions: [...new Set([...(manifest.host_permissions ?? []), 'http://*/*', 'https://*/*'])],
}, null, 2));

const paragraphs = Array.from({ length: 40 }, (_, i) => `<h2>Section ${i + 1}: Keep the evidence close</h2><p id="paragraph-${i}">A reading tool should preserve the important details and remain quiet until the reader asks for help. This local fixture contains a predictable amount of text, so that browser memory can be compared without visiting a private website. Readers can follow the argument at their own pace, keep source code near the explanation, and close the reading surface when it is no longer needed. Section ${i + 1} repeats the same structure to avoid a changing network workload.</p>${i % 5 === 0 ? '<pre><code>const result = samples.map(sample =&gt; sample.value).filter(Number.isFinite);\nconsole.log(result);</code></pre>' : ''}`).join('');
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Extension memory benchmark fixture</title><meta name="author" content="Local benchmark"><style>body{margin:0;color:#22372b;background:#f3f5f2;font:18px/1.8 system-ui}header,main{max-width:900px;margin:30px auto;padding:28px;background:white}pre{padding:14px;background:#eee}h2{margin-top:44px}a{color:#245b3c}</style></head><body><header><nav>Local benchmark fixture only</nav></header><main><article><h1>Keep browser reading lightweight</h1>${paragraphs}</article></main></body></html>`;
const pdf = (() => {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [4 0 R 6 0 R] /Count 2 >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for (let i = 0; i < 2; i++) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    const stream = `BT /F1 16 Tf 50 720 Td (Memory benchmark page ${i + 1}.) Tj 0 -28 Td (No document leaves this computer.) Tj ET`;
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  let text = '%PDF-1.4\n'; const offsets = [0];
  for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(text)); text += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
  const start = Buffer.byteLength(text);
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(text);
})();
const server = createServer((request, response) => {
  if (request.url?.split('?')[0] === '/fixture.pdf') { response.writeHead(200, { 'Content-Type': 'application/pdf' }); response.end(pdf); }
  else if (request.url?.startsWith('/fixture')) { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(html); }
  else { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const execute = promisify(execFile);

async function processMemory(profile) {
  if (!includeProcessMetrics) return { available: false, reason: 'Process metrics disabled for focused probe.' };
  if (process.platform !== 'win32') return { available: false, reason: 'Windows process measurement only.' };
  // The command emits only numeric memory data for this unique temporary profile
  // and its descendants. Other process command lines are never exported.
  const quoted = profile.replaceAll("'", "''");
  const script = `$all = @(Get-CimInstance Win32_Process); $roots = @($all | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${quoted}') -and $_.CommandLine -notmatch '--type=' }); $owned = [System.Collections.Generic.HashSet[int]]::new(); foreach ($item in $roots) { [void]$owned.Add([int]$item.ProcessId) }; do { $added = $false; foreach ($item in $all) { if ($owned.Contains([int]$item.ParentProcessId) -and $owned.Add([int]$item.ProcessId)) { $added = $true } } } while ($added); $rows = @(foreach ($item in $all) { if ($owned.Contains([int]$item.ProcessId)) { $p = Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue; if ($p) { $kind = if ($item.CommandLine -match '--type=([^ "]+)') { $Matches[1] } else { 'browser' }; [pscustomobject]@{kind=$kind;workingSetBytes=[double]$p.WorkingSet64;privateCommittedBytes=[double]$p.PrivateMemorySize64} } } }); [pscustomobject]@{available=($rows.Count -gt 0);processCount=$rows.Count;workingSetSumBytes=($rows | Measure-Object workingSetBytes -Sum).Sum;privateCommittedSumBytes=($rows | Measure-Object privateCommittedBytes -Sum).Sum;processes=$rows} | ConvertTo-Json -Depth 4 -Compress`;
  try { return JSON.parse((await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { maxBuffer: 1024 * 1024 })).stdout); }
  catch { return { available: false, reason: 'Process memory collection unavailable.' }; }
}

async function fileInventory(directory, prefix = '') {
  const files = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const name = `${prefix}${item.name}`; const target = path.join(directory, item.name);
    if (item.isDirectory()) files.push(...await fileInventory(target, `${name}/`));
    else if (item.isFile()) { const bytes = await readFile(target); files.push({ path: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }); }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}
const inventory = await fileInventory(source);

async function attachPage(context, page) {
  const cdp = await context.newCDPSession(page);
  const extensionScripts = new Set();
  cdp.on('Debugger.scriptParsed', event => { if (event.url.startsWith('chrome-extension://')) extensionScripts.add(new URL(event.url).pathname.slice(1)); });
  await cdp.send('Performance.enable');
  await cdp.send('Debugger.enable');
  return { page, cdp, extensionScripts };
}

async function numericSample(cdp, collectGarbage = false) {
  if (collectGarbage) await cdp.send('HeapProfiler.collectGarbage');
  const heap = await cdp.send('Runtime.getHeapUsage');
  const dom = await cdp.send('Memory.getDOMCounters');
  const performance = await cdp.send('Performance.getMetrics');
  const metrics = Object.fromEntries(performance.metrics.map(item => [item.name, item.value]));
  return { heapUsedBytes: heap.usedSize, heapTotalBytes: heap.totalSize,
    ...(Number.isFinite(heap.embedderHeapUsedSize) ? { embedderHeapUsedBytes: heap.embedderHeapUsedSize } : {}),
    ...(Number.isFinite(heap.backingStorageSize) ? { backingStorageBytes: heap.backingStorageSize } : {}),
    documents: dom.documents, nodes: dom.nodes, eventListeners: dom.jsEventListeners,
    layoutCount: metrics.LayoutCount, scriptDurationSeconds: metrics.ScriptDuration,
    taskDurationSeconds: metrics.TaskDuration };
}

async function pageSnapshot(tracked, profile, includeProcesses = true) {
  const natural = await numericSample(tracked.cdp);
  const gcSamples = [];
  for (let i = 0; i < 3; i++) { gcSamples.push(await numericSample(tracked.cdp, true)); await delay(50); }
  const gc = Object.fromEntries(Object.keys(gcSamples[0]).map(key => [key, median(gcSamples.map(item => item[key]))]));
  const scripts = [...tracked.extensionScripts].sort();
  const scriptBytes = scripts.reduce((sum, name) => sum + (inventory.find(file => file.path === name)?.bytes ?? 0), 0);
  return { natural, gc, gcSamples, loadedExtensionScripts: scripts, loadedExtensionScriptBytes: scriptBytes,
    ...(includeProcesses ? { browserProcesses: await processMemory(profile) } : {}) };
}

async function workerSnapshot(browserCDP, workerUrl) {
  if (!workerUrl) return { available: false };
  let workerSession;
  let requestId = 0;
  const pending = new Map();
  const onMessage = event => {
    if (event.sessionId !== workerSession) return;
    const message = JSON.parse(event.message); const callback = pending.get(message.id);
    if (callback) { pending.delete(message.id); message.error ? callback.reject(new Error(message.error.message)) : callback.resolve(message.result); }
  };
  const send = async (method, params = {}) => {
    const id = ++requestId;
    const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    await browserCDP.send('Target.sendMessageToTarget', { sessionId: workerSession, message: JSON.stringify({ id, method, params }) });
    return Promise.race([result, delay(5000).then(() => { throw new Error('Worker CDP timeout.'); })]);
  };
  try {
    const targets = await browserCDP.send('Target.getTargets');
    const target = targets.targetInfos.find(item => item.type === 'service_worker' && item.url === workerUrl);
    if (!target) return { available: false, reason: 'Worker is dormant.' };
    ({ sessionId: workerSession } = await browserCDP.send('Target.attachToTarget', { targetId: target.targetId, flatten: false }));
    browserCDP.on('Target.receivedMessageFromTarget', onMessage);
    const natural = await send('Runtime.getHeapUsage');
    await send('HeapProfiler.collectGarbage');
    const gc = await send('Runtime.getHeapUsage');
    return { available: true, natural, gc, caveat: 'Attached for measurement; this keeps the MV3 worker alive. It is not evidence of normal persistent residency.' };
  } catch (error) { return { available: false, reason: String(error.message).slice(0, 200) }; }
  finally {
    browserCDP.off('Target.receivedMessageFromTarget', onMessage);
    if (workerSession) await browserCDP.send('Target.detachFromTarget', { sessionId: workerSession }).catch(() => {});
  }
}

const evidence = { schemaVersion: 1, label, extensionVersion: manifest.version, startedAt: new Date().toISOString(),
  source: path.relative(root, source).replaceAll('\\', '/'), environment: { platform: process.platform, node: process.version, executable: path.relative(root, executablePath).replaceAll('\\', '/') },
  method: { fixture: { paragraphCount: 40, localHtmlBytes: Buffer.byteLength(html), sha256: createHash('sha256').update(html).digest('hex') }, runs, cycles, modes, idleIpcSeconds, idleIpcOnly,
    automation: 'Every mode touches each fixture with the same Playwright locator helper. Its isolated-world overhead is present in controls as well as extension samples.',
    memory: 'Runtime.getHeapUsage is the page renderer V8 isolate, including extension isolated worlds; it is not total extension or browser memory.',
    gc: 'Each scenario records natural heap followed by three forced-GC measurements and their median.',
    process: 'Windows owned browser process tree only. workingSetSumBytes double-counts shared pages; privateCommittedSumBytes is committed private memory, not resident memory. These noisy whole-browser totals are supplementary.',
    pdf: 'PDF scenarios sample the reader UI renderer V8 isolate only. The PDF.js dedicated worker isolate, native image buffers, canvas and GPU memory are not included in that heap figure.',
    network: 'Only owned localhost fixture allowed. No API key or translation requests.',
    worker: 'Service-worker heaps are measured separately with debugger attachment and must not be added as persistent residency.',
    retainedCode: 'Closing reading releases the surface; already loaded modules/code may remain cached. Repeated cycles assess retained live objects.' },
  build: { fileCount: inventory.length, totalBytes: inventory.reduce((sum, file) => sum + file.bytes, 0), files: inventory }, samples: [], failures: [] };

async function benchmark(mode, run) {
  const profile = await mkdtemp(path.resolve(sessionRoot, 'profile-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, { executablePath, channel: 'chromium', headless: true,
      ignoreDefaultArgs: ['--disable-extensions'], viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce',
      args: ['--enable-unsafe-extension-debugging', '--disable-background-networking', '--disable-component-update', '--no-default-browser-check'] });
    const browser = context.browser(); assert(browser);
    evidence.environment.browserVersion ??= browser.version();
    const browserCDP = await browser.newBrowserCDPSession();
    let worker; let extensionId;
    const blockedRequests = [];
    await context.route(/^https?:\/\//, route => {
      if (route.request().url().startsWith(`${base}/`)) return route.continue();
      blockedRequests.push(new URL(route.request().url()).origin); return route.abort('blockedbyclient');
    });
    if (mode !== 'plain') {
      await browserCDP.send('Extensions.loadUnpacked', { path: mode === 'enabled-web-access' ? activeCopy : source });
      worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 15000 });
      extensionId = new URL(worker.url()).host;
      await worker.evaluate(() => {
        globalThis.__memoryBlockedRequests = 0;
        const native = globalThis.fetch.bind(globalThis);
        globalThis.fetch = (input, init) => {
          const url = input instanceof Request ? input.url : String(input);
          if (/^https?:/i.test(url) && !url.startsWith('http://127.0.0.1:')) { globalThis.__memoryBlockedRequests++; throw new Error('External service disabled in memory benchmark.'); }
          return native(input, init);
        };
      });
      if (idleIpcSeconds > 0) await worker.evaluate(() => {
        globalThis.__memoryStatusQueries = 0;
        chrome.runtime.onMessage.addListener(message => {
          // A passive, count-only listener: no response and no request content.
          if (message?.type === 'get-translation-status') globalThis.__memoryStatusQueries++;
        });
      });
      // Wait for production registration to settle rather than manually injecting
      // a different path, keeping idle measurements representative.
      for (let i = 0; i < 60; i++) {
        const registered = await worker.evaluate(() => chrome.scripting.getRegisteredContentScripts());
        const present = registered.some(item => item.id === 'near-translate-selection');
        if (present === (mode === 'enabled-web-access')) break;
        if (i === 59) throw new Error('Content registration did not settle.');
        await delay(100);
      }
    }
    for (const initial of context.pages()) await initial.close();
    const page = await context.newPage(); const tracked = await attachPage(context, page);
    await page.goto(`${base}/fixture?run=${run}&mode=${mode}`); await page.waitForLoadState('load');
    if (mode === 'enabled-web-access') await page.locator('near-page-translate .np-primary').waitFor();
    else assert.equal(await page.locator('near-page-translate').count(), 0);
    await delay(400);
    const row = { mode, run, scenarios: {}, blockedExternalRequests: 0 };
    row.scenarios.idleOnePage = await pageSnapshot(tracked, profile);
    row.serviceWorker = await workerSnapshot(browserCDP, worker?.url());
    if (idleIpcSeconds > 0 && worker) {
      const before = await worker.evaluate(() => globalThis.__memoryStatusQueries ?? 0);
      const started = Date.now(); await delay(idleIpcSeconds * 1000);
      const after = await worker.evaluate(() => globalThis.__memoryStatusQueries ?? 0);
      row.idleIpc = { initializationStatusQueries: before, statusQueriesDuringWindow: after - before, observedMs: Date.now() - started,
        caveat: 'Debugger keeps worker alive. This verifies polling traffic only, not normal service-worker dormancy.' };
    }
    if (!idleIpcOnly) {
    const extras = [];
    for (let i = 1; i < 10; i++) {
      const extra = await context.newPage(); const extraTracked = await attachPage(context, extra);
      await extra.goto(`${base}/fixture?tab=${i}`);
      if (mode === 'enabled-web-access') await extra.locator('near-page-translate .np-primary').waitFor();
      else assert.equal(await extra.locator('near-page-translate').count(), 0);
      extras.push(extraTracked);
    }
    const allPages = [tracked, ...extras];
    const tabSamples = [];
    for (const tab of allPages) tabSamples.push(await pageSnapshot(tab, profile, false));
    row.scenarios.idleTenPages = { tabs: tabSamples, heapUsedSumBytes: tabSamples.reduce((sum, item) => sum + item.gc.heapUsedBytes, 0),
      nodesSum: tabSamples.reduce((sum, item) => sum + item.gc.nodes, 0), eventListenersSum: tabSamples.reduce((sum, item) => sum + item.gc.eventListeners, 0),
      browserProcesses: await processMemory(profile), caveat: 'Sum of per-tab renderer-isolate samples. Browser process sharing can make this non-additive; see process counts.' };
    for (const extra of extras) await extra.page.close();
    await page.bringToFront(); await delay(100);
    if (mode === 'enabled-web-access') {
      for (let cycle = 1; cycle <= cycles; cycle++) {
        await page.keyboard.press('Alt+Shift+R');
        await page.getByRole('dialog', { name: '近译阅读模式', exact: true }).waitFor();
        await page.locator('near-reading-mode .nr-content > article').waitFor();
        await delay(100);
        if (cycle === 1) row.scenarios.readingOpen = await pageSnapshot(tracked, profile);
        await page.keyboard.press('Escape');
        await page.getByRole('dialog', { name: '近译阅读模式', exact: true }).waitFor({ state: 'detached' });
        await delay(100);
        row.scenarios[`readingClosed${cycle}`] = await pageSnapshot(tracked, profile, cycle === cycles);
      }
      const pdfPage = await context.newPage(); const pdfTracked = await attachPage(context, pdfPage);
      await pdfPage.goto(`chrome-extension://${extensionId}/reader.html`);
      await pdfPage.getByRole('button', { name: '打开本地 PDF', exact: true }).waitFor();
      await pdfPage.waitForFunction(() => !document.querySelector('button.reader-primary')?.disabled);
      row.scenarios.pdfReaderEmpty = await pageSnapshot(pdfTracked, profile);
      await pdfPage.getByLabel('选择本地 PDF 文件', { exact: true }).setInputFiles({ name: 'local-memory-fixture.pdf', mimeType: 'application/pdf', buffer: pdf });
      await pdfPage.locator('.textLayer').first().waitFor();
      await pdfPage.getByLabel('PDF 文档', { exact: true }).getByText('Memory benchmark page 1.', { exact: false }).waitFor();
      await delay(250);
      row.scenarios.pdfReaderTwoPages = await pageSnapshot(pdfTracked, profile);
      await pdfPage.close();
      row.scenarios.afterPdfClosed = await pageSnapshot(tracked, profile);
    }
    }
    row.blockedExternalRequests = blockedRequests.length + (worker ? await worker.evaluate(() => globalThis.__memoryBlockedRequests ?? 0) : 0);
    assert.equal(row.blockedExternalRequests, 0, 'A service tried an external request in an idle/local-only benchmark.');
    evidence.samples.push(row);
    await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(evidence, null, 2) + '\n');
    console.log(`${label} run ${run}/${runs} ${mode}: idle GC ${(row.scenarios.idleOnePage.gc.heapUsedBytes / 1048576).toFixed(2)} MiB, ${row.scenarios.idleOnePage.gc.nodes} nodes, ${row.scenarios.idleOnePage.gc.eventListeners} listeners`);
  } finally {
    await context?.close();
    const actualProfile = inside(await realpath(profile));
    assert(path.relative(sessionRoot, actualProfile).startsWith('profile-'));
    await rm(actualProfile, { recursive: true, force: true });
  }
}

try {
  for (let run = 1; run <= runs; run++) for (const mode of modes) {
    try { await benchmark(mode, run); }
    catch (error) { evidence.failures.push({ run, mode, message: String(error.stack ?? error).slice(0, 2000) }); throw error; }
  }
} finally {
  evidence.finishedAt = new Date().toISOString();
  await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(evidence, null, 2) + '\n');
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  assert.equal(path.relative(await realpath(artifactsRoot), await realpath(sessionRoot)), path.basename(sessionRoot));
  await rm(sessionRoot, { recursive: true, force: true });
  assert.equal(await readFile(path.resolve(source, 'manifest.json'), 'utf8'), manifestText, 'Production manifest changed during benchmark.');
  console.log(`Evidence: ${path.relative(root, output)}`);
}
