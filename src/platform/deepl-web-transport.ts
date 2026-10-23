import { browser } from 'wxt/browser';
import { DEEPL_WEB_ENDPOINT, DEEPL_WEB_ORIGIN, DEEPL_WEB_PERMISSION,
  DEEPL_WEB_PREPARATION_PERMISSION } from '../shared/translation-engine';
import { readNetworkTiming, type NetworkTiming } from './network-timing';

const LEGACY_RULE_ID = 74001;
const PREPARATION_RULE_ID = 74002;
const TIMING_MATCH_MS = 25;

/** Safe platform failure; the background maps it without exposing browser internals. */
export class DeepLWebTransportError extends Error {
  constructor(message = '免费翻译的网络权限尚未就绪，请重新保存设置并授权。') {
    super(message);
    this.name = 'DeepLWebTransportError';
  }
}

export interface DeepLWebNetwork {
  request(body: string, signal: AbortSignal): Promise<Response>;
  /** Optional, explicit HTTP preparation. No text or credentials are sent. */
  prepare(signal: AbortSignal): Promise<Response>;
  /** Reconcile host access and the active engine when settings or permissions change. */
  synchronize(enabled: boolean): Promise<void>;
  /** Bounded, content-free diagnostics for trusted extension pages. */
  metrics(): DeepLWebMetrics;
}

export interface DeepLWebPreparationMetric {
  sequence: number; startedAt: number; endedAt?: number; status?: number;
  errorCode?: 'ABORTED' | 'NETWORK';
  networkTiming?: NetworkTiming;
}
export interface DeepLWebRequestMetric extends DeepLWebPreparationMetric {
  textCount: number; charCount: number; maxTextChars?: number;
}
export interface DeepLWebMetrics {
  requestCount: number; totalTexts: number; totalChars: number;
  activeRequests: number; maxConcurrent: number;
  statusCounts: Record<string, number>; errorCounts: Record<string, number>;
  requests: DeepLWebRequestMetric[];
  preparationCount: number; activePreparations: number;
  preparations: DeepLWebPreparationMetric[];
}

