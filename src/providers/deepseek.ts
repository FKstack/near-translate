import {
  DEFAULT_MODEL,
  type TranslationEvent,
  type TranslationInput,
  type TranslationProvider,
  type WordResult,
  type WordSense,
} from '../shared/contracts';
import { httpFailure, TranslationFailure } from '../core/errors';
import { normalizeTranslationInput } from '../core/input';
import { buildTranslationMessages } from '../core/prompts';
import { SseDecoder } from './sse';

export const HEADER_TIMEOUT_MS = 25_000;
export const STREAM_IDLE_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_LENGTH = 100_000;
const API_ENDPOINT = 'https://api.deepseek.com/chat/completions';

export interface DeepSeekConfiguration { apiKey: string; model?: string }

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
      new TranslationFailure('TIMEOUT', 'DeepSeek 响应中断，请重试。', true),
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
    return new TranslationFailure('SERVER', 'DeepSeek 中断了生成，请稍后重试。', true);
  }
  return new TranslationFailure('INVALID_RESPONSE', 'DeepSeek 未能完整翻译此内容，请重新选择。');
}

export class DeepSeekProvider implements TranslationProvider {
  constructor(
    private readonly configuration: DeepSeekConfiguration,
    private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {}

  async *translate(rawInput: TranslationInput, signal: AbortSignal): AsyncIterable<TranslationEvent> {
    throwIfAborted(signal);
    const input = normalizeTranslationInput(rawInput);
    const apiKey = this.configuration.apiKey.trim();
    const model = (this.configuration.model ?? DEFAULT_MODEL).trim();
    if (!apiKey || /[\r\n]/.test(apiKey)) throw new TranslationFailure('CONFIG', '请先在设置中填写有效的 DeepSeek API Key。');
    if (!model) throw new TranslationFailure('CONFIG', '请先在设置中填写模型名称。');

    const controller = new AbortController();
    const onAbort = () => controller.abort(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    let headerTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      headerTimer = setTimeout(() => controller.abort(
        new TranslationFailure('TIMEOUT', 'DeepSeek 连接超时，请检查网络后重试。', true),
      ), HEADER_TIMEOUT_MS);
      const response = await withAbort(this.fetcher(API_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({
          model,
          messages: buildTranslationMessages(input),
          thinking: { type: 'disabled' },
          temperature: 0.2,
          max_tokens: input.kind === 'word' ? 2048 : 8192,
          stream: true,
          ...(input.kind === 'word' ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: controller.signal,
        credentials: 'omit',
      }), controller.signal);
      clearTimeout(headerTimer);
      headerTimer = undefined;
      throwIfAborted(controller.signal);
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw httpFailure(response.status);
      }
      if (!response.body) throw new TranslationFailure('INVALID_RESPONSE', 'DeepSeek 返回了空响应，请重试。', true);

      let content = '';
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
        catch { throw new TranslationFailure('INVALID_RESPONSE', 'DeepSeek 响应格式不正确，请重试。', true); }
        if (!record(payload)) throw new TranslationFailure('INVALID_RESPONSE', 'DeepSeek 响应格式不正确，请重试。', true);
        if ('error' in payload) throw new TranslationFailure('SERVER', 'DeepSeek 返回服务错误，请稍后重试。', true);
        if (!Array.isArray(payload.choices)) throw new TranslationFailure('INVALID_RESPONSE', 'DeepSeek 响应缺少翻译内容，请重试。', true);
        if (payload.choices.length === 0) continue; // Compatibility with usage-only SSE chunks.
        const choice: unknown = payload.choices[0];
        if (!record(choice) || !record(choice.delta)) throw new TranslationFailure('INVALID_RESPONSE', 'DeepSeek 响应格式不正确，请重试。', true);
        const delta = choice.delta.content;
        if (delta !== undefined && delta !== null && typeof delta !== 'string') {
          throw new TranslationFailure('INVALID_RESPONSE', 'DeepSeek 响应格式不正确，请重试。', true);
        }
        if (typeof delta === 'string' && delta) {
          if (finishReason) throw new TranslationFailure('INVALID_RESPONSE', 'DeepSeek 响应结束标记异常，请重试。', true);
          content += delta;
          if (content.length > MAX_OUTPUT_LENGTH) throw new TranslationFailure('INVALID_RESPONSE', '译文过长，请缩短选区后重试。', true);
          if (input.kind === 'text') yield { type: 'delta', text: delta };
        }
        if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
          if (typeof choice.finish_reason !== 'string') throw new TranslationFailure('INVALID_RESPONSE', 'DeepSeek 响应结束标记异常，请重试。', true);
          finishReason = choice.finish_reason;
          if (finishReason !== 'stop') throw finishFailure(finishReason);
        }
      }
      throwIfAborted(controller.signal);
      if (!completed || finishReason !== 'stop') {
        throw new TranslationFailure('INVALID_RESPONSE', 'DeepSeek 响应未完整结束，请重试。', true);
      }
      if (!content.trim()) throw new TranslationFailure('INVALID_RESPONSE', 'DeepSeek 返回了空译文，请重试。', true);
      yield { type: 'result', result: input.kind === 'word' ? parseWordResult(content) : { kind: 'text', translation: content.trim() } };
    } catch (error) {
      if (controller.signal.aborted) throw abortReason(controller.signal);
      if (error instanceof TranslationFailure) throw error;
      if (error instanceof TypeError) throw new TranslationFailure('NETWORK', '无法连接 DeepSeek，请检查网络后重试。', true);
      throw new TranslationFailure('INVALID_RESPONSE', 'DeepSeek 响应无法读取，请重试。', true);
    } finally {
      clearTimeout(headerTimer);
      signal.removeEventListener('abort', onAbort);
      controller.abort();
    }
  }
}
