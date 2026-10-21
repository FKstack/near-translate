import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleProvider, HEADER_TIMEOUT_MS } from '../../src/providers/openai-compatible';
import type { OpenAICompatibleConfiguration } from '../../src/providers/openai-compatible';
import type { TranslationEvent, TranslationInput } from '../../src/shared/contracts';

const input: TranslationInput = { text: 'Translate this paragraph.', kind: 'text' };
const configuration: OpenAICompatibleConfiguration = {
  provider: 'custom', apiKey: 'test-key', model: 'org/example-model', baseUrl: 'https://gateway.example/v1',
};
const encoder = new TextEncoder();
const chunk = (content: string | null, finish_reason: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason }] })}\n\n`;
const complete = (content: string) => chunk(content) + chunk(null, 'stop') + 'data: [DONE]\n\n';
const transport = (sse = complete('这是译文。')) => vi.fn<typeof fetch>().mockResolvedValue(
  new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } }),
);
async function collect(settings = configuration, fetcher: typeof fetch = transport(), source = input, signal = new AbortController().signal) {
  const events: TranslationEvent[] = [];
  for await (const event of new OpenAICompatibleProvider(settings, fetcher).translate(source, signal)) events.push(event);
  return events;
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('OpenAI-compatible translation transport', () => {
  it('uses the configured gateway and model with portable request fields and no cookies or redirects', async () => {
    const fetcher = transport();
    expect((await collect(configuration, fetcher)).at(-1)).toEqual({ type: 'result', result: { kind: 'text', translation: '这是译文。' } });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://gateway.example/v1/chat/completions');
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error' });
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer test-key' });
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ model: 'org/example-model', max_tokens: 8192, stream: true });
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('response_format');
  });

  it('normalizes a full completion URL without appending the endpoint twice', async () => {
    const fetcher = transport();
    await collect({ ...configuration, baseUrl: 'https://gateway.example/custom/chat/completions/' }, fetcher);
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://gateway.example/custom/chat/completions');
  });

  it('uses the OpenAI completion budget without DeepSeek-specific or sampling parameters', async () => {
    const fetcher = transport();
    await collect({ ...configuration, provider: 'openai', model: 'reasoning-model', baseUrl: 'https://api.openai.com/v1' }, fetcher);
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(body.max_completion_tokens).toBe(8192);
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('thinking');
  });

  it('identifies the Gemini compatibility client', async () => {
    const fetcher = transport();
    await collect({ ...configuration, provider: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' }, fetcher);
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ 'x-goog-api-client': 'near-translate/0.7.0' });
  });

  it.each(['custom', 'ollama'])('supports a local %s service without an Authorization header', async provider => {
    const fetcher = transport();
    await collect({ ...configuration, provider, apiKey: '', baseUrl: 'http://localhost:11434/v1' }, fetcher);
    expect(fetcher.mock.calls[0]?.[0]).toBe('http://localhost:11434/v1/chat/completions');
    expect(fetcher.mock.calls[0]?.[1]?.headers).not.toHaveProperty('Authorization');
  });

  it.each([true, false])('uses optional JSON response format (%s) while always validating dictionary output', async jsonMode => {
    const dictionary = { translation: '银行', partOfSpeech: '名词', explanation: '金融机构。', senses: [{ partOfSpeech: '名词', meaning: '银行' }] };
    const fetcher = transport(complete(JSON.stringify(dictionary)));
    const events = await collect({ ...configuration, jsonMode }, fetcher, { text: 'bank', kind: 'word' });
    expect(events).toEqual([{ type: 'result', result: { kind: 'word', ...dictionary } }]);
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(body.response_format).toEqual(jsonMode ? { type: 'json_object' } : undefined);
    await expect(collect({ ...configuration, jsonMode }, transport(complete('not JSON')), { text: 'bank', kind: 'word' }))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('accepts normal EOF after a stop reason for compatible servers', async () => {
    const events = await collect(configuration, transport(chunk('译文') + chunk(null, 'stop')));
    expect(events.at(-1)?.type).toBe('result');
  });

  it.each([
    chunk('部分译文'),
    chunk('部分译文') + 'data: [DONE]\n\n',
    chunk('部分译文', 'length') + 'data: [DONE]\n\n',
    chunk('部分译文', 'content_filter'),
    chunk('译文', 'stop') + chunk('不应继续'),
    chunk(null, 'stop') + 'data: [DONE]\n\n',
  ])('rejects incomplete, filtered, empty or malformed stream completion', async sse => {
    await expect(collect(configuration, transport(sse))).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it.each([
    { apiKey: 'secret\r\nInjected: value' },
    { provider: 'openai', apiKey: '' },
    { model: ' ' },
    { baseUrl: 'https://user:secret@gateway.example/v1' },
    { baseUrl: 'https://gateway.example/v1?api_key=secret' },
    { baseUrl: 'http://remote.example/v1' },
  ])('rejects invalid configuration before issuing a request', async invalid => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(collect({ ...configuration, ...invalid }, fetcher)).rejects.toMatchObject({ code: 'CONFIG' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([401, 402, 404, 429, 500])('does not expose a remote HTTP %i body or a credential', async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('private-api-key: private-server-body', { status }));
    const error = await collect(configuration, fetcher).catch(error => error as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toMatch(/private-api-key|private-server-body|DeepSeek/);
  });

  it('does not expose SSE or browser exception text', async () => {
    const sseError = await collect(configuration, transport('data: {"error":{"message":"private-api-key"}}\n\n')).catch(error => error as Error);
    expect((sseError as Error).message).not.toContain('private-api-key');
    const failed = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('private-api-key at private-url'));
    const networkError = await collect(configuration, failed).catch(error => error as Error);
    expect(networkError).toMatchObject({ code: 'NETWORK', retryable: true });
    expect((networkError as Error).message).not.toMatch(/private-api-key|private-url/);
  });

  it('uses the native fetch receiver in production', async () => {
    const fetcher = vi.fn<typeof fetch>(function (this: unknown) {
      expect(this).toBe(globalThis);
      return Promise.resolve(new Response(complete('译文')));
    });
    vi.stubGlobal('fetch', fetcher);
    const provider = new OpenAICompatibleProvider(configuration);
    for await (const _event of provider.translate(input, new AbortController().signal)) { /* consume */ }
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('times out an unresponsive compatible endpoint and aborts its transport', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise<Response>(() => undefined));
    const pending = collect(configuration, fetcher);
    const assertion = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT', retryable: true });
    await vi.advanceTimersByTimeAsync(HEADER_TIMEOUT_MS);
    await assertion;
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels partial compatible streams, releases the reader, and never completes the old translation', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode(chunk('部分译文'))); }, cancel,
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    const abort = new AbortController();
    const events = new OpenAICompatibleProvider(configuration, fetcher).translate(input, abort.signal)[Symbol.asyncIterator]();
    expect((await events.next()).value).toEqual({ type: 'delta', text: '部分译文' });
    const pending = events.next();
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });
});
