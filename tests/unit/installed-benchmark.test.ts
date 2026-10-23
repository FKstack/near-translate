import { afterEach, describe, expect, it, vi } from 'vitest';

const benchmark = await vi.importActual<{
  normalizeMetrics(value: unknown): Record<string, unknown> | undefined;
  normalizeBenchmarkEvent(value: unknown): Record<string, unknown>;
  metricsDelta(before: unknown, after: unknown): Record<string, unknown>;
  classifyBenchmarkSnapshot(value: Record<string, unknown>): string | undefined;
  browserMain(config: Record<string, unknown>): Promise<void>;
  assessBenchmarkCompletion(value: Record<string, unknown>): Record<string, unknown>;
  buildPageProbe(workspace?: string): Promise<string>;
}>('../../scripts/benchmarks/benchmark-installed-page.mjs');
const empty = { requestCount: 0, totalTexts: 0, totalChars: 0, activeRequests: 0, maxConcurrent: 0, statusCounts: {}, errorCounts: {}, requests: [] };

describe('installed benchmark outcomes', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  it('requires complete coverage rather than treating a stopped zero-failure run as success', () => {
    expect(benchmark.classifyBenchmarkSnapshot({ status: 'stopped', total: 314, completed: 10, failed: 0, pending: 304 })).toBe('stopped');
    expect(benchmark.classifyBenchmarkSnapshot({ status: 'done', total: 314, completed: 314, failed: 0, pending: 0 })).toBe('complete');
    expect(benchmark.classifyBenchmarkSnapshot({ status: 'done', total: 314, completed: 313, failed: 0, pending: 1 })).toBe('incomplete');
    expect(benchmark.classifyBenchmarkSnapshot({ status: 'done', total: 314, completed: 314, renderedSegments: 313, failed: 0, pending: 0 })).toBe('incomplete');
    expect(benchmark.classifyBenchmarkSnapshot({ status: 'done', total: 0, completed: 0, failed: 0, pending: 0 })).toBe('empty');
  });

  it('recognizes rate limiting independently of the visible translated message', () => {
    expect(benchmark.classifyBenchmarkSnapshot({ status: 'stopped', errorCode: 'RATE_LIMIT', statusText: 'DeepL 请求受限，已暂停后续翻译。' })).toBe('rate-limit');
    expect(benchmark.classifyBenchmarkSnapshot({ status: 'stopped', errorCode: 'CONFIG' })).toBe('stopped');
  });

  it('keeps only numeric diagnostics and known status values', () => {
    const result = benchmark.normalizeMetrics({ ...empty, requestCount: 1, apiKey: 'secret', url: 'https://private.invalid',
      requests: [{ sequence: 1, startedAt: 100, endedAt: 150, textCount: 16, charCount: 4000, status: 200,
        text: 'private source', headers: { Authorization: 'secret' }, url: 'https://private.invalid' }],
    });
    expect(result).toMatchObject({ requestCount: 1, requests: [{ sequence: 1, textCount: 16, charCount: 4000, status: 200 }] });
    expect(JSON.stringify(result)).not.toMatch(/secret|private|Authorization/);
    expect(benchmark.normalizeMetrics(undefined)).toBeUndefined();
  });

  it('keeps only bounded integer maximum item lengths, preserves old rows and redacts metadata rows', () => {
    const values = [undefined, 0, 1, 1_500, 1_501, -1, 0.5, NaN, Infinity, '500', null, Number.MAX_SAFE_INTEGER];
    const metrics = { ...empty, requestCount: values.length, requests: values.map((maxTextChars, index) => ({
      sequence: index + 1, startedAt: 100 + index, textCount: 2, charCount: 1_500, maxTextChars,
      text: 'private source', bodyHash: 'private hash', source_lang: 'private language', account: 'private account',
    })), preparationCount: 1, preparations: [{ sequence: 1, startedAt: 90, endedAt: 95, status: 204, maxTextChars: 500 }] };
    const normalized = benchmark.normalizeMetrics(metrics)!;
    const rows = normalized.requests as Record<string, unknown>[];
    for (const [index, value] of values.entries()) {
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1_500)
        expect(rows[index]).toHaveProperty('maxTextChars', value);
      else expect(rows[index]).not.toHaveProperty('maxTextChars');
    }
    expect((normalized.preparations as Record<string, unknown>[])[0]).not.toHaveProperty('maxTextChars');
    expect(JSON.stringify(normalized)).not.toMatch(/private|bodyHash|source_lang|account/);
    const delta = benchmark.metricsDelta(empty, metrics);
    expect(delta.requests).toEqual(normalized.requests);
    const event = benchmark.normalizeBenchmarkEvent({ phase: 'complete', metrics, navigationMetrics: metrics });
    expect((event.metrics as Record<string, unknown>).requests).toEqual(normalized.requests);
    expect((event.navigationMetrics as Record<string, unknown>).requests).toEqual(normalized.requests);
    rows[3]!.maxTextChars = 0;
    expect((benchmark.normalizeMetrics(metrics)!.requests as Record<string, unknown>[])[3]!.maxTextChars).toBe(1_500);
  });

  it('records request/text/character deltas and the concurrency of this run', () => {
    const before = { ...empty, requestCount: 1, totalTexts: 1, totalChars: 20, maxConcurrent: 32 };
    const after = { ...empty, requestCount: 3, totalTexts: 33, totalChars: 8020, maxConcurrent: 32, statusCounts: { 200: 2 },
      requests: [{ sequence: 2, startedAt: 100, endedAt: 110, textCount: 16, charCount: 4000, status: 200 },
        { sequence: 3, startedAt: 110, endedAt: 120, textCount: 16, charCount: 4000, status: 200 }] };
    expect(benchmark.metricsDelta(before, after)).toMatchObject({ requestCount: 2, totalTexts: 32, totalChars: 8000,
      maxConcurrent: 1, counterReset: false, requestRowsTruncated: false, statusCounts: { 200: 2 } });
  });

  it('defaults missing preparation metrics to zero and redacts their rows independently of translation', () => {
    expect(benchmark.normalizeMetrics(empty)).toMatchObject({ preparationCount: 0, activePreparations: 0, preparations: [] });
    const normalized = benchmark.normalizeMetrics({ ...empty, preparationCount: 1, activePreparations: 0,
      preparations: [{ sequence: 1, startedAt: 100, endedAt: 150, status: 204,
        textCount: 9, charCount: 1000, maxTextChars: 500, body: 'private source', url: 'https://secret.invalid',
        headers: { Cookie: 'private' }, networkTiming: { tlsMs: 12.5, totalMs: 50, protocol: 'h2', server: 'private' } }] });
    expect(normalized).toMatchObject({ requestCount: 0, totalChars: 0, statusCounts: {}, preparationCount: 1,
      preparations: [{ sequence: 1, startedAt: 100, endedAt: 150, status: 204, networkTiming: { tlsMs: 12.5, protocol: 'h2' } }] });
    const row = (normalized!.preparations as Record<string, unknown>[])[0]!;
    expect(row).not.toHaveProperty('textCount'); expect(row).not.toHaveProperty('charCount');
    expect(row).not.toHaveProperty('maxTextChars');
    expect(JSON.stringify(normalized)).not.toMatch(/private|secret|Cookie|headers|server|url|body/);
    expect(benchmark.metricsDelta(empty, normalized)).toMatchObject({ requestCount: 0, statusCounts: {}, errorCounts: {},
      preparationCount: 1, activePreparations: 0, preparations: [{ status: 204 }], preparationRowsTruncated: false });
  });

  it('keeps the full lifecycle of preparation that started before the click baseline', () => {
    const before = { ...empty, preparationCount: 4, activePreparations: 1,
      preparations: [{ sequence: 4, startedAt: 80 }] };
    const after = { ...empty, preparationCount: 4, activePreparations: 0,
      preparations: [{ sequence: 4, startedAt: 80, endedAt: 150, status: 204, networkTiming: { totalMs: 70 } }] };
    expect(benchmark.metricsDelta(before, after)).toMatchObject({ preparationCount: 0, activePreparations: 0,
      preparations: [{ sequence: 4, startedAt: 80, endedAt: 150, status: 204 }], preparationRowsTruncated: false });
    expect(benchmark.metricsDelta(after, after)).toMatchObject({ preparationCount: 0, preparations: [] });
  });

  it('flags restarted and truncated preparation counters without inventing POST requests', () => {
    const normalized = benchmark.normalizeMetrics({ ...empty, preparationCount: 70,
      preparations: Array.from({ length: 70 }, (_, index) => ({ sequence: index + 1, startedAt: index, endedAt: index + 1, status: 204 })) });
    expect(normalized!.preparations).toHaveLength(64);
    expect(benchmark.metricsDelta(empty, normalized)).toMatchObject({ requestCount: 0, preparationCount: 70,
      counterReset: false, preparationCounterReset: false, preparationRowsTruncated: true });
    expect(benchmark.metricsDelta(normalized, empty)).toMatchObject({ counterReset: true, preparationCounterReset: true });
    expect(benchmark.metricsDelta({ ...empty, preparationCount: 1, activePreparations: 1, preparations: [] }, empty))
      .toMatchObject({ preparationRowsTruncated: true });
    expect(benchmark.metricsDelta({ ...empty, preparationCount: 1, activePreparations: 1,
      preparations: [{ sequence: 1, startedAt: 10 }] }, { ...empty, preparationCount: 1 }))
      .toMatchObject({ preparationRowsTruncated: true });
  });

  it('normalizes the actual evidence sink boundary including navigation metrics and safe delta flags', () => {
    const event = benchmark.normalizeBenchmarkEvent({ phase: 'complete', navigationToFirstProseMs: 3000,
      navigationToFullMs: 17000, networkPreparationPermission: true, preClickRequestCount: 0,
      sourceUrl: 'private-url', apiKey: 'secret-key', navigationBeforeMetrics: { private: true },
      navigationMetrics: { ...empty, preparationCount: 1, preparations: [{ sequence: 1, startedAt: 10, endedAt: 20, status: 204, body: 'private' }],
        preparationRowsTruncated: false, counterReset: false, private: 'secret' },
      metrics: { ...empty, rateLimitDiagnostics: [{ at: 10, httpStatus: 429, bodyOutcome: 'json', bodyCompletedAt: 11,
        responseReason: 'concurrency', rateLimitRemaining: 0, message: 'private text' }] } });
    expect(event).toMatchObject({ navigationToFirstProseMs: 3000, navigationToFullMs: 17000, networkPreparationPermission: true,
      navigationMetrics: { preparationCount: 1, preparationRowsTruncated: false, counterReset: false, preparations: [{ status: 204 }] },
      metrics: { rateLimitDiagnostics: [{ responseReason: 'concurrency', rateLimitRemaining: 0 }] } });
    expect(JSON.stringify(event)).not.toMatch(/private|secret|sourceUrl|apiKey|navigationBeforeMetrics|message/);
  });

  it('retains safe RPC rate-limit evidence without copying response bodies or messages', () => {
    const diagnostic = { at: 10, httpStatus: 429, rpcErrorCode: 1042911, retryAfterMs: 60000,
      bodyOutcome: 'json', bodyCompletedAt: 12, body: 'private article', message: 'secret' };
    const normalized = benchmark.normalizeMetrics({ ...empty, rateLimitDiagnostics: [diagnostic] });
    expect(normalized).toMatchObject({ rateLimitDiagnostics: [{ at: 10, rpcErrorCode: 1042911, retryAfterMs: 60000, bodyOutcome: 'json' }] });
    expect(JSON.stringify(normalized)).not.toMatch(/private article|secret/);
    expect(benchmark.metricsDelta(empty, normalized)).toMatchObject({ rateLimitDiagnostics: [{ rpcErrorCode: 1042911 }] });
    expect(benchmark.metricsDelta(normalized, normalized)).toMatchObject({ rateLimitDiagnostics: [] });
  });

  it('does not invent overlap for zero-duration requests and detects restarted counters', () => {
    const after = { ...empty, requestCount: 2, maxConcurrent: 1, requests: [
      { sequence: 1, startedAt: 100, endedAt: 100, textCount: 1, charCount: 10 },
      { sequence: 2, startedAt: 100, endedAt: 100, textCount: 1, charCount: 10 },
    ] };
    expect(benchmark.metricsDelta(empty, after).maxConcurrent).toBe(1);
    expect(benchmark.metricsDelta({ ...empty, requestCount: 10 }, empty).counterReset).toBe(true);
  });

  it('retains only enumerated response clues and literal integer rate headers', () => {
    const result = benchmark.normalizeMetrics({ ...empty, rateLimitDiagnostics: [
      { at: 10, httpStatus: 429, bodyOutcome: 'json', bodyCompletedAt: 11, responseReason: 'quota',
        rateLimitLimit: 30, rateLimitRemaining: 0, rateLimitReset: 12000,
        message: 'private', traceId: 'secret', headers: { Cookie: 'secret' } },
      { at: 12, httpStatus: 429, bodyOutcome: 'json', bodyCompletedAt: 13, responseReason: 'private',
        rateLimitLimit: -1, rateLimitRemaining: 0.5, rateLimitReset: 'secret' },
    ] });
    expect(result).toMatchObject({ rateLimitDiagnostics: [
      { responseReason: 'quota', rateLimitLimit: 30, rateLimitRemaining: 0, rateLimitReset: 12000 },
      { at: 12, httpStatus: 429, bodyOutcome: 'json', bodyCompletedAt: 13 },
    ] });
    expect(JSON.stringify(result)).not.toMatch(/private|secret|Cookie|headers|traceId/);
    expect(benchmark.metricsDelta(empty, result)).toMatchObject({ rateLimitDiagnostics: [
      { responseReason: 'quota', rateLimitRemaining: 0 }, { at: 12 },
    ] });
  });

  it('reports missing diagnostic rows rather than treating them as zero requests', () => {
    expect(benchmark.metricsDelta(empty, { ...empty, requestCount: 300 }).requestRowsTruncated).toBe(true);
    expect(() => benchmark.metricsDelta(empty, undefined)).toThrow('统计不可用');
  });

  it('allows only the fixed numeric and protocol network timing fields and supports old rows', () => {
    const result = benchmark.normalizeMetrics({ ...empty, requestCount: 2, requests: [
      { sequence: 1, networkTiming: { dnsMs: 1, connectMs: 2, tlsMs: 1, waitMs: 5, downloadMs: 3, totalMs: 11,
        protocol: 'h2', url: 'private', server: 'secret' } },
      { sequence: 2, networkTiming: { dnsMs: -1, tlsMs: Infinity, protocol: 'private', extra: 1 } },
    ] });
    expect(result).toMatchObject({ requests: [{ networkTiming: { dnsMs: 1, connectMs: 2, tlsMs: 1, waitMs: 5,
      downloadMs: 3, totalMs: 11, protocol: 'h2' } }, { networkTiming: {} }] });
    expect(JSON.stringify(result)).not.toMatch(/private|secret|extra|Infinity/);
    expect(benchmark.metricsDelta(empty, { ...empty, requestCount: 1, requests: [{ sequence: 1, textCount: 1 }] }))
      .toMatchObject({ requests: [{ sequence: 1, textCount: 1 }] });
  });

  const completedSnapshot = { status: 'done', completed: 2, total: 2, failed: 0, pending: 0, renderedSegments: 2,
    sourceSegments: 2, sourceChars: 100, sourceChanged: false, mappingConflicts: 0, unexpectedTranslations: 0,
    visible: true, focused: true, visibilityFailures: 0, viewportTargets: 1, viewportCompleted: 1,
    firstVisibleProseDomReadyMs: 12, firstVisibleProseRafMs: 16, initialViewportAllDoneMs: 12,
    fullDoneMs: 20, doneAt: 1020, outputFingerprint: 'hash' };
  const coldDelta = { requestCount: 1, totalChars: 100, activeRequests: 0, requests: [{ sequence: 1, startedAt: 1000 }],
    counterReset: false, requestRowsTruncated: false, statusCounts: { 200: 1 }, errorCounts: {} };

  it('accepts full source coverage only after the foreground terminal observation window', () => {
    const input = { snapshot: completedSnapshot, delta: coldDelta, atTerminal: { requestCount: 1 }, observedForMs: 1000,
      pass: 'cold', expectedSourceSegments: 2, expectedSourceChars: 100 };
    expect(benchmark.assessBenchmarkCompletion(input).message).toBeUndefined();
    expect(benchmark.assessBenchmarkCompletion({ ...input, observedForMs: 999 }).message).toMatch(/一秒/);
    expect(benchmark.assessBenchmarkCompletion({ ...input, snapshot: { ...completedSnapshot, visibilityFailures: 1 } }).message).toMatch(/焦点/);
    expect(benchmark.assessBenchmarkCompletion({ ...input, snapshot: { ...completedSnapshot, sourceChars: 90 } }).message).toMatch(/源范围/);
  });

  it('rejects a late request even if it finished before the final metrics snapshot', () => {
    const assessment = benchmark.assessBenchmarkCompletion({ snapshot: completedSnapshot,
      delta: { ...coldDelta, requestCount: 2, requests: [{ sequence: 1, startedAt: 1000 }, { sequence: 2, startedAt: 1021, endedAt: 1030 }] },
      atTerminal: { requestCount: 1 }, observedForMs: 1000, pass: 'cold' });
    expect(assessment).toMatchObject({ lateRequestCount: 1, postTerminalRequestCount: 1 });
    expect(assessment.message).toMatch(/额外翻译请求/);
    expect(benchmark.assessBenchmarkCompletion({ snapshot: completedSnapshot, delta: { ...coldDelta, activeRequests: 1 },
      atTerminal: { requestCount: 1 }, observedForMs: 1000, pass: 'cold' }).message).toMatch(/活动/);
  });

  it('requires warm zero-call coverage from before restore through post-done observation', () => {
    const input = { snapshot: completedSnapshot, delta: { ...coldDelta, requestCount: 0, totalChars: 0, requests: [], statusCounts: {} },
      atTerminal: { requestCount: 42 }, observedForMs: 1100, pass: 'cached',
      cold: { outputFingerprint: 'hash', sourceSegments: 2, sourceChars: 100, total: 2 } };
    expect(benchmark.assessBenchmarkCompletion(input)).toMatchObject({ cacheOutputMatches: true, message: undefined });
    expect(benchmark.assessBenchmarkCompletion({ ...input, delta: { ...input.delta, requestCount: 1 } }).message).toMatch(/恢复原文/);
    expect(benchmark.assessBenchmarkCompletion({ ...input, cold: { ...input.cold, outputFingerprint: 'different' } }).message).toMatch(/输出一致/);
  });

  it('requires successful idle preparations over the entire cold navigation, including before-click failures', () => {
    const input = { snapshot: { ...completedSnapshot, clickedAt: 1000 }, delta: coldDelta,
      navigationDelta: { ...coldDelta, preparationCount: 1, activePreparations: 0,
        preparations: [{ sequence: 1, startedAt: 900, endedAt: 1010, status: 204 }] },
      atTerminal: { requestCount: 1, preparationCount: 1 }, observedForMs: 1000, pass: 'cold' };
    expect(benchmark.assessBenchmarkCompletion(input).message).toBeUndefined();
    expect(benchmark.assessBenchmarkCompletion({ ...input, navigationDelta: { ...input.navigationDelta, activePreparations: 1 } }).message)
      .toMatch(/活动.*连接准备/);
    for (const row of [{ sequence: 1, startedAt: 900, endedAt: 950, status: 405 },
      { sequence: 1, startedAt: 900, endedAt: 950, errorCode: 'NETWORK' }]) {
      expect(benchmark.assessBenchmarkCompletion({ ...input, navigationDelta: { ...input.navigationDelta, preparations: [row] } }).message)
        .toMatch(/未成功的连接准备/);
    }
    expect(benchmark.assessBenchmarkCompletion({ ...input, navigationDelta: { ...input.navigationDelta, preparationRowsTruncated: true } }).message)
      .toMatch(/截断/);
    expect(benchmark.assessBenchmarkCompletion({ ...input, navigationDelta: { ...input.navigationDelta,
      requests: [{ sequence: 1, startedAt: 999, endedAt: 1005 }] } })).toMatchObject({ preClickRequestCount: 1, message: expect.stringMatching(/点击翻译前/) });
  });

  it('does not call a cached pass zero-network if a preparation started or carried into its observation', () => {
    const input = { snapshot: completedSnapshot, delta: { ...coldDelta, requestCount: 0, totalChars: 0, requests: [], statusCounts: {},
      preparationCount: 0, activePreparations: 0, preparations: [] as Record<string, unknown>[] },
      atTerminal: { requestCount: 1, preparationCount: 1 }, observedForMs: 1000, pass: 'cached',
      cold: { outputFingerprint: 'hash', sourceSegments: 2, sourceChars: 100, total: 2 } };
    expect(benchmark.assessBenchmarkCompletion(input).message).toBeUndefined();
    expect(benchmark.assessBenchmarkCompletion({ ...input, delta: { ...input.delta, preparationCount: 1 } }).message).toMatch(/恢复原文/);
    expect(benchmark.assessBenchmarkCompletion({ ...input, delta: { ...input.delta,
      preparations: [{ sequence: 1, startedAt: 900, endedAt: 1010, status: 204 }] } }).message).toMatch(/恢复原文/);
    expect(benchmark.assessBenchmarkCompletion({ ...input, delta: { ...input.delta, activePreparations: 1 } }).message).toMatch(/活动/);
  });

  it('records extra metadata requests after completion instead of hiding them behind zero POSTs', () => {
    expect(benchmark.assessBenchmarkCompletion({ snapshot: completedSnapshot, delta: { ...coldDelta, preparationCount: 1,
      preparations: [{ sequence: 2, startedAt: 1021, endedAt: 1030, status: 204 }] },
      atTerminal: { requestCount: 1, preparationCount: 1 }, observedForMs: 1000, pass: 'cold' }))
      .toMatchObject({ latePreparationCount: 1, postTerminalPreparationCount: 1, message: expect.stringMatching(/额外连接准备/) });
  });

  it('builds a self-contained probe using the production collection and viewport policy without writing output', async () => {
    const source = await benchmark.buildPageProbe();
    expect(source).toContain('snapshotViewportPriorities');
    expect(source).toContain('collectPageSegments');
    expect(source).toContain('__nearInstalledBenchmarkProbe');
    expect(source).not.toMatch(/import\s+.*from/);
  });

  async function runNativeDriverFixture(preClickPost = false) {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const sourceUrl = 'https://go.dev/talks/2012/splash.article?utm_source=chatgpt.com';
    const reports: Record<string, unknown>[] = [];
    let created = false; let clickedAt = 0; let finished = false; let pendingPreparationAtClick = false;
    const preparation = () => ({ sequence: 1, startedAt: 1050,
      ...(finished ? { endedAt: clickedAt + 100, status: 204 } : {}) });
    const currentMetrics = () => ({ ...empty, preparationCount: created ? 1 : 0,
      activePreparations: created && !finished ? 1 : 0, preparations: created ? [preparation()] : [],
      requestCount: clickedAt || preClickPost && created ? 1 : 0,
      totalTexts: clickedAt || preClickPost && created ? 2 : 0,
      totalChars: clickedAt || preClickPost && created ? 100 : 0,
      requests: clickedAt || preClickPost && created
        ? [{ sequence: 1, startedAt: clickedAt ? clickedAt + 1 : 1060, endedAt: clickedAt ? clickedAt + 100 : 1070,
          status: 200, textCount: 2, charCount: 100 }] : [],
      statusCounts: clickedAt || preClickPost && created ? { 200: 1 } : {} });
    const sendMessage = vi.fn(async (message: { type: string }) => {
      if (message.type === 'get-settings') return { translationEngine: 'deepl-web', enabled: true,
        hasApiKey: false, requiresApiKey: false, webAccess: true, apiAccess: true };
      if (message.type === 'get-translation-metrics') return currentMetrics();
      throw new Error('Only public settings and content-free metrics are available.');
    });
    const create = vi.fn(async () => { created = true; vi.setSystemTime(1100); return { id: 7, windowId: 1 }; });
    const remove = vi.fn(async () => {});
    const contains = vi.fn(async () => true);
    const start = vi.fn();
    const executeScript = vi.fn(async (call: { files?: string[]; args?: unknown[] }) => {
      if (call.files) return [];
      const method = call.args?.[1];
      if (method === 'readiness') return [{ result: { navigationStartedAt: 1000, toolbarReadyAt: 1100,
        toolbarReady: true, canStart: true, visible: true, focused: true } }];
      if (method === 'prepare') return [{ result: { sourceSegments: 2, sourceChars: 100, viewportTargets: 1 } }];
      if (method === 'start') {
        pendingPreparationAtClick = currentMetrics().activePreparations === 1;
        clickedAt = Date.now(); start(); return [{ result: true }];
      }
      if (method === 'snapshot') {
        finished = true;
        return [{ result: { ...completedSnapshot, clickedAt, navigationStartedAt: 1000, elapsedMs: Date.now() - clickedAt,
          fullDoneMs: 200, doneAt: clickedAt + 200, firstVisibleProseDomReadyMs: 50,
          firstVisibleProseRafMs: 66, initialViewportAllDoneMs: 100 } }];
      }
      return [{ result: true }];
    });
    vi.stubGlobal('chrome', { runtime: { sendMessage, getManifest: () => ({ version: '0.7.0' }) },
      storage: { session: { get: vi.fn(async () => ({ 'deepl-web:cooldown-until:v1': 0 })) } }, permissions: { contains },
      tabs: { create, get: vi.fn(async () => ({ url: sourceUrl })), remove },
      windows: { update: vi.fn(async () => {}) }, scripting: { executeScript } });
    vi.stubGlobal('document', { querySelector: () => ({ textContent: '' }) });
    vi.stubGlobal('location', { href: 'chrome-extension://test/benchmark.html' });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      expect(url).toBe('http://127.0.0.1/test');
      reports.push(JSON.parse(String(init?.body)));
      return new Response('ok');
    });
    vi.stubGlobal('fetch', fetcher);
    const run = benchmark.browserMain({ endpoint: 'http://127.0.0.1/test', sourceUrl, expectedEngine: 'deepl-web',
      expectedVersion: '0.7.0', probeFile: 'probe.js', deadlineMs: 15000, expectedSourceSegments: 2, expectedSourceChars: 100 });
    await vi.runAllTimersAsync(); await run;
    return { reports, start, contains, sendMessage, pendingPreparationAtClick, create, remove };
  }

  it('captures the native navigation boundary before tab creation and clicks without awaiting an active preparation', async () => {
    const fixture = await runNativeDriverFixture();
    expect(fixture.start).toHaveBeenCalledOnce(); expect(fixture.pendingPreparationAtClick).toBe(true);
    expect(fixture.contains).toHaveBeenCalledExactlyOnceWith({ permissions: ['declarativeNetRequestWithHostAccess'] });
    const final = fixture.reports.at(-1)!;
    expect(final).toMatchObject({ phase: 'complete', passTimerOrigin: 'translation-click', clickedAt: 1100,
      firstVisibleProseDomReadyMs: 50, fullDoneMs: 200, navigationToFirstProseMs: 150, navigationToFullMs: 300,
      preClickRequestCount: 0, preparationRowsTruncated: false,
      metrics: { requestCount: 1, totalChars: 100, preparationCount: 0, activePreparations: 0,
        preparations: [{ sequence: 1, startedAt: 1050, endedAt: 1200, status: 204 }] },
      navigationMetrics: { requestCount: 1, preparationCount: 1, activePreparations: 0,
        preparations: [{ sequence: 1, startedAt: 1050, endedAt: 1200, status: 204 }] } });
    expect(fixture.sendMessage.mock.calls.every(([message]) => ['get-settings', 'get-translation-metrics'].includes(message.type))).toBe(true);
    expect(fixture.remove).toHaveBeenCalledOnce();
  });

  it('refuses to click when a native POST was already sent during navigation', async () => {
    const fixture = await runNativeDriverFixture(true);
    expect(fixture.start).not.toHaveBeenCalled();
    expect(fixture.reports.at(-1)).toMatchObject({ phase: 'error', message: expect.stringMatching(/点击翻译前.*正文/) });
    expect(fixture.remove).toHaveBeenCalledOnce();
  });

  it('inspect reads only public settings and the precise cooldown key without creating a target tab', async () => {
    const create = vi.fn(); const update = vi.fn(); const get = vi.fn(async () => ({ 'deepl-web:cooldown-until:v1': Date.now() + 60000 }));
    const sendMessage = vi.fn(async (message: { type: string }) => message.type === 'get-settings'
      ? { translationEngine: 'deepl-web', enabled: false, hasApiKey: true, webAccess: false } : undefined);
    vi.stubGlobal('chrome', { runtime: { sendMessage, getManifest: () => ({ version: '0.7.0' }) },
      storage: { session: { get } }, tabs: { create, update } });
    vi.stubGlobal('document', { querySelector: () => ({ textContent: '' }) });
    vi.stubGlobal('location', { href: 'chrome-extension://test/inspect.html' });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok'));
    vi.stubGlobal('fetch', fetcher);
    await benchmark.browserMain({ endpoint: 'http://127.0.0.1/test', inspect: true, expectedEngine: 'deepl-web', sourceUrl: 'https://go.dev/talks/2012/splash.article' });
    expect(get).toHaveBeenCalledExactlyOnceWith('deepl-web:cooldown-until:v1');
    expect(sendMessage.mock.calls.map(call => call[0].type)).toEqual(['get-settings', 'get-translation-metrics']);
    expect(create).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
    const report = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(report).toMatchObject({ phase: 'inspect', translationEngine: 'deepl-web', metricsAvailable: false, networkPreparationPermission: false });
    expect(report.cooldownRemainingMs).toBeGreaterThan(0);
  });
});
