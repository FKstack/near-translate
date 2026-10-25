import { TranslationFailure } from '../core/errors';
import { normalizeTranslationInput } from '../core/input';
import { normalizeChineseVariant } from '../core/chinese-variants';
import type { TranslationEvent, TranslationInput, TranslationProvider } from '../shared/contracts';
import { DEEPL_WEB_LIMITS } from '../shared/translation-policy';
import { resolveLanguagePair, type LanguagePair } from '../shared/languages';
import { RequestScheduler, RequestSchedulingFailure, type RequestContext } from './request-scheduler';

export type DeepLWebTransport = (body: string, signal: AbortSignal) => Promise<Response>;
export interface DeepLWebDiagnostic {
  at: number;
  httpStatus: number;
  /** Historical field name; safe integer from error.code or top-level code. */
  rpcErrorCode?: number;
  /** A coarse hint from known error fields, not a verified limiting cause. */
  responseReason?: 'rate-limit' | 'quota' | 'concurrency' | 'payload-limit' | 'authentication';
  /** Literal nonnegative integers from the named headers; no unit inference. */
  rateLimitLimit?: number;
  rateLimitRemaining?: number;
  rateLimitReset?: number;
  retryAfterMs?: number;
  bodyOutcome: 'json' | 'empty' | 'non-json' | 'truncated' | 'timeout' | 'read-error' | 'aborted';
  bodyCompletedAt: number;
}
export interface DeepLWebProviderOptions {
  clock?: () => number;
  intervalMs?: number;
  cooldownMs?: number;
  maxConcurrent?: number;
  maxQueuedRequests?: number;
  /** Optional shared start budget; never refunds already issued requests. */
  startWindow?: { maxStarts: number; durationMs: number };
  loadCooldownUntil?: () => Promise<number>;
  persistCooldownUntil?: (until: number) => Promise<void>;
  onDiagnostic?: (diagnostic: DeepLWebDiagnostic) => void;
  /** Optional metadata-only request; browser details remain in the transport. */
  prepareTransport?: (signal: AbortSignal) => Promise<Response>;
  /** Reserves a conservative local attempt before admission to the shared queue. */
  reservePreparation?: () => Promise<boolean>;
}

const { maxBatchChars: MAX_BATCH_CHARS, maxBatchItems: MAX_BATCH_ITEMS,
  maxRequestBytes: MAX_REQUEST_BYTES, maxResponseBytes: MAX_RESPONSE_BYTES } = DEEPL_WEB_LIMITS;
const MAX_DIAGNOSTIC_BYTES = 8 * 1024;
const DIAGNOSTIC_TIMEOUT_MS = 1_000;
const MIN_INTERVAL_MS = 100;
const DEFAULT_INTERVAL_MS = 1_050;
const MIN_COOLDOWN_MS = 60_000;
const PREPARATION_TIMEOUT_MS = 5_000;
const CANCELLED = () => new DOMException('翻译请求已取消。', 'AbortError');
const limited = (retryAt: number) => new TranslationFailure('RATE_LIMIT', 'DeepL 请求受限，已暂停后续翻译，请稍后手动重试。', true, retryAt);
const invalid = () => new TranslationFailure('INVALID_RESPONSE', 'DeepL 返回的译文不完整或格式不正确，请稍后重试。', true);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function checkAbort(signal: AbortSignal): void { if (signal.aborted) throw CANCELLED(); }

type DiagnosticBodyClues = Pick<DeepLWebDiagnostic, 'rpcErrorCode' | 'responseReason'>;
type DiagnosticBodyObservation = DiagnosticBodyClues & Pick<DeepLWebDiagnostic, 'bodyOutcome'>;