/** One factory instance belongs to the background. Provider scheduling stays in the provider. */
export function createDeepLWebTransport(fetcher?: typeof fetch): DeepLWebNetwork {
  let enabled = false;
  let generation = 0;
  let legacyCleanupAttempted = false;
  let preparationPolicy: string | undefined;
  let preparationRuleReady = false;
  let hadPreparationPermission = false;
  let mutations = Promise.resolve();
  const metrics: DeepLWebMetrics = { requestCount: 0, totalTexts: 0, totalChars: 0,
    activeRequests: 0, maxConcurrent: 0, statusCounts: {}, errorCounts: {}, requests: [],
    preparationCount: 0, activePreparations: 0, preparations: [] };
  const timingStarts = new WeakMap<DeepLWebPreparationMetric, number>();
  const ambiguousTiming = new WeakSet<DeepLWebPreparationMetric>();

  const metricRows = () => [...metrics.requests, ...metrics.preparations];
  const markTimingStart = (metric: DeepLWebPreparationMetric) => {
    try {
      const started = performance.timeOrigin + performance.now();
      timingStarts.set(metric, started);
      // ResourceTiming has no HTTP method. Overlapping matching windows must
      // not attribute a preparation entry to a POST, or vice versa.
      for (const other of metricRows()) {
        if (other === metric) continue;
        const at = timingStarts.get(other);
        if (at !== undefined && Math.abs(at - started) <= TIMING_MATCH_MS * 2) {
          ambiguousTiming.add(metric); ambiguousTiming.add(other);
          delete other.networkTiming;
        }
      }
    } catch { /* Optional diagnostics never affect transport. */ }
  };
  const captureTiming = (metric: DeepLWebPreparationMetric) => {
    if (metric.networkTiming || metric.endedAt === undefined || metric.status === undefined || ambiguousTiming.has(metric)) return;
    const started = timingStarts.get(metric);
    if (started === undefined) return;
    try {
      const entries = performance.getEntriesByName(DEEPL_WEB_ENDPOINT, 'resource').filter(entry =>
        entry.name === DEEPL_WEB_ENDPOINT && entry.entryType === 'resource'
        && Math.abs(performance.timeOrigin + entry.startTime - started) <= TIMING_MATCH_MS);
      if (entries.length !== 1) return;
      metric.networkTiming = readNetworkTiming(DEEPL_WEB_ENDPOINT, started, {
        timeOrigin: performance.timeOrigin, getEntriesByName: () => entries,
      });
    } catch { /* Missing or opaque browser timing is not a request failure. */ }
  };

  const serialize = (operation: () => Promise<void>): Promise<void> => {
    const pending = mutations.catch(() => undefined).then(operation);
    mutations = pending;
    return pending;
  };

  const cleanLegacyRule = async () => {
    if (legacyCleanupAttempted) return;
    legacyCleanupAttempted = true;
    try {
      if (await browser.permissions.contains({ permissions: [DEEPL_WEB_PERMISSION] })) {
        await browser.declarativeNetRequest.updateSessionRules({ removeRuleIds: [LEGACY_RULE_ID] });
      }
    } catch {
      // Migration is best effort: the old rule cannot match the new endpoint.
      // Never make its optional permission a requirement for anonymous translation.
    }
  };

  const preparationPermission = async () => {
    try { return await browser.permissions.contains({ permissions: [DEEPL_WEB_PREPARATION_PERMISSION] }); }
    catch { return false; }
  };

  const reconcilePreparation = async (host: boolean, permission: boolean, allowInstall = true): Promise<boolean> => {
    const policy = `${generation}:${enabled}:${host}:${permission}`;
    const shouldInstall = enabled && host && permission;
    // prepare() may verify a synchronized rule, but must never install one.
    if (shouldInstall && !allowInstall) return preparationRuleReady && preparationPolicy === policy;
    if (preparationPolicy === policy) return preparationRuleReady;
    const shouldRemove = preparationRuleReady || hadPreparationPermission || permission;
    preparationPolicy = policy; preparationRuleReady = false; hadPreparationPermission = permission;
    try {
      if (shouldInstall) {
        await browser.declarativeNetRequest.updateSessionRules({ removeRuleIds: [PREPARATION_RULE_ID], addRules: [{
          id: PREPARATION_RULE_ID, priority: 1,
          condition: { regexFilter: `^${DEEPL_WEB_ENDPOINT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
            isUrlFilterCaseSensitive: true, initiatorDomains: [browser.runtime.id],
            requestMethods: ['options'], resourceTypes: ['xmlhttprequest'] },
          action: { type: 'modifyHeaders', requestHeaders: [
            { header: 'Access-Control-Request-Method', operation: 'set', value: 'POST' },
            { header: 'Access-Control-Request-Headers', operation: 'set', value: 'authorization,content-type' },
          ] },
        }] });
        preparationRuleReady = true;
      } else if (shouldRemove) {
        await browser.declarativeNetRequest.updateSessionRules({ removeRuleIds: [PREPARATION_RULE_ID] });
      }
    } catch {
      // This optional capability must never prevent ordinary POST translation.
      preparationRuleReady = false;
    }
    return preparationRuleReady;
  };

  const hostPermission = async () => {
    try { return await browser.permissions.contains({ origins: [DEEPL_WEB_ORIGIN] }); }
    catch { return false; }
  };

  const reconcileHost = async () => {
    try {
      await cleanLegacyRule();
      if (enabled && !await hostPermission()) throw new DeepLWebTransportError();
    } catch (error) {
      if (error instanceof DeepLWebTransportError) throw error;
      throw new DeepLWebTransportError();
    }
  };

  return {
    metrics() {
      // Resource timing becomes available after the body arrives. Snapshot lazily,
      // without observers, extra requests, or retaining arbitrary page URLs.
      for (const metric of metricRows()) captureTiming(metric);
      return { ...metrics, statusCounts: { ...metrics.statusCounts }, errorCounts: { ...metrics.errorCounts },
        requests: metrics.requests.map(item => ({ ...item, ...(item.networkTiming ? { networkTiming: { ...item.networkTiming } } : {}) })),
        preparations: metrics.preparations.map(item => ({ ...item, ...(item.networkTiming ? { networkTiming: { ...item.networkTiming } } : {}) })) };
    },
    synchronize(nextEnabled) {
      if (enabled !== nextEnabled) { enabled = nextEnabled; generation += 1; }
      return serialize(async () => {
        await cleanLegacyRule();
        const host = enabled ? await hostPermission() : false;
        await reconcilePreparation(host, await preparationPermission());
        if (enabled && !host) throw new DeepLWebTransportError();
      });
    },
    async prepare(signal) {
      signal.throwIfAborted();
      const ownerGeneration = generation;
      if (!enabled) throw new DeepLWebTransportError('免费翻译已停用，无法准备网络连接。');
      await serialize(async () => {
        const host = await hostPermission();
        const permission = await preparationPermission();
        signal.throwIfAborted();
        if (!enabled || generation !== ownerGeneration) throw new DeepLWebTransportError('翻译方式已更改，请重新翻译。');
        if (!await reconcilePreparation(host, permission, false))
          throw new DeepLWebTransportError('可选的网络连接准备尚未就绪。普通翻译仍可使用。');
      });
      signal.throwIfAborted();
      if (!enabled || generation !== ownerGeneration || !preparationRuleReady)
        throw new DeepLWebTransportError('翻译方式已更改，请重新翻译。');
      const metric: DeepLWebPreparationMetric = { sequence: ++metrics.preparationCount, startedAt: Date.now() };
      metrics.activePreparations++; metrics.preparations.push(metric);
      if (metrics.preparations.length > 64) metrics.preparations.shift();
      markTimingStart(metric);
      try {
        const response = await (fetcher ?? globalThis.fetch.bind(globalThis))(DEEPL_WEB_ENDPOINT, {
          method: 'OPTIONS', signal, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store',
        });
        metric.status = response.status;
        return response;
      } catch (error) {
        metric.errorCode = signal.aborted ? 'ABORTED' : 'NETWORK';
        throw error;
      } finally {
        metric.endedAt = Date.now(); metrics.activePreparations--; captureTiming(metric);
      }
    },
    async request(body, signal) {
      signal.throwIfAborted();
      const ownerGeneration = generation;
      if (!enabled) throw new DeepLWebTransportError('免费翻译已停用，请使用当前设置重新翻译。');
      await serialize(reconcileHost);
      signal.throwIfAborted();
      if (!enabled || generation !== ownerGeneration) throw new DeepLWebTransportError('翻译方式已更改，请重新翻译。');
      // The browser supplies its own Origin and User-Agent. No identity rewriting or credentials.
      const counts = { textCount: 0, charCount: 0, maxTextChars: 0 };
      try {
        const texts: unknown = JSON.parse(body)?.text;
        if (Array.isArray(texts)) {
          counts.textCount = texts.length;
          for (const text of texts) {
            const length = typeof text === 'string' ? text.length : 0;
            counts.charCount += length;
            counts.maxTextChars = Math.max(counts.maxTextChars, length);
          }
        }
      } catch { /* Protocol validation belongs to the provider; diagnostics never block a request. */ }
      const metric: DeepLWebRequestMetric = { sequence: ++metrics.requestCount, startedAt: Date.now(), ...counts };
      metrics.totalTexts += counts.textCount; metrics.totalChars += counts.charCount;
      metrics.activeRequests++; metrics.maxConcurrent = Math.max(metrics.maxConcurrent, metrics.activeRequests);
      metrics.requests.push(metric); if (metrics.requests.length > 256) metrics.requests.shift();
      markTimingStart(metric);
      try {
        const response = await (fetcher ?? globalThis.fetch.bind(globalThis))(DEEPL_WEB_ENDPOINT, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'None' }, body, signal,
          credentials: 'omit', redirect: 'error', cache: 'no-store',
        });
        metric.status = response.status;
        metrics.statusCounts[String(response.status)] = (metrics.statusCounts[String(response.status)] ?? 0) + 1;
        return response;
      } catch (error) {
        metric.errorCode = signal.aborted ? 'ABORTED' : 'NETWORK';
        metrics.errorCounts[metric.errorCode] = (metrics.errorCounts[metric.errorCode] ?? 0) + 1;
        throw error;
      } finally { metric.endedAt = Date.now(); metrics.activeRequests--; }
    },
  };
}
