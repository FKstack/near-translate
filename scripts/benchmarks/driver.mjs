/** Runs only in the unique trusted helper page. The injected probe owns DOM work. */
export async function runBrowserBenchmark(config, helpers) {
  const { normalizeMetrics, metricsDelta, classifyBenchmarkSnapshot, assessBenchmarkCompletion } = helpers;
  const { endpoint, sourceUrl, deadlineMs, inspect, expectedEngine, expectedVersion, cacheRepeat, show, probeFile } = config;
  const observationMs = Math.max(1000, config.observationMs ?? 1000);
  const report = async data => {
    document.querySelector('#result').textContent = JSON.stringify(data, null, 2);
    await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  };
  const metrics = async () => {
    try { return normalizeMetrics(await chrome.runtime.sendMessage({ type: 'get-translation-metrics' })); }
    catch { return undefined; }
  };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  let ownedTab;
  let preserveTarget = false;
  const targetCall = async (method, ...args) => {
    const [value] = await chrome.scripting.executeScript({ target: { tabId: ownedTab.id },
      args: [sourceUrl, method, args], func: async (expected, method, args) => {
        if (location.href !== expected) throw new Error('Benchmark target left the exact public Go URL.');
        const probe = window.__nearInstalledBenchmarkProbe;
        if (!probe || !['readiness', 'prepare', 'start', 'snapshot', 'restore', 'restored', 'stop', 'cleanup'].includes(method))
          throw new Error('Bundled benchmark probe is unavailable.');
        return await probe[method](...args);
      } });
    return value?.result;
  };
  const foregroundOwnedTab = async () => {
    const current = await chrome.tabs.get(ownedTab.id);
    if (current.url !== sourceUrl) throw new Error('Only this run\'s public Go tab may be focused.');
    await chrome.tabs.update(ownedTab.id, { active: true });
    await chrome.windows.update(ownedTab.windowId, { focused: true });
  };
  const cleanup = async () => {
    if (!ownedTab) return;
    try {
      const tab = await chrome.tabs.get(ownedTab.id);
      if (tab.url !== sourceUrl) return; // A user navigation revokes this tool's page ownership.
      await targetCall('stop'); await targetCall('cleanup');
      if (!preserveTarget) await chrome.tabs.remove(ownedTab.id);
    } catch { /* A closed/navigated target cannot be operated on or inspected further. */ }
  };
  const summary = snapshot => {
    const navigationTimes = {};
    if (Number.isFinite(snapshot.navigationStartedAt) && Number.isFinite(snapshot.clickedAt)
      && snapshot.clickedAt >= snapshot.navigationStartedAt) {
      const beforeClick = snapshot.clickedAt - snapshot.navigationStartedAt;
      if (Number.isFinite(snapshot.firstVisibleProseDomReadyMs) && snapshot.firstVisibleProseDomReadyMs >= 0)
        navigationTimes.navigationToFirstProseMs = beforeClick + snapshot.firstVisibleProseDomReadyMs;
      if (Number.isFinite(snapshot.fullDoneMs) && snapshot.fullDoneMs >= 0)
        navigationTimes.navigationToFullMs = beforeClick + snapshot.fullDoneMs;
    }
    return { ...snapshot, ...navigationTimes, inputScope: 'production-root/all-source-segments',
      paintMeasurement: 'next-visible-requestAnimationFrame-approximation',
      toolbarMeasurement: 'first-observed-by-injected-probe',
      passTimerOrigin: 'translation-click', elapsedMs: Math.round(snapshot.elapsedMs) };
  };
  async function run() {
    if (new URL(location.href).searchParams.has('reload')) {
      await report({ phase: 'reloading', version: chrome.runtime.getManifest().version }); chrome.runtime.reload(); return;
    }
    const settings = await chrome.runtime.sendMessage({ type: 'get-settings' });
    const version = chrome.runtime.getManifest().version;
    const translationEngine = settings.translationEngine || 'model';
    const cooldownValue = (await chrome.storage.session.get('deepl-web:cooldown-until:v1'))['deepl-web:cooldown-until:v1'];
    const cooldownUntil = Number.isSafeInteger(cooldownValue) && cooldownValue >= 0 ? cooldownValue : 0;
    let networkPreparationPermission = false;
    try { networkPreparationPermission = !!await chrome.permissions?.contains({ permissions: ['declarativeNetRequestWithHostAccess'] }); }
    catch { /* Older inspect mocks and denied permissions remain false. */ }
    const ready = { phase: inspect ? 'inspect' : 'ready', version, translationEngine,
      ...(translationEngine === 'model' ? { model: settings.model } : {}),
      enabled: settings.enabled, hasApiKey: settings.hasApiKey, webAccess: settings.webAccess, apiAccess: settings.apiAccess, networkPreparationPermission,
      cooldownUntil, cooldownRemainingMs: Math.max(0, cooldownUntil - Date.now()), metricsAvailable: !!await metrics() };
    await report(ready);
    if (inspect) return;
    if (version !== expectedVersion) throw new Error('扩展运行版本与安装目录不一致，请重新加载后再测试。');
    if (translationEngine !== expectedEngine) throw new Error('当前翻译引擎与--engine不一致；测速脚本不会更改配置。');
    if (translationEngine === 'deepl-web' && ready.cooldownRemainingMs > 0) {
      await report({ ...ready, phase: 'blocked-existing-cooldown' }); return;
    }
    if (!settings.enabled || (!settings.hasApiKey && settings.requiresApiKey !== false) || !settings.webAccess || settings.apiAccess === false)
      throw new Error('请先启用网页翻译并授权当前翻译服务。');
    if (!ready.metricsAvailable || !probeFile) throw new Error('后台统计或独立打包的页面探针不可用。');
    // This baseline precedes document_start preparation; the later click
    // baseline cannot account for all navigation-triggered network activity.
    const navigationBeforeMetrics = await metrics();
    if (!navigationBeforeMetrics || navigationBeforeMetrics.activeRequests || navigationBeforeMetrics.activePreparations)
      throw new Error('导航前后台已有网络任务或统计不可用，请在空闲时测试。');
    const navigationRequestedAt = Date.now();
    ownedTab = await chrome.tabs.create({ url: sourceUrl, active: true });
    await chrome.windows.update(ownedTab.windowId, { focused: true });
    await report({ phase: 'navigating', version, translationEngine, navigationRequestedAt });
    const readinessDeadline = performance.now() + 45000;
    let injected = false;
    let pageReady;
    while (performance.now() < readinessDeadline) {
      const tab = await chrome.tabs.get(ownedTab.id);
      if (tab.url === sourceUrl) {
        if (!injected) {
          try {
            await chrome.scripting.executeScript({ target: { tabId: ownedTab.id }, files: [probeFile], injectImmediately: true });
            injected = !!await targetCall('readiness');
          } catch { /* The exact public document may not yet have a body. */ }
        }
        if (injected) {
          pageReady = await targetCall('readiness');
          if (pageReady?.toolbarReady && pageReady.canStart && pageReady.visible && pageReady.focused) break;
        }
      }
      await sleep(100);
    }
    if (!pageReady?.toolbarReady || !pageReady.canStart || !pageReady.visible || !pageReady.focused)
      throw new Error('公开 Go 页未就绪，或不是可见且有焦点的活动标签页。');
    await report({ phase: 'toolbar-ready', version, translationEngine, ...pageReady });
    let cold;
    let warmBeforeRestore;
    for (const pass of cacheRepeat ? ['cold', 'cached'] : ['cold']) {
      const before = pass === 'cached' ? warmBeforeRestore : await metrics();
      if (!before || before.activeRequests > 0 || (pass === 'cached' && before.activePreparations > 0))
        throw new Error('后台已有翻译请求或统计不可用，请在没有其他翻译任务时测试。');
      if (pass === 'cold') {
        const preClick = metricsDelta(navigationBeforeMetrics, before);
        if (preClick.counterReset || preClick.requestRowsTruncated || preClick.preparationRowsTruncated)
          throw new Error('导航期间后台指标重置或记录截断，无法审计点击前请求。');
        if (preClick.requestCount) throw new Error('点击翻译前已经发送正文请求，未启动本轮翻译。');
      }
      if (pass === 'cached') {
        await targetCall('restore');
        const restoredDeadline = performance.now() + 5000;
        while (!await targetCall('restored')) {
          if (performance.now() > restoredDeadline) throw new Error('原文恢复未完成。');
          await sleep(50);
        }
      }
      const startReady = await targetCall('readiness');
      if (!startReady.visible || !startReady.focused) throw new Error('翻译前公开 Go 页失去可见性或焦点。');
      const sources = await targetCall('prepare');
      if ((config.expectedSourceSegments !== undefined && sources.sourceSegments !== config.expectedSourceSegments)
        || (config.expectedSourceChars !== undefined && sources.sourceChars !== config.expectedSourceChars) || !sources.viewportTargets)
        throw new Error('公开 Go 页初始完整源范围或可见正文与预期不一致，未启动翻译。');
      await targetCall('start');
      await report({ phase: 'started', pass, version, translationEngine, navigationRequestedAt });
      const started = performance.now(); let lastReport = 0;
      while (true) {
        await sleep(200);
        const snapshot = await targetCall('snapshot');
        if (!snapshot) throw new Error('测试页面或初始原文快照不可用。');
        let phase = classifyBenchmarkSnapshot(snapshot);
        if ((!snapshot.visible || !snapshot.focused || snapshot.visibilityFailures) && !phase) {
          await targetCall('stop'); phase = 'error';
        }
        if (performance.now() - started > deadlineMs && !phase) { await targetCall('stop'); phase = 'timeout'; }
        if (!phase && snapshot.status === 'idle' && performance.now() - started > 5000) phase = 'error';
        if (!phase && performance.now() - lastReport > 5000) {
          lastReport = performance.now();
          const currentMetrics = await metrics();
          await report({ phase: 'progress', pass, version, translationEngine, ...summary(snapshot),
            metrics: metricsDelta(before, currentMetrics), navigationMetrics: metricsDelta(navigationBeforeMetrics, currentMetrics) });
        }
        if (!phase) continue;
        const atTerminal = await metrics();
        if (!atTerminal) throw new Error('终态后台指标不可用。');
        const observationStarted = performance.now();
        // Keep both the DOM observer and diagnostics alive beyond terminal state.
        await sleep(observationMs);
        const observed = await targetCall('snapshot');
        const after = await metrics();
        const delta = metricsDelta(before, after);
        const navigationDelta = metricsDelta(navigationBeforeMetrics, after);
        const observedForMs = performance.now() - observationStarted;
        const assessment = assessBenchmarkCompletion({ snapshot: observed, delta, navigationDelta, atTerminal,
          observedForMs, pass, cold, expectedSourceSegments: config.expectedSourceSegments,
          expectedSourceChars: config.expectedSourceChars });
        if (phase === 'complete' && assessment.message) phase = 'error';
        const final = { pass, version, translationEngine, ...summary(observed), metrics: delta, navigationMetrics: navigationDelta,
          counterReset: delta.counterReset || navigationDelta.counterReset,
          requestRowsTruncated: delta.requestRowsTruncated || navigationDelta.requestRowsTruncated,
          preparationCounterReset: delta.preparationCounterReset || navigationDelta.preparationCounterReset,
          preparationRowsTruncated: delta.preparationRowsTruncated || navigationDelta.preparationRowsTruncated,
          terminalObservationMs: observedForMs, lateRequestCount: assessment.lateRequestCount,
          postTerminalRequestCount: assessment.postTerminalRequestCount,
          latePreparationCount: assessment.latePreparationCount, postTerminalPreparationCount: assessment.postTerminalPreparationCount,
          preClickRequestCount: assessment.preClickRequestCount,
          ...(pass === 'cached' ? { cacheOutputMatches: assessment.cacheOutputMatches,
            cacheNoNetwork: delta.requestCount === 0 && delta.preparationCount === 0 && delta.preparations.length === 0
              && delta.activeRequests === 0 && delta.activePreparations === 0 } : {}),
          ...(assessment.message ? { message: assessment.message } : {}) };
        if (phase !== 'complete') {
          await cleanup(); await report({ phase, ...final }); return;
        }
        if (pass === 'cold') cold = { outputFingerprint: observed.outputFingerprint, sourceSegments: observed.sourceSegments,
          sourceChars: observed.sourceChars, total: observed.total };
        if (cacheRepeat && pass === 'cold') {
          warmBeforeRestore = after; // Includes the reporting gap as well as restore itself.
          await report({ phase: 'pass-complete', ...final });
          break;
        }
        if (show) { await foregroundOwnedTab(); preserveTarget = true; }
        await cleanup(); await report({ phase: 'complete', ...final }); return;
      }
    }
  }
  return run().catch(async error => {
    await cleanup();
    const message = String(error.message).replace(/(?:https?|chrome-extension|chrome|edge|file):\/\/[^\s"'<>]+/g, '[URL omitted]');
    await report({ phase: 'error', message });
  });
}
