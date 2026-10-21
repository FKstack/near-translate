import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeepSeekProvider, HEADER_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_MS } from '../../src/providers/deepseek';
import { SseDecoder } from '../../src/providers/sse';
import { TranslationFailure } from '../../src/core/errors';
import type { SentenceAnalysis, TranslationEvent, TranslationInput } from '../../src/shared/contracts';

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

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('DeepSeek provider', () => {
  it('calls the default fetch with the global receiver required by browser workers', async () => {
    const nativeStyleFetch = vi.fn<typeof fetch>(function (this: unknown) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      return Promise.resolve(response(delta('译文') + delta(null, 'stop') + 'data: [DONE]\n\n'));
    });
    vi.stubGlobal('fetch', nativeStyleFetch);

    // Omit the injected transport to exercise the production default.
    const events = await collect(new DeepSeekProvider({ apiKey: 'test-key' }));

    expect(events.at(-1)).toEqual({ type: 'result', result: { kind: 'text', translation: '译文' } });
    expect(nativeStyleFetch).toHaveBeenCalledOnce();
    expect(nativeStyleFetch.mock.contexts[0]).toBe(globalThis);
  });

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
    expect(body).toMatchObject({ model: 'deepseek-flash', thinking: { type: 'disabled' }, stream: true, max_tokens: 8192 });
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
    const dictionary = {
      translation: '银行', partOfSpeech: '名词', explanation: '此处指办理存款业务的金融机构。',
      senses: [
        { partOfSpeech: '名词', meaning: '银行；金融机构' },
        { partOfSpeech: '名词', meaning: '河岸' },
        { partOfSpeech: '名词', meaning: '储备库' },
        { partOfSpeech: '动词', meaning: '把钱存入银行' },
        { partOfSpeech: '动词', meaning: '倾斜转弯' },
      ],
    };
    const json = JSON.stringify(dictionary);
    const fetcher = transport(delta(json.slice(0, 9)) + delta(json.slice(9)) + delta(null, 'stop') + 'data: [DONE]\n\n');
    const events = await collect(new DeepSeekProvider({ apiKey: 'test-key', model: 'my-model' }, fetcher), wordInput);
    expect(events).toEqual([{ type: 'result', result: { kind: 'word', ...JSON.parse(json) } }]);
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({ model: 'my-model', response_format: { type: 'json_object' }, max_tokens: 2048 });
    expect(JSON.parse(body.messages[1].content)).toEqual({ selectedText: 'bank', context: wordInput.context });
  });

  it('retains common noun, adjective, and verb senses even when context selects an adjective', async () => {
    const dictionary = {
      translation: '轻的', partOfSpeech: '形容词', explanation: '本句描述行李箱重量小。',
      senses: [
        { partOfSpeech: '名词', meaning: '光；光线' },
        { partOfSpeech: '形容词', meaning: '轻的' },
        { partOfSpeech: '形容词', meaning: '浅色的' },
        { partOfSpeech: '动词', meaning: '点燃' },
      ],
    };
    const fetcher = transport(delta(JSON.stringify(dictionary)) + delta(null, 'stop') + 'data: [DONE]\n\n');
    const events = await collect(new DeepSeekProvider({ apiKey: 'test-key' }, fetcher), { text: 'light', context: 'This suitcase is light.', kind: 'word' });
    expect(events).toEqual([{ type: 'result', result: { kind: 'word', ...dictionary } }]);
  });

  it('requests and retains explicit uncertainty when no context was supplied', async () => {
    const dictionary = {
      translation: '光；轻的；点燃', partOfSpeech: '名词；形容词；动词', explanation: '未提供上下文，无法判断本句含义与词性。',
      senses: [{ partOfSpeech: '名词', meaning: '光' }, { partOfSpeech: '形容词', meaning: '轻的' }, { partOfSpeech: '动词', meaning: '点燃' }],
    };
    const fetcher = transport(delta(JSON.stringify(dictionary)) + delta(null, 'stop') + 'data: [DONE]\n\n');
    const events = await collect(new DeepSeekProvider({ apiKey: 'test-key' }, fetcher), { text: 'light', kind: 'word' });
    expect(events).toEqual([{ type: 'result', result: { kind: 'word', ...dictionary } }]);
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(body.messages[0].content).toContain('No context is supplied');
    expect(JSON.parse(body.messages[1].content)).toEqual({ selectedText: 'light' });
  });

  it('accepts one established sense without inventing additional meanings', async () => {
    const dictionary = {
      translation: '氦', partOfSpeech: '名词', explanation: '本句指化学元素氦。',
      senses: [{ partOfSpeech: '名词', meaning: '氦；一种惰性气体元素' }],
    };
    const fetcher = transport(delta(JSON.stringify(dictionary)) + delta(null, 'stop') + 'data: [DONE]\n\n');
    const events = await collect(new DeepSeekProvider({ apiKey: 'test-key' }, fetcher), { text: 'helium', context: 'Helium is an inert gas.', kind: 'word' });
    expect(events).toEqual([{ type: 'result', result: { kind: 'word', ...dictionary } }]);
  });

  it('preserves collocation restrictions inside a dictionary meaning', async () => {
    const dictionary = {
      translation: '描述；说明', partOfSpeech: '名词', explanation: '本句指对系统行为的说明。',
      senses: [{ partOfSpeech: '名词', meaning: '描述；说明' }, { partOfSpeech: '名词', meaning: '种类；类型（常见于 of every description 等搭配）' }],
    };
    const fetcher = transport(delta(JSON.stringify(dictionary)) + delta(null, 'stop') + 'data: [DONE]\n\n');
    const events = await collect(new DeepSeekProvider({ apiKey: 'test-key' }, fetcher), { text: 'description', context: 'Read the description of this system.', kind: 'word' });
    expect(events).toEqual([{ type: 'result', result: { kind: 'word', ...dictionary } }]);
  });

  it('trims fields and deduplicates identical meanings within the same part of speech', async () => {
    const dictionary = {
      translation: ' 银行 ', partOfSpeech: ' 名词 ', explanation: ' 此处指金融机构。 ',
      senses: [{ partOfSpeech: ' 名词 ', meaning: ' 银行 ' }, { partOfSpeech: '名词', meaning: '银行' }, { partOfSpeech: '名词', meaning: '河岸' }, { partOfSpeech: '动词', meaning: '把钱存入银行' }],
    };
    const fetcher = transport(delta(JSON.stringify(dictionary)) + delta(null, 'stop') + 'data: [DONE]\n\n');
    const events = await collect(new DeepSeekProvider({ apiKey: 'test-key' }, fetcher), wordInput);
    expect(events).toEqual([{ type: 'result', result: {
      kind: 'word', translation: '银行', partOfSpeech: '名词', explanation: '此处指金融机构。',
      senses: [{ partOfSpeech: '名词', meaning: '银行' }, { partOfSpeech: '名词', meaning: '河岸' }, { partOfSpeech: '动词', meaning: '把钱存入银行' }],
    } }]);
  });

  it.each([
    { name: 'missing', senses: undefined }, { name: 'null', senses: null }, { name: 'empty', senses: [] },
    { name: 'object', senses: {} }, { name: 'string item', senses: ['银行'] }, { name: 'null item', senses: [null] },
    { name: 'missing part of speech', senses: [{ meaning: '银行' }] },
    { name: 'blank part of speech', senses: [{ partOfSpeech: ' ', meaning: '银行' }] },
    { name: 'missing meaning', senses: [{ partOfSpeech: '名词' }] },
    { name: 'blank meaning', senses: [{ partOfSpeech: '名词', meaning: ' ' }] },
    { name: 'non-string meaning', senses: [{ partOfSpeech: '名词', meaning: 3 }] },
    { name: 'too many entries', senses: Array.from({ length: 11 }, () => ({ partOfSpeech: '名词', meaning: '银行' })) },
  ])('rejects $name dictionary senses instead of accepting incomplete word results', async ({ senses }) => {
    const json = JSON.stringify({ translation: '银行', partOfSpeech: '名词', explanation: '此处指金融机构。', senses });
    const fetcher = transport(delta(json) + delta(null, 'stop') + 'data: [DONE]\n\n');
    await expect(collect(new DeepSeekProvider({ apiKey: 'test-key' }, fetcher), wordInput))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE', retryable: true });
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

describe('DeepSeek page batches', () => {
  const pageSegments = ['First paragraph.', 'Second paragraph.'];
  const input: TranslationInput = { kind: 'text', text: pageSegments.join('\n'), pageSegments };

  it('streams indexed passages across token and UTF-8 boundaries without exposing raw JSON deltas', async () => {
    const fetcher = transport(delta('{"i":0,"t":"第一') + delta('段"}\r\n{"i":1,')
      + delta('"t":"第二段"}') + delta(null, 'stop') + 'data: [DONE]\n\n', Array(300).fill(1));
    const events = await collect(new DeepSeekProvider({ apiKey: 'test-key' }, fetcher), input);
    expect(events).toEqual([
      { type: 'segment', index: 0, text: '第一段' },
      { type: 'segment', index: 1, text: '第二段' },
      { type: 'result', result: { kind: 'text', translation: '第一段\n\n第二段', segments: ['第一段', '第二段'] } },
    ]);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    const body = JSON.parse(String(init?.body));
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.stream).toBe(true);
    expect(body.response_format).toBeUndefined();
    expect(body.max_tokens).toBeLessThan(8192);
    expect(JSON.parse(body.messages[1].content)).toEqual({ segments: pageSegments.map((text, i) => ({ i, text })) });
  });

  it('delivers the first passage before the rest of the response has arrived', async () => {
    let sink!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { sink = controller; } });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    const iterator = new DeepSeekProvider({ apiKey: 'test-key' }, fetcher)
      .translate(input, new AbortController().signal)[Symbol.asyncIterator]();
    const first = iterator.next();
    sink.enqueue(encoder.encode(delta('{"i":0,"t":"第一段"}\n')));
    expect((await first).value).toEqual({ type: 'segment', index: 0, text: '第一段' });
    sink.enqueue(encoder.encode(delta('{"i":1,"t":"第二段"}\n') + delta(null, 'stop') + 'data: [DONE]\n\n'));
    sink.close();
    expect((await iterator.next()).value).toEqual({ type: 'segment', index: 1, text: '第二段' });
    expect((await iterator.next()).value).toMatchObject({ type: 'result', result: { segments: ['第一段', '第二段'] } });
    expect((await iterator.next()).done).toBe(true);
    expect(body.locked).toBe(false);
  });

  it('reports a later service failure without retracting already delivered passages or finalizing the batch', async () => {
    const fetcher = transport(delta('{"i":0,"t":"已返回"}\n') + 'data: {"error":{"message":"private"}}\n\n');
    const iterator = new DeepSeekProvider({ apiKey: 'test-key' }, fetcher)
      .translate(input, new AbortController().signal)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ type: 'segment', index: 0, text: '已返回' });
    await expect(iterator.next()).rejects.toMatchObject({ code: 'SERVER', retryable: true });
  });

  it('commits a valid passage before a malformed later line from the same model delta', async () => {
    const fetcher = transport(delta('{"i":0,"t":"已返回"}\n{"i":1,"t":false}\n')
      + delta(null, 'stop') + 'data: [DONE]\n\n');
    const iterator = new DeepSeekProvider({ apiKey: 'test-key' }, fetcher)
      .translate(input, new AbortController().signal)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ type: 'segment', index: 0, text: '已返回' });
    await expect(iterator.next()).rejects.toMatchObject({ code: 'INVALID_RESPONSE', retryable: true });
  });

  it('leaves room for complete Chinese output and indexed-record overhead in a typical page batch', async () => {
    const parts = Array.from({ length: 16 }, () => 'A technical paragraph that preserves all its meaning. '.repeat(2).slice(0, 99));
    const source = parts.join('\n');
    const ndjson = parts.map((_, i) => JSON.stringify({ i, t: '完整译文。' })).join('\n') + '\n';
    const fetcher = transport(delta(ndjson) + delta(null, 'stop') + 'data: [DONE]\n\n');
    await collect(new DeepSeekProvider({ apiKey: 'test-key' }, fetcher), { kind: 'text', text: source, pageSegments: parts });
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(source.length).toBe(1599);
    expect(body.max_tokens).toBeGreaterThanOrEqual(2400);
    expect(body.max_tokens).toBeLessThanOrEqual(8192);
  });

  it.each([
    delta('{"i":0,"t":"只返回一段"}\n') + delta(null, 'stop') + 'data: [DONE]\n\n',
    delta('{"i":0,"t":"第一段"}\n{"i":0,"t":"重复"}\n') + delta(null, 'stop') + 'data: [DONE]\n\n',
    delta('{"i":0,"t":"第一段"}\n{"i":1,"t":"第二段"}\n'),
    delta('{"i":0,"t":"第一段"}\n{"i":1,"t":"第二段"}\n') + delta(null, 'length'),
  ])('never reports a completed result for incomplete or invalid batches', async (sse) => {
    const observed: TranslationEvent[] = [];
    await expect((async () => {
      for await (const event of new DeepSeekProvider({ apiKey: 'test-key' }, transport(sse))
        .translate(input, new AbortController().signal)) observed.push(event);
    })()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(observed.some(event => event.type === 'result')).toBe(false);
  });

  it('cancels a batch after its first streamed passage and releases the reader', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode(delta('{"i":0,"t":"第一段"}\n'))); }, cancel,
    });
    const abort = new AbortController();
    const iterator = new DeepSeekProvider({ apiKey: 'test-key' }, vi.fn<typeof fetch>().mockResolvedValue(new Response(body)))
      .translate(input, abort.signal)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: 'segment', index: 0 });
    const pending = iterator.next();
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });
});

