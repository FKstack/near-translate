import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGMFetch } from '../../src/userscript/transport';
import type { GMRequest, GMResponse } from '../../src/userscript/gm';
import { OpenAICompatibleProvider } from '../../src/providers/openai-compatible';
import { REQUEST_TIMEOUT_MS } from '../../src/shared/contracts';

const ENDPOINT = 'https://transport-fixture.invalid/chat/completions';
const SOURCE = 'fixture-only public translation input';
const KEY = 'fixture-only transport key';
let requests: Array<{ details: GMRequest; abort: ReturnType<typeof vi.fn> }>;

function observed<T>(promise: Promise<T>): Promise<T> {
  void promise.catch(() => undefined);
  return promise;
}
function request(init: Partial<RequestInit> = {}, beforeRequest?: () => Promise<void>) {
  return observed(createGMFetch(ENDPOINT, beforeRequest)(ENDPOINT, {
    method: 'POST', body: JSON.stringify({ input: SOURCE }), credentials: 'omit', redirect: 'error',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, ...init,
  }));
}
function response(fields: Partial<GMResponse> = {}): GMResponse {
  return { status: 200, readyState: 4, finalUrl: ENDPOINT, responseHeaders: 'Content-Type: text/event-stream', ...fields };
}
function stream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel });
  return { body, controller, cancel };
}
function foreignBytes(bytes: Uint8Array): Uint8Array {
  return runInNewContext('new Uint8Array(bytes)', { bytes: [...bytes] }) as Uint8Array;
}
async function settle() { for (let index = 0; index < 25; index++) await Promise.resolve(); }
async function collect(provider: OpenAICompatibleProvider) {
  const events = [];
  for await (const event of provider.translate({ kind: 'text', text: SOURCE }, new AbortController().signal)) events.push(event);
  return events;
}