/** Never retain arbitrary error strings, identifiers or recursively nested data. */
function diagnosticBodyClues(payload: unknown): DiagnosticBodyClues {
  if (!record(payload)) return {};
  const nested = record(payload.error) ? payload.error : undefined;
  const code = typeof nested?.code === 'number' && Number.isSafeInteger(nested.code) ? nested.code : payload.code;
  const strings: string[] = [];
  for (const object of [payload, nested]) {
    if (!object) continue;
    for (const key of ['message', 'detail', 'type', 'error']) {
      const value = object[key];
      if (typeof value === 'string') strings.push(value.toLowerCase().replace(/[_-]+/g, ' ').trim());
    }
  }
  // Specific hints take precedence over a generic "too many requests" wrapper.
  const known: [NonNullable<DeepLWebDiagnostic['responseReason']>, RegExp][] = [
    ['quota', /^(?:quota)$|\bquota (?:exceeded|exhausted|limit\b)|\b(?:exceeded|exhausted) (?:the )?quota\b/],
    ['concurrency', /^(?:concurrency)$|\bconcurrency limit\b|\b(?:too many|maximum|limit of) concurrent (?:requests|translations)\b/],
    ['payload-limit', /^(?:payload limit)$|\b(?:payload|request entity) too large\b|\b(?:char(?:acter)?|text size|content length) limit (?:exceeded|reached)\b/],
    ['authentication', /^(?:authentication)$|\b(?:unauthorized|unauthenticated)\b|\b(?:invalid|missing|expired) (?:authentication|authorization|credentials|access token)\b|\bauthentication (?:failed|required)\b/],
    ['rate-limit', /\brate limit(?:ed|ing)?\b|\btoo many requests\b/],
  ];
  const responseReason = known.find(([, pattern]) => strings.some(value => pattern.test(value)))?.[0];
  return { ...(typeof code === 'number' && Number.isSafeInteger(code) ? { rpcErrorCode: code } : {}),
    ...(responseReason ? { responseReason } : {}) };
}

