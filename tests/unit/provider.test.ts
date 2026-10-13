import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeepSeekProvider, HEADER_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_MS } from '../../src/providers/deepseek';
import { SseDecoder } from '../../src/providers/sse';
import { TranslationFailure } from '../../src/core/errors';
import type { TranslationEvent, TranslationInput } from '../../src/shared/contracts';

const textInput: TranslationInput = { text: 'The result is not significant at 0.05.', kind: 'text' };
const wordInput: TranslationInput = { text: 'bank', context: 'They deposited money at the bank.', kind: 'word' };
const encoder = new TextEncoder();

function delta(content: string | null = null, finish_reason: string | null = null): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason }] })}\n\n`;
}

function response(sse: string, widths: number[] = []): Response {
  const bytes = encoder.encode(sse);
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const width of widths) {
        if (offset >= bytes.length) break;
        controller.enqueue(bytes.slice(offset, offset + width));
        offset += width;
      }
      if (offset < bytes.length) controller.enqueue(bytes.slice(offset));
      controller.close();
    },
  });
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
}

function transport(sse: string, widths?: number[]) {
  return vi.fn<typeof fetch>().mockResolvedValue(response(sse, widths));
}

async function collect(provider: DeepSeekProvider, input = textInput, signal = new AbortController().signal): Promise<TranslationEvent[]> {
  const events: TranslationEvent[] = [];
  for await (const event of provider.translate(input, signal)) events.push(event);
  return events;
}

afterEach(() => { vi.useRealTimers(); });

describe('DeepSeek provider', () => {
  it('uses Flash, disabled thinking, the official endpoint, and streams faithful paragraph text', async () => {
    const fetcher = transport(`: keepalive\n\n${delta('结果在 0.05 水平下')}${delta('不显著。\n\n下一段。')}${delta(null, 'stop')}data: [DONE]\n\n`, new Array(90).fill(1));
    const events = await collect(new DeepSeekProvider({ apiKey: 'test-key' }, fetcher));
    expect(events).toEqual([
      { type: 'delta', text: '结果在 0.05 水平下' },
      { type: 'delta', text: '不显著。\n\n下一段。' },
      { type: 'result', result: { kind: 'text', translation: '结果在 0.05 水平下不显著。\n\n下一段。' } },
    ]);
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://api.deepseek.com/chat/completions');
    const options = fetcher.mock.calls[0]?.[1];
    expect(options?.headers).toMatchObject({ Authorization: 'Bearer test-key' });
    expect(options?.credentials).toBe('omit');
    const body = JSON.parse(String(options?.body));
    expect(body).toMatchObject({ model: 'deepseek-flash', thinking: { type: 'disabled' }, stream: true });
    expect(body).not.toHaveProperty('response_format');
    expect(JSON.parse(body.messages[1].content)).toEqual({ selectedText: textInput.text });
  });

  it('decodes UTF-8 characters split across byte boundaries', async () => {
    const sse = delta('中文译文') + delta(null, 'stop') + 'data: [DONE]\n\n';
    const fetcher = transport(sse, new Array(encoder.encode(sse).length).fill(1));
    expect((await collect(new DeepSeekProvider({ apiKey: 'test-key' }, fetcher))).at(-1))
      .toEqual({ type: 'result', result: { kind: 'text', translation: '中文译文' } });
  });

  it('returns validated word meanings without exposing partial JSON as deltas', async () => {
    const json = JSON.stringify({ translation: '银行', partOfSpeech: '名词', explanation: '此处指办理存款业务的金融机构。' });
    const fetcher = transport(delta(json.slice(0, 9)) + delta(json.slice(9)) + delta(null, 'stop') + 'data: [DONE]\n\n');
    const events = await collect(new DeepSeekProvider({ apiKey: 'test-key', model: 'my-model' }, fetcher), wordInput);
    expect(events).toEqual([{ type: 'result', result: { kind: 'word', ...JSON.parse(json) } }]);
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({ model: 'my-model', response_format: { type: 'json_object' } });
    expect(JSON.parse(body.messages[1].content)).toEqual({ selectedText: 'bank', context: wordInput.context });
  });

  it.each(['{invalid', '[]', '{}', '{"translation":"银行","partOfSpeech":"名词","explanation":""}',
    '{"translation":3,"partOfSpeech":"名词","explanation":"解释"}'])('rejects malformed word output: %s', async (json) => {
    const fetcher = transport(delta(json) + delta(null, 'stop') + 'data: [DONE]\n\n');
    await expect(collect(new DeepSeekProvider({ apiKey: 'test-key' }, fetcher), wordInput))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE', retryable: true });
  });

  it.each([
    [delta('片段'), 'INVALID_RESPONSE'],
    [delta('片段') + 'data: [DONE]\n\n', 'INVALID_RESPONSE'],
    [delta('') + delta(null, 'stop') + 'data: [DONE]\n\n', 'INVALID_RESPONSE'],
    [delta('片段', 'length'), 'INVALID_RESPONSE'],
    [delta('片段', 'content_filter'), 'INVALID_RESPONSE'],
    [delta('片段', 'insufficient_system_resource'), 'SERVER'],
    [delta('片段', 'aborted'), 'SERVER'],
    ['data: not-json\n\n', 'INVALID_RESPONSE'],
    ['data: {"choices":[{"delta":{"content":42}}]}\n\n', 'INVALID_RESPONSE'],
    ['data: {"error":{"message":"secret-key"}}\n\n', 'SERVER'],
  ])('rejects interrupted, empty, or invalid streams', async (sse, code) => {
    const fetcher = transport(sse);
    await expect(collect(new DeepSeekProvider({ apiKey: 'test-key' }, fetcher))).rejects.toMatchObject({ code });
  });

  it('supports usage-only chunks and an end marker without final blank line', async () => {
    const fetcher = transport(delta('译文') + delta(null, 'stop') + 'data: {"choices":[],"usage":{}}\n\ndata: [DONE]');
    expect((await collect(new DeepSeekProvider({ apiKey: 'test-key' }, fetcher))).at(-1)?.type).toBe('result');
  });

  it.each([[401, 'AUTH'], [402, 'BALANCE'], [429, 'RATE_LIMIT'], [500, 'SERVER']])('maps HTTP errors without leaking a server body', async (status, code) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('secret-key', { status: Number(status) }));
    await expect(collect(new DeepSeekProvider({ apiKey: 'test-key' }, fetcher))).rejects.toMatchObject({ code });
  });

  it('maps transport failures to a retryable network error', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('test-key: Failed to fetch'));
    await expect(collect(new DeepSeekProvider({ apiKey: 'test-key' }, fetcher))).rejects.toMatchObject({ code: 'NETWORK', retryable: true });
  });

  it('does not start a request when credentials, model, or input are invalid', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(collect(new DeepSeekProvider({ apiKey: '' }, fetcher))).rejects.toMatchObject({ code: 'CONFIG' });
    await expect(collect(new DeepSeekProvider({ apiKey: 'test-key', model: '  ' }, fetcher))).rejects.toMatchObject({ code: 'CONFIG' });
    await expect(collect(new DeepSeekProvider({ apiKey: 'test-key' }, fetcher), { text: '', kind: 'text' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const canceled = new AbortController();
    canceled.abort();
    await expect(collect(new DeepSeekProvider({ apiKey: 'test-key' }, fetcher), textInput, canceled.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('times out headers even when an injected transport ignores cancellation', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise<Response>(() => undefined));
    const result = collect(new DeepSeekProvider({ apiKey: 'test-key' }, fetcher));
    const assertion = expect(result).rejects.toMatchObject({ code: 'TIMEOUT', retryable: true });
    await vi.advanceTimersByTimeAsync(HEADER_TIMEOUT_MS);
    await assertion;
    expect((fetcher.mock.calls[0]?.[1]?.signal as AbortSignal).aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out a silent stream and releases its reader', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    const result = collect(new DeepSeekProvider({ apiKey: 'test-key' }, fetcher));
    const assertion = expect(result).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS);
    await assertion;
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps waiting when the server sends heartbeat bytes during generation', async () => {
    vi.useFakeTimers();
    let sink!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { sink = controller; } });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    const result = collect(new DeepSeekProvider({ apiKey: 'test-key' }, fetcher));
    await vi.advanceTimersByTimeAsync(20_000);
    sink.enqueue(encoder.encode(': heartbeat\n\n'));
    await vi.advanceTimersByTimeAsync(20_000);
    sink.enqueue(encoder.encode(delta('译文') + delta(null, 'stop') + 'data: [DONE]\n\n'));
    expect((await result).at(-1)?.type).toBe('result');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels an active read with the caller reason and does not produce a completed result', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(delta('部分译文'))); }, cancel });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    const controller = new AbortController();
    const events = new DeepSeekProvider({ apiKey: 'test-key' }, fetcher).translate(textInput, controller.signal)[Symbol.asyncIterator]();
    expect((await events.next()).value).toEqual({ type: 'delta', text: '部分译文' });
    const pending = events.next();
    const reason = new TranslationFailure('TIMEOUT', '总请求超时', true);
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it('releases a stream when the consumer stops after a partial delta', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(delta('部分译文'))); }, cancel });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    const events = new DeepSeekProvider({ apiKey: 'test-key' }, fetcher).translate(textInput, new AbortController().signal)[Symbol.asyncIterator]();
    await events.next();
    await events.return?.();
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });
});

describe('SSE framing', () => {
  it('handles CRLF split across calls, comments, and multiline event data', () => {
    const decoder = new SseDecoder();
    expect(decoder.push(': keepalive\r')).toEqual([]);
    expect(decoder.push('\ndata: first\r')).toEqual([]);
    expect(decoder.push('\ndata: second\r\n\r')).toEqual([]);
    expect(decoder.push('\n')).toEqual(['first\nsecond']);
    expect(decoder.finish()).toEqual([]);
  });

  it('supports lone CR and an EOF-terminated event', () => {
    const decoder = new SseDecoder();
    expect(decoder.push('data: one\r\rdata: two')).toEqual(['one']);
    expect(decoder.finish()).toEqual(['two']);
  });

  it('bounds unterminated event buffers', () => {
    expect(() => new SseDecoder().push('data: ' + 'x'.repeat(256_001))).toThrow(TranslationFailure);
  });
});
