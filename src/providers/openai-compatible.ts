import {
  type TranslationEvent,
  type TranslationInput,
  type TranslationProvider,
  type WordResult,
  type WordSense,
} from '../shared/contracts';
import { httpFailure, TranslationFailure } from '../core/errors';
import { normalizeTranslationInput } from '../core/input';
import { buildTranslationMessages } from '../core/prompts';
import { PageBatchDecoder } from '../core/page-batch';
import { WordPreviewDecoder } from '../core/word-preview';
import { parseSentenceAnalysis } from '../core/sentence-analysis';
import { SseDecoder } from './sse';
import { completionEndpoint } from '../shared/api-config';

export const HEADER_TIMEOUT_MS = 25_000;
export const STREAM_IDLE_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_LENGTH = 100_000;

export interface OpenAICompatibleConfiguration {
  apiKey: string;
  model: string;
  baseUrl: string;
  provider?: string;
  jsonMode?: boolean;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Aborted', 'AbortError');
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

/** Also handles injected transports which do not themselves react to AbortSignal. */
async function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => undefined);
    throw abortReason(signal);
  }
  let listener: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    listener = () => reject(abortReason(signal));
    signal.addEventListener('abort', listener, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (listener) signal.removeEventListener('abort', listener);
  }
}

async function* streamEvents(body: ReadableStream<Uint8Array>, controller: AbortController): AsyncGenerator<string> {
  const reader = body.getReader();
  const utf8 = new TextDecoder();
  const framing = new SseDecoder();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(
      new TranslationFailure('TIMEOUT', '翻译服务响应中断，请重试。', true),
    ), STREAM_IDLE_TIMEOUT_MS);
  };
  try {
    armIdleTimer();
    while (true) {
      const chunk = await withAbort(reader.read(), controller.signal);
      throwIfAborted(controller.signal);
      if (chunk.done) {
        for (const event of framing.push(utf8.decode())) yield event;
        for (const event of framing.finish()) yield event;
        return;
      }
      if (chunk.value.byteLength) armIdleTimer();
      for (const event of framing.push(utf8.decode(chunk.value, { stream: true }))) yield event;
    }
  } finally {
    clearTimeout(idleTimer);
    // Cancel rather than drain a failed, completed, or superseded response.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseWordResult(content: string): WordResult {
  let value: unknown;
  try { value = JSON.parse(content); }
  catch { throw new TranslationFailure('INVALID_RESPONSE', '单词译文格式不正确，请重试。', true); }
  if (!record(value)) throw new TranslationFailure('INVALID_RESPONSE', '单词译文格式不正确，请重试。', true);
  const { translation, partOfSpeech, explanation, senses } = value;
  if (typeof translation !== 'string' || !translation.trim()
    || typeof partOfSpeech !== 'string' || !partOfSpeech.trim()
    || typeof explanation !== 'string' || !explanation.trim()) {
    throw new TranslationFailure('INVALID_RESPONSE', '单词译文缺少词义、词性或解释，请重试。', true);
  }
  if (!Array.isArray(senses) || senses.length < 1 || senses.length > 10) {
    throw new TranslationFailure('INVALID_RESPONSE', '单词译文的常见义项不完整，请重试。', true);
  }
  const dictionarySenses: WordSense[] = [];
  const seen = new Set<string>();
  for (const sense of senses) {
    if (!record(sense) || typeof sense.partOfSpeech !== 'string' || !sense.partOfSpeech.trim()
      || typeof sense.meaning !== 'string' || !sense.meaning.trim()) {
      throw new TranslationFailure('INVALID_RESPONSE', '单词译文的常见义项格式不正确，请重试。', true);
    }
    const normalized = { partOfSpeech: sense.partOfSpeech.trim(), meaning: sense.meaning.trim() };
    const signature = JSON.stringify([normalized.partOfSpeech, normalized.meaning]);
    if (!seen.has(signature)) {
      seen.add(signature);
      dictionarySenses.push(normalized);
    }
  }
  return {
    kind: 'word', translation: translation.trim(), partOfSpeech: partOfSpeech.trim(),
    explanation: explanation.trim(), senses: dictionarySenses,
  };
}