function diagnosticIntegerHeader(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

interface SourcePart { segment: number; part: number; text: string }

/** Split without dropping source characters, preferring sentence/whitespace boundaries. */
function splitText(text: string): string[] {
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > MAX_BATCH_CHARS) {
    const prefix = remaining.slice(0, MAX_BATCH_CHARS);
    let boundary = 0;
    for (const match of prefix.matchAll(/[.!?。！？](?:["'”’)]*)\s+|\n+/g)) {
      const end = match.index! + match[0].length;
      if (end >= MAX_BATCH_CHARS / 2) boundary = end;
    }
    if (!boundary) for (const match of prefix.matchAll(/\s+/g)) {
      const end = match.index! + match[0].length;
      if (end >= MAX_BATCH_CHARS / 2) boundary = end;
    }
    if (!boundary) boundary = MAX_BATCH_CHARS;
    const before = remaining.charCodeAt(boundary - 1);
    const after = remaining.charCodeAt(boundary);
    if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) boundary--;
    parts.push(remaining.slice(0, boundary));
    remaining = remaining.slice(boundary);
  }
  if (remaining) parts.push(remaining);
  return parts;
}

/**
 * Anonymous oneshot text-array protocol, implemented independently. Browser
 * permissions, headers and client identity belong to the injected transport.
 * No legacy JSON-RPC fallback or third-party client impersonation is used.
 */
export class DeepLWebProvider implements TranslationProvider {
  private readonly clock: () => number;
  private readonly cooldownMs: number;
  private readonly onDiagnostic?: (diagnostic: DeepLWebDiagnostic) => void;
  private readonly prepareTransport?: (signal: AbortSignal) => Promise<Response>;
  private readonly reservePreparation?: () => Promise<boolean>;
  private readonly scheduler: RequestScheduler<string[]>;
  private preparation?: { controller: AbortController; completion: Promise<void> };

  constructor(private readonly transport: DeepLWebTransport, options: DeepLWebProviderOptions = {}) {
    this.clock = options.clock ?? (() => Date.now());
    this.cooldownMs = Math.max(MIN_COOLDOWN_MS, options.cooldownMs ?? MIN_COOLDOWN_MS);
    this.onDiagnostic = options.onDiagnostic;
    this.prepareTransport = options.prepareTransport;
    this.reservePreparation = options.reservePreparation;
    const interval = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.scheduler = new RequestScheduler({ clock: this.clock,
      intervalMs: Number.isNaN(interval) ? MIN_INTERVAL_MS : Math.max(MIN_INTERVAL_MS, interval),
      maxConcurrent: options.maxConcurrent, maxQueuedRequests: options.maxQueuedRequests,
      startWindow: options.startWindow,
      loadCooldownUntil: options.loadCooldownUntil, persistCooldownUntil: options.persistCooldownUntil,
    });
  }

  /** Best-effort metadata preparation, sharing translation's network lifetime and budgets. */
  prepareNetwork(): Promise<void> {
    if (!this.prepareTransport) return Promise.resolve();
    if (this.preparation) return this.preparation.completion;
    const controller = new AbortController();
    let complete!: () => void;
    const owner = { controller, completion: new Promise<void>(resolve => { complete = resolve; }) };
    this.preparation = owner;
    let executing = false;
    const timeout = setTimeout(() => controller.abort(), PREPARATION_TIMEOUT_MS);
    const finishPublic = () => { clearTimeout(timeout); complete(); };
    const release = () => {
      if (this.preparation === owner) this.preparation = undefined;
      finishPublic();
    };
    controller.signal.addEventListener('abort', finishPublic, { once: true });
    void (async () => {
      try {
        // A denied reservation must not consume the shared rolling start budget.
        if (this.reservePreparation && !await this.reservePreparation()) return;
        checkAbort(controller.signal);
        await this.scheduler.run(async context => {
          executing = true;
          try { return await this.requestPreparation(context); }
          finally { release(); }
        }, controller.signal);
      } catch { /* Preparation never replaces or retries a user's translation. */ }
      finally {
        controller.signal.removeEventListener('abort', finishPublic);
        finishPublic();
        // A public abort can settle run() before an ignored transport abort or
        // response cancellation finishes. Its owner remains until execute ends.
        if (!executing) release();
      }
    })();
    return owner.completion;
  }

  cancelPreparation(): void { this.preparation?.controller.abort(); }

  /** Read shared persisted cooldown without preparing a connection or translating text. */
  async getServiceStatus(): Promise<{ cooldownUntil: number }> {
    try { return { cooldownUntil: await this.scheduler.getCooldownUntil() }; }
    catch (error) { throw this.schedulingFailure(error); }
  }

  private async requestPreparation(context: RequestContext): Promise<string[]> {
    const { signal } = context;
    checkAbort(signal);
    const response = await this.prepareTransport!(signal);
    if (signal.aborted) { await response.body?.cancel().catch(() => {}); throw CANCELLED(); }
    if (response.status === 429) {
      const at = this.clock();
      const retryAfter = response.headers.get('retry-after');
      const persisted = context.pauseFor(this.cooldownDelay(retryAfter));
      let cleanup = Promise.resolve();
      // A storage failure must not release preparation while diagnostics still read.
      const [persistence] = await Promise.allSettled([persisted,
        this.diagnoseRateLimit(response, signal, at, retryAfter, cancellation => { cleanup = cancellation; })]);
      await cleanup;
      if (persistence.status === 'rejected') throw persistence.reason;
      throw limited((await this.getServiceStatus()).cooldownUntil);
    }
    // Metadata is never interpreted as translation or retained for diagnostics.
    await response.body?.cancel().catch(() => {});
    checkAbort(signal);
    if (!response.ok) throw this.httpFailure(response.status);
    return [];
  }

  async *translate(rawInput: TranslationInput, signal: AbortSignal,
    beforeRequest?: () => Promise<void>): AsyncIterable<TranslationEvent> {
    checkAbort(signal);
    if (rawInput.task === 'sentence-analysis') {
      throw new TranslationFailure('CONFIG', 'DeepL 网页翻译仅提供译文，不支持长难句拆解；可切换到模型 API 使用该功能。');
    }
    const input = normalizeTranslationInput(rawInput);
    const languages = Object.freeze(resolveLanguagePair(input));
    const sources = input.pageSegments ?? [input.text];
    const parts = sources.map(splitText);
    const translated = parts.map(segment => segment.map(part => part.trim() ? undefined : part));
    const batches: SourcePart[][] = [];
    let batch: SourcePart[] = [];
    let characters = 0;
    for (const [segment, sourceParts] of parts.entries()) {
      for (const [part, text] of sourceParts.entries()) {
        if (!text.trim()) continue;
        if (batch.length && (batch.length >= MAX_BATCH_ITEMS || characters + text.length > MAX_BATCH_CHARS)) {
          batches.push(batch); batch = []; characters = 0;
        }
        characters += text.length;
        batch.push({ segment, part, text });
      }
    }
    if (batch.length) batches.push(batch);
    const translations: string[] = [];
    let nextSegment = 0;
    for (const pending of batches) {
      checkAbort(signal);
      // A queue entry belongs to this input only. Validate the entire response
      // before applying any of its positions to the local segment/part mapping.
      const texts = await this.enqueue(pending.map(part => part.text), languages, signal, beforeRequest);
      checkAbort(signal);
      pending.forEach(({ segment, part, text }, index) => {
        let value = texts[index]!;
        const separator = part < parts[segment]!.length - 1 ? /\s+$/.exec(text)?.[0] : undefined;
        if (separator) value = value.trimEnd() + separator;
        translated[segment]![part] = value;
      });
      while (nextSegment < sources.length && translated[nextSegment]!.every(part => part !== undefined)) {
        checkAbort(signal);
        // Phrase-aware conversion must see all translated parts of this source segment.
        const translation = normalizeChineseVariant(translated[nextSegment]!.join(''), languages.targetLanguage);
        if (!translation.trim()) throw invalid();
        translations.push(translation);
        const index = nextSegment++;
        if (input.pageSegments) yield { type: 'segment', index, text: translation };
      }
    }
    checkAbort(signal);
    yield { type: 'result', result: { kind: 'text', translation: translations.join('\n\n'),
      ...(input.pageSegments ? { segments: translations } : {}) } };
  }

  private async enqueue(texts: string[], languages: Readonly<LanguagePair>, signal: AbortSignal,
    beforeRequest?: () => Promise<void>): Promise<string[]> {
    try { return await this.scheduler.run(context => this.request(texts, languages, context, beforeRequest), signal); }
    catch (error) {
      if (error instanceof RequestSchedulingFailure && error.kind === 'RATE_LIMIT') {
        throw limited((await this.getServiceStatus()).cooldownUntil);
      }
      throw this.schedulingFailure(error);
    }
  }

  private schedulingFailure(error: unknown): unknown {
    if (!(error instanceof RequestSchedulingFailure)) return error;
    if (error.kind === 'QUEUE_FULL') return new TranslationFailure('RATE_LIMIT', '等待 DeepL 翻译的任务较多，请稍后手动重试。', true);
    if (error.kind === 'LOAD_STATE') return new TranslationFailure('CONFIG', '无法读取 DeepL 的限流状态，已暂停该服务；请重新加载扩展后重试。');
    if (error.kind === 'SAVE_STATE') return new TranslationFailure('CONFIG', '无法保存 DeepL 的限流状态，已暂停该服务；请重新加载扩展后重试。');
    return new TranslationFailure('CONFIG', 'DeepL 翻译服务已停止，请重新加载扩展后重试。');
  }

  private cooldownDelay(retryAfter: string | null): number {
    let delay = this.cooldownMs;
    if (retryAfter) {
      const seconds = /^\d+(?:\.\d+)?$/.test(retryAfter.trim()) ? Number(retryAfter) : NaN;
      const suggested = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - this.clock();
      if (Number.isFinite(suggested)) delay = Math.max(delay, suggested);
    }
    return delay;
  }

  private async request(texts: string[], languages: Readonly<LanguagePair>, context: RequestContext,
    beforeRequest?: () => Promise<void>): Promise<string[]> {
    const { signal } = context;
    try {
      checkAbort(signal);
      // Chinese source variants share DeepL's source code; target variants stay distinct.
      const sourceLanguage = languages.sourceLanguage.startsWith('zh-') ? 'zh' : languages.sourceLanguage;
      const body = JSON.stringify({ text: texts, target_lang: languages.targetLanguage,
        ...(sourceLanguage !== 'auto' ? { source_lang: sourceLanguage } : {}) });
      if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES) {
        throw new TranslationFailure('INVALID_INPUT', 'DeepL 翻译请求内容过大，请缩短选区后重试。');
      }
      // A caller's configuration may change while this batch waits for a slot
      // or start window. Revalidate after admission, immediately before I/O.
      if (beforeRequest) await beforeRequest();
      checkAbort(signal);
      const response = await this.transport(body, signal);
      if (signal.aborted) { await response.body?.cancel().catch(() => {}); throw CANCELLED(); }
      if (response.status === 429) {
        const at = this.clock();
        const retryAfter = response.headers.get('retry-after');
        // Flush pending work and start persistence before optional error-body diagnostics.
        const persisted = context.pauseFor(this.cooldownDelay(retryAfter));
        await Promise.all([persisted, this.diagnoseRateLimit(response, signal, at, retryAfter)]);
        throw limited((await this.getServiceStatus()).cooldownUntil);
      }
      const raw = await this.readResponse(response, signal);
      let payload: unknown;
      try { payload = JSON.parse(raw); }
      catch { if (!response.ok) throw this.httpFailure(response.status); throw invalid(); }
      if (record(payload) && record(payload.error) && typeof payload.error.message === 'string'
        && /too\s+many\s+requests/i.test(payload.error.message)) {
        await context.pauseFor(this.cooldownDelay(response.headers.get('retry-after')));
        throw limited((await this.getServiceStatus()).cooldownUntil);
      }
      if (!response.ok) throw this.httpFailure(response.status);
      if (!record(payload) || 'error' in payload) throw invalid();
      if (!Array.isArray(payload.translations) || payload.translations.length !== texts.length) throw invalid();
      const translations = payload.translations.map((item: unknown) => {
        if (!record(item) || typeof item.text !== 'string' || !item.text.trim()) throw invalid();
        return item.text;
      });
      checkAbort(signal);
      return translations;
    } catch (error) {
      if (signal.aborted) throw CANCELLED();
      if (error instanceof RequestSchedulingFailure) throw error;
      if (error instanceof TranslationFailure || (error instanceof Error && error.name === 'DeepLWebTransportError')) throw error;
      if (error instanceof TypeError) throw new TranslationFailure('NETWORK', '无法连接 DeepL 网页翻译，请检查网络后重试。', true);
      throw new TranslationFailure('SERVER', 'DeepL 网页翻译暂时失败，请稍后重试。', true);
    }
  }

  /** A bounded observation only; raw upstream text never leaves the provider. */
  private async diagnoseRateLimit(response: Response, signal: AbortSignal, at: number, retryAfter: string | null,
    onCancellation?: (cleanup: Promise<void>) => void): Promise<void> {
    let observation: DiagnosticBodyObservation;
    try { observation = await this.readDiagnosticBody(response, signal, onCancellation); }
    catch { observation = { bodyOutcome: signal.aborted ? 'aborted' : 'read-error' }; }
    let retryAfterMs: number | undefined;
    if (retryAfter) {
      const seconds = /^\d+(?:\.\d+)?$/.test(retryAfter.trim()) ? Number(retryAfter) : NaN;
      const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - at;
      if (Number.isFinite(delay)) retryAfterMs = Math.max(0, delay);
    }
    const headerClues: Pick<DeepLWebDiagnostic, 'rateLimitLimit' | 'rateLimitRemaining' | 'rateLimitReset'> = {};
    for (const [header, field] of [['ratelimit-limit', 'rateLimitLimit'], ['ratelimit-remaining', 'rateLimitRemaining'],
      ['ratelimit-reset', 'rateLimitReset']] as const) {
      const value = diagnosticIntegerHeader(response.headers.get(header));
      if (value !== undefined) headerClues[field] = value;
    }
    const diagnostic: DeepLWebDiagnostic = { at, httpStatus: response.status, ...observation, ...headerClues,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}), bodyCompletedAt: this.clock() };
    try { this.onDiagnostic?.(diagnostic); }
    catch { /* Observability cannot change the rate-limit or cancellation result. */ }
  }

  private readDiagnosticBody(response: Response, signal: AbortSignal,
    onCancellation?: (cleanup: Promise<void>) => void): Promise<DiagnosticBodyObservation> {
    return new Promise(resolve => {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const finish = (bodyOutcome: DeepLWebDiagnostic['bodyOutcome'], clues: DiagnosticBodyClues = {}) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout); signal.removeEventListener('abort', onAbort);
        // Observation stays bounded. Preparation can retain its separate owner
        // until this cleanup finishes without delaying diagnostic publication.
        try {
          const cleanup = reader?.cancel().catch(() => {});
          if (cleanup) onCancellation?.(cleanup);
        } catch { /* Best-effort cleanup. */ }
        try { reader?.releaseLock(); } catch { /* A failed stream may have already released it. */ }
        resolve({ bodyOutcome, ...clues });
      };
      const onAbort = () => finish('aborted');
      if (signal.aborted) { finish('aborted'); return; }
      if (!response.body) { finish('empty'); return; }
      try { reader = response.body.getReader(); }
      catch { finish('read-error'); return; }
      signal.addEventListener('abort', onAbort, { once: true });
      timeout = setTimeout(() => finish('timeout'), DIAGNOSTIC_TIMEOUT_MS);
      void (async () => {
        const decoder = new TextDecoder();
        let bytes = 0;
        let text = '';
        try {
          for (;;) {
            const { done, value } = await reader!.read();
            if (settled) return;
            if (done) break;
            // A browser may deliver one oversized chunk; never retain or decode its excess.
            if (value.byteLength > MAX_DIAGNOSTIC_BYTES - bytes) { finish('truncated'); return; }
            bytes += value.byteLength; text += decoder.decode(value, { stream: true });
          }
          text += decoder.decode();
          if (!text.trim()) { finish('empty'); return; }
          let payload: unknown;
          try { payload = JSON.parse(text); }
          catch { finish('non-json'); return; }
          finish('json', diagnosticBodyClues(payload));
        } catch { finish(signal.aborted ? 'aborted' : 'read-error'); }
      })();
    });
  }

  private async readResponse(response: Response, signal: AbortSignal): Promise<string> {
    if (!response.body) return '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let cancellation: Promise<void> | undefined;
    const cancel = () => { cancellation ??= reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', cancel, { once: true });
    let length = 0;
    let text = '';
    try {
      checkAbort(signal);
      for (;;) {
        const { done, value } = await reader.read();
        checkAbort(signal);
        if (done) break;
        length += value.length;
        if (length > MAX_RESPONSE_BYTES) throw invalid();
        text += decoder.decode(value, { stream: true });
      }
      return text + decoder.decode();
    } finally {
      signal.removeEventListener('abort', cancel);
      // Reuse the original cancellation promise. A second reader.cancel() on an
      // already closed stream can resolve before its underlying cancel finishes.
      cancel();
      await cancellation;
      reader.releaseLock();
    }
  }

  private httpFailure(status: number): TranslationFailure {
    if (status === 401 || status === 403) return new TranslationFailure('AUTH', 'DeepL 网页服务暂时拒绝访问，请稍后重试或切换翻译服务。');
    if (status === 400 || status === 404 || status === 422) return new TranslationFailure('CONFIG', 'DeepL 网页翻译请求暂不兼容，请更新扩展或切换翻译服务。');
    if (status === 408 || status === 504) return new TranslationFailure('TIMEOUT', 'DeepL 网页翻译响应超时，请稍后重试。', true);
    return new TranslationFailure('SERVER', `DeepL 网页翻译暂时不可用（HTTP ${status}），请稍后重试。`, true);
  }
}