describe('DeepSeek sentence analysis', () => {
  const source = 'The server, which handles incoming requests, can recover after a failure.';
  const input: TranslationInput = { kind: 'text', text: source, task: 'sentence-analysis' };
  const analysis: SentenceAnalysis = {
    mainClause: { text: 'The server can recover', translation: '服务器能够恢复。', explanation: '主语加情态动词和谓语。' },
    chunks: [
      { text: 'The server,', role: '主语', explanation: '说明句子的主体。' },
      { text: 'which handles incoming requests,', role: '定语从句', explanation: '补充说明服务器。' },
      { text: 'can recover after a failure.', role: '谓语和状语', explanation: '说明能够在故障后恢复。' },
    ],
    readingGuide: '先读主干，再把补充说明和时间状语放回句中。',
  };

  it('keeps analysis JSON private until validated and emits only the independent terminal analysis event', async () => {
    const json = JSON.stringify(analysis);
    const fetcher = transport(delta(json.slice(0, 23)) + delta(json.slice(23, 95)) + delta(json.slice(95))
      + delta(null, 'stop') + 'data: [DONE]\n\n', Array(400).fill(1));
    const events = await collect(new DeepSeekProvider({ apiKey: 'test-key' }, fetcher), input);
    expect(events).toEqual([{ type: 'analysis', analysis }]);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe('deepseek-flash');
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.max_tokens).toBe(4096);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(JSON.parse(body.messages[1].content)).toEqual({ task: 'sentence-analysis', selectedText: source });
  });

  it('retains validated grammar categories in the same analysis response without an extra API call', async () => {
    const categorized: SentenceAnalysis = { ...analysis, chunks: [
      { ...analysis.chunks[0]!, category: 'subject' },
      { ...analysis.chunks[1]!, category: 'clause' },
      { ...analysis.chunks[2]!, category: 'predicate' },
    ] };
    const fetcher = transport(delta(JSON.stringify(categorized)) + delta(null, 'stop') + 'data: [DONE]\n\n');
    expect(await collect(new DeepSeekProvider({ apiKey: 'test-key' }, fetcher), input)).toEqual([{ type: 'analysis', analysis: categorized }]);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([
    'not JSON', '{}',
    JSON.stringify({ ...analysis, chunks: [{ text: 'The server,', role: '主语', explanation: '遗漏了后半句。' }] }),
    JSON.stringify({ ...analysis, mainClause: { ...analysis.mainClause, text: 'The server must recover' } }),
  ])('fails malformed analysis without producing a translation replacement or raw model output', async (json) => {
    const observed: TranslationEvent[] = [];
    await expect((async () => {
      for await (const event of new DeepSeekProvider({ apiKey: 'test-key' }, transport(delta(json) + delta(null, 'stop') + 'data: [DONE]\n\n'))
        .translate(input, new AbortController().signal)) observed.push(event);
    })()).rejects.toMatchObject({ code: 'INVALID_RESPONSE', retryable: true });
    expect(observed).toEqual([]);
  });

  it('requires a complete SSE response before exposing analysis', async () => {
    await expect(collect(new DeepSeekProvider({ apiKey: 'test-key' }, transport(delta(JSON.stringify(analysis)))), input))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('rejects ineligible analysis input before calling DeepSeek', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(collect(new DeepSeekProvider({ apiKey: 'test-key' }, fetcher), { kind: 'text', text: 'Too short.', task: 'sentence-analysis' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('cancels partially generated analysis without leaking JSON deltas or a late terminal event', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode(delta('{"mainClause":{"text":"The server'))); }, cancel,
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    const abort = new AbortController();
    const observed: TranslationEvent[] = [];
    const pending = (async () => {
      for await (const event of new DeepSeekProvider({ apiKey: 'test-key' }, fetcher).translate(input, abort.signal)) observed.push(event);
    })();
    for (let turn = 0; turn < 20 && !body.locked; turn++) await Promise.resolve();
    expect(body.locked).toBe(true);
    const reason = new TranslationFailure('TIMEOUT', '分析已取消', true);
    abort.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(observed).toEqual([]);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });
});