function finishFailure(reason: string): TranslationFailure {
  if (reason === 'length') return new TranslationFailure('INVALID_RESPONSE', '译文被截断，请缩短选区后重试。', true);
  if (reason === 'insufficient_system_resource' || reason === 'aborted') {
    return new TranslationFailure('SERVER', '翻译服务中断了生成，请稍后重试。', true);
  }
  return new TranslationFailure('INVALID_RESPONSE', '翻译服务未能完整翻译此内容，请重新选择。');
}

export class OpenAICompatibleProvider implements TranslationProvider {
  constructor(
    private readonly configuration: OpenAICompatibleConfiguration,
    private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {}

  async *translate(rawInput: TranslationInput, signal: AbortSignal): AsyncIterable<TranslationEvent> {
    throwIfAborted(signal);
    const input = normalizeTranslationInput(rawInput);
    const apiKey = this.configuration.apiKey.trim();
    const model = this.configuration.model.trim();
    if (/[\r\n]/.test(this.configuration.apiKey) || (!apiKey && this.configuration.provider && !['custom', 'ollama'].includes(this.configuration.provider))) throw new TranslationFailure('CONFIG', '请先在设置中填写有效的 API Key。');
    if (!model) throw new TranslationFailure('CONFIG', '请先在设置中填写模型名称。');

    let endpoint: string;
    try { endpoint = completionEndpoint(this.configuration.baseUrl); }
    catch { throw new TranslationFailure('CONFIG', '请先在设置中填写有效的 API Base URL。'); }
    const maxTokens = input.task === 'sentence-analysis' ? 4096 : input.kind === 'word' ? 2048 : input.pageSegments
      ? Math.min(8192, Math.max(1024, Math.ceil(input.text.length * 1.25) + input.pageSegments.length * 32)) : 8192;
    const controller = new AbortController();
    const onAbort = () => controller.abort(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    let headerTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      headerTimer = setTimeout(() => controller.abort(
        new TranslationFailure('TIMEOUT', '翻译服务连接超时，请检查网络后重试。', true),
      ), HEADER_TIMEOUT_MS);
      const response = await withAbort(this.fetcher(endpoint, {
        method: 'POST',
        headers: {
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          'Content-Type': 'application/json', Accept: 'text/event-stream',
          ...(this.configuration.provider === 'gemini' ? { 'x-goog-api-client': 'near-translate/0.7.0' } : {}),
        },
        body: JSON.stringify({
          model,
          messages: buildTranslationMessages(input),
          ...(this.configuration.provider === 'deepseek' ? { thinking: { type: 'disabled' }, temperature: 0.2 } : {}),
          [this.configuration.provider === 'openai' ? 'max_completion_tokens' : 'max_tokens']: maxTokens,
          stream: true,
          ...(this.configuration.jsonMode && (input.kind === 'word' || input.task === 'sentence-analysis') ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: controller.signal,
        credentials: 'omit',
        redirect: 'error',
      }), controller.signal);
      clearTimeout(headerTimer);
      headerTimer = undefined;
      throwIfAborted(controller.signal);
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw httpFailure(response.status);
      }
      if (!response.body) throw new TranslationFailure('INVALID_RESPONSE', '翻译服务返回了空响应，请重试。', true);

      let content = '';
      const batch = input.pageSegments ? new PageBatchDecoder(input.pageSegments.length) : undefined;
      const word = input.kind === 'word' && input.task !== 'sentence-analysis' ? new WordPreviewDecoder() : undefined;
      let responding = false;
      let completed = false;
      let finishReason: string | undefined;
      for await (const data of streamEvents(response.body, controller)) {
        throwIfAborted(controller.signal);
        if (data.trim() === '[DONE]') {
          completed = true;
          break;
        }
        let payload: unknown;
        try { payload = JSON.parse(data); }
        catch { throw new TranslationFailure('INVALID_RESPONSE', '翻译服务响应格式不正确，请重试。', true); }
        if (!record(payload)) throw new TranslationFailure('INVALID_RESPONSE', '翻译服务响应格式不正确，请重试。', true);
        if ('error' in payload) throw new TranslationFailure('SERVER', '翻译服务返回服务错误，请稍后重试。', true);
        if (!Array.isArray(payload.choices)) throw new TranslationFailure('INVALID_RESPONSE', '翻译服务响应缺少翻译内容，请重试。', true);
        if (payload.choices.length === 0) continue; // Compatibility with usage-only SSE chunks.
        const choice: unknown = payload.choices[0];
        if (!record(choice) || !record(choice.delta)) throw new TranslationFailure('INVALID_RESPONSE', '翻译服务响应格式不正确，请重试。', true);
        const delta = choice.delta.content;
        if (delta !== undefined && delta !== null && typeof delta !== 'string') {
          throw new TranslationFailure('INVALID_RESPONSE', '翻译服务响应格式不正确，请重试。', true);
        }
        // A real model event, including the initial role-only chunk, ends connection waiting.
        // Keep raw dictionary JSON private; only closed fields may be previewed below.
        if (word && !responding) {
          responding = true;
          yield { type: 'progress' };
          throwIfAborted(controller.signal);
        }
        if (typeof delta === 'string' && delta) {
          if (finishReason) throw new TranslationFailure('INVALID_RESPONSE', '翻译服务响应结束标记异常，请重试。', true);
          content += delta;
          if (content.length > MAX_OUTPUT_LENGTH) throw new TranslationFailure('INVALID_RESPONSE', '译文过长，请缩短选区后重试。', true);
          if (word) {
            const preview = word.push(delta);
            if (preview) yield { type: 'word-preview', preview };
          } else if (batch) {
            for (const entry of batch.push(delta)) yield { type: 'segment', ...entry };
          } else if (input.kind === 'text' && input.task !== 'sentence-analysis') yield { type: 'delta', text: delta };
        }
        if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
          if (typeof choice.finish_reason !== 'string') throw new TranslationFailure('INVALID_RESPONSE', '翻译服务响应结束标记异常，请重试。', true);
          finishReason = choice.finish_reason;
          if (finishReason !== 'stop') throw finishFailure(finishReason);
        }
      }
      throwIfAborted(controller.signal);
      if (finishReason !== 'stop' || (this.configuration.provider === 'deepseek' && !completed)) {
        throw new TranslationFailure('INVALID_RESPONSE', '翻译服务响应未完整结束，请重试。', true);
      }
      if (!content.trim()) throw new TranslationFailure('INVALID_RESPONSE', '翻译服务返回了空译文，请重试。', true);
      if (input.task === 'sentence-analysis') {
        yield { type: 'analysis', analysis: parseSentenceAnalysis(content, input.text) };
      } else if (batch) {
        for (const entry of batch.finish()) yield { type: 'segment', ...entry };
        const segments = batch.result();
        yield { type: 'result', result: { kind: 'text', translation: segments.join('\n\n'), segments } };
      } else yield { type: 'result', result: input.kind === 'word' ? parseWordResult(content) : { kind: 'text', translation: content.trim() } };
    } catch (error) {
      if (controller.signal.aborted) throw abortReason(controller.signal);
      if (error instanceof TranslationFailure) throw error;
      if (error instanceof TypeError) throw new TranslationFailure('NETWORK', '无法连接翻译服务，请检查网络后重试。', true);
      throw new TranslationFailure('INVALID_RESPONSE', '翻译服务响应无法读取，请重试。', true);
    } finally {
      clearTimeout(headerTimer);
      signal.removeEventListener('abort', onAbort);
      controller.abort();
    }
  }
}