beforeEach(() => {
  requests = [];
  vi.stubGlobal('GM_info', { scriptHandler: 'Tampermonkey', version: '5.6.0' });
  vi.stubGlobal('GM_xmlhttpRequest', (details: GMRequest) => {
    const abort = vi.fn(() => details.onabort());
    requests.push({ details, abort });
    return { abort };
  });
});
afterEach(async () => {
  for (const { details } of requests) details.onabort();
  await settle();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Tampermonkey response and request boundaries', () => {
  it('reads cross-realm Uint8Array chunks and preserves UTF-8 characters split between chunks', async () => {
    const pending = request();
    const source = stream();
    requests[0]!.details.onloadstart(response({ response: source.body }));
    const text = observed((await pending).text());
    const bytes = new TextEncoder().encode('前🙂后');
    const chunks = [bytes.subarray(0, 2), bytes.subarray(2, 5), bytes.subarray(5)];
    for (const chunk of chunks) {
      const foreign = foreignBytes(chunk);
      expect(foreign).not.toBeInstanceOf(Uint8Array);
      expect(ArrayBuffer.isView(foreign)).toBe(true);
      source.controller.enqueue(foreign);
    }
    source.controller.close();
    await expect(text).resolves.toBe('前🙂后');
    expect(requests[0]!.abort).not.toHaveBeenCalled();
  });

  it('copies only the visible range of a cross-realm byte view', async () => {
    const pending = request();
    const source = stream();
    requests[0]!.details.onloadstart(response({ response: source.body }));
    const text = observed((await pending).text());
    const bytes = runInNewContext('new Uint8Array([88, 111, 107, 89]).subarray(1, 3)') as Uint8Array;
    source.controller.enqueue(bytes);
    source.controller.close();
    await expect(text).resolves.toBe('ok');
  });

  for (const invalid of [[100, 97, 116, 97], { 0: 100, 1: 97, byteLength: 2, length: 2, [Symbol.toStringTag]: 'Uint8Array' }]) {
    it(`rejects a ${Array.isArray(invalid) ? 'plain array' : 'forged byte-shaped object'} instead of treating it as bytes`, async () => {
      const pending = request();
      const source = stream();
      requests[0]!.details.onloadstart(response({ response: source.body }));
      const text = observed((await pending).text());
      source.controller.enqueue(invalid as unknown as Uint8Array);
      await expect(text).rejects.toBeInstanceOf(TypeError);
      await settle();
      expect(requests[0]!.abort).toHaveBeenCalledOnce();
      expect(source.cancel).toHaveBeenCalledOnce();
    });
  }

  it('retains the stream announced with status 0 until a later callback supplies valid headers', async () => {
    const pending = request();
    const source = stream();
    let opened = false;
    void pending.then(() => { opened = true; }, () => {});
    requests[0]!.details.onloadstart(response({ status: 0, readyState: 1, response: source.body }));
    source.controller.enqueue(new TextEncoder().encode('early '));
    await settle();
    expect(opened).toBe(false);
    // Tampermonkey need not attach the stream object to every subsequent event.
    requests[0]!.details.onreadystatechange(response({ readyState: 2 }));
    const text = observed((await pending).text());
    requests[0]!.details.onload(response());
    source.controller.enqueue(new TextEncoder().encode('late'));
    source.controller.close();
    await expect(text).resolves.toBe('early late');
  });

  it('does not truncate a response when onload precedes the end of its stream', async () => {
    const pending = request();
    const source = stream();
    requests[0]!.details.onloadstart(response({ response: source.body }));
    const result = await pending;
    const reader = result.body!.getReader();
    source.controller.enqueue(new TextEncoder().encode('first '));
    expect(await reader.read()).toMatchObject({ done: false });
    requests[0]!.details.onload(response({ response: source.body }));
    source.controller.enqueue(new TextEncoder().encode('last'));
    source.controller.close();
    const tail = await reader.read();
    expect(new TextDecoder().decode(tail.value)).toBe('last');
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    expect(requests[0]!.abort).not.toHaveBeenCalled();
    reader.releaseLock();
  });

  for (const action of ['cancel', 'redirect'] as const) {
    it(`cancels an early pending manager stream without consuming it after ${action}`, async () => {
      const controller = new AbortController();
      const pending = request({ signal: controller.signal });
      const source = stream();
      const getReader = vi.spyOn(source.body, 'getReader');
      requests[0]!.details.onloadstart(response({ status: 0, readyState: 1, response: source.body }));
      if (action === 'cancel') controller.abort();
      else requests[0]!.details.onreadystatechange(response({ status: 302, readyState: 2 }));
      await expect(pending).rejects.toMatchObject(action === 'cancel' ? { name: 'AbortError' } : { code: 'NETWORK', retryable: false });
      await settle();
      expect(getReader).not.toHaveBeenCalled();
      expect(source.cancel).toHaveBeenCalledOnce();
      expect(requests[0]!.abort).toHaveBeenCalledOnce();
    });
  }

  it('fails the exposed body safely when the manager stream is already locked', async () => {
    const pending = request();
    const source = stream();
    const owner = source.body.getReader();
    try {
      expect(() => requests[0]!.details.onloadstart(response({ response: source.body }))).not.toThrow();
      await expect(observed((await pending).text())).rejects.toBeInstanceOf(TypeError);
      await settle();
      expect(requests[0]!.abort).toHaveBeenCalledOnce();
    } finally {
      await owner.cancel();
      owner.releaseLock();
    }
  });

  for (const [status, code] of [[401, 'AUTH'], [429, 'RATE_LIMIT']] as const) {
    it(`preserves HTTP ${status} as ${code} and cancels the unused stream and GM request`, async () => {
      const provider = new OpenAICompatibleProvider({ provider: 'deepseek', apiKey: KEY, model: 'fixture-model', baseUrl: 'https://transport-fixture.invalid' }, createGMFetch(ENDPOINT));
      const pending = observed(collect(provider));
      const source = stream();
      requests[0]!.details.onloadstart(response({ status, response: source.body }));
      await expect(pending).rejects.toMatchObject({ code });
      await settle();
      expect(requests[0]!.abort).toHaveBeenCalledOnce();
      expect(source.cancel).toHaveBeenCalledOnce();
    });
  }

  it('does not send a request that was already cancelled', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(request({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(requests).toHaveLength(0);
  });

  it('does not send after cancellation during an asynchronous permission or cooldown check', async () => {
    let release!: () => void;
    const preparation = new Promise<void>(resolve => { release = resolve; });
    const controller = new AbortController();
    const pending = request({ signal: controller.signal }, () => preparation);
    controller.abort(); release();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(requests).toHaveLength(0);
  });

  it('cancels the underlying GM request and reader when the exposed body is cancelled', async () => {
    const pending = request();
    const source = stream();
    requests[0]!.details.onloadstart(response({ response: source.body }));
    await (await pending).body!.cancel();
    await settle();
    expect(requests[0]!.abort).toHaveBeenCalledOnce();
    expect(source.cancel).toHaveBeenCalledOnce();
  });

  it('enforces its own timeout even when Tampermonkey fetch mode ignores details.timeout', async () => {
    vi.useFakeTimers();
    const pending = request();
    const failed = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT', retryable: true });
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await failed;
    expect(requests[0]!.abort).toHaveBeenCalledOnce();
  });

  for (const fields of [{ status: 302 }, { finalUrl: 'https://different-fixture.invalid/chat/completions' }]) {
    it(`rejects a ${fields.status ? 'redirect status' : 'different final destination'} and stops the GM request`, async () => {
      const pending = request();
      requests[0]!.details.onloadstart(response(fields));
      await expect(pending).rejects.toMatchObject({ code: 'NETWORK', retryable: false });
      expect(requests[0]!.abort).toHaveBeenCalledOnce();
      expect(requests[0]!.details).toMatchObject({ anonymous: true, redirect: 'error' });
    });
  }

  it('refuses a different caller-supplied destination before GM receives the Key', async () => {
    await expect(createGMFetch(ENDPOINT)('https://different-fixture.invalid/chat/completions', {
      method: 'POST', body: '{}', credentials: 'omit', redirect: 'error', headers: { Authorization: `Bearer ${KEY}` },
    })).rejects.toMatchObject({ code: 'CONFIG' });
    expect(requests).toHaveLength(0);
  });
});
