import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLIENT_TIMEOUT_MS, HEARTBEAT_MS, type TranslationServerMessage } from '../../src/shared/contracts';

const mock = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock('wxt/browser', () => ({ browser: { runtime: { connect: mock.connect } } }));
import { TranslationClient } from '../../src/selection/client';

function fakePort() {
  const messages = new Set<(message: TranslationServerMessage) => void>();
  const disconnects = new Set<() => void>();
  return {
    postMessage: vi.fn(),
    disconnect: vi.fn(() => { for (const listener of disconnects) listener(); }),
    onMessage: { addListener: (listener: (message: TranslationServerMessage) => void) => messages.add(listener) },
    onDisconnect: { addListener: (listener: () => void) => disconnects.add(listener) },
    receive: (event: TranslationServerMessage) => { for (const listener of messages) listener(event); },
  };
}

describe('selection request lifecycle', () => {
  beforeEach(() => { vi.useFakeTimers(); mock.connect.mockReset(); });
  afterEach(() => { vi.useRealTimers(); });

  it('sends heartbeats only while active and suppresses cancelled results', () => {
    const port = fakePort();
    mock.connect.mockReturnValue(port);
    const events = vi.fn();
    const client = new TranslationClient(events);
    const first = client.start({ text: 'bank', kind: 'word' });
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(port.postMessage).toHaveBeenLastCalledWith({ type: 'heartbeat', requestId: first });
    const second = client.start({ text: 'Hello world.', kind: 'text' });
    expect(port.postMessage).toHaveBeenCalledWith({ type: 'cancel', requestId: first });
    port.receive({ type: 'result', requestId: first, result: { kind: 'text', translation: '旧结果' } });
    expect(events).not.toHaveBeenCalled();
    port.receive({ type: 'result', requestId: second, result: { kind: 'text', translation: '你好，世界。' } });
    expect(events).toHaveBeenCalledTimes(1);
    const calls = port.postMessage.mock.calls.length;
    vi.advanceTimersByTime(CLIENT_TIMEOUT_MS);
    expect(port.postMessage.mock.calls.length).toBe(calls);
    client.dispose();
  });

  it('cancels a stalled request at the frontend deadline', () => {
    const port = fakePort();
    mock.connect.mockReturnValue(port);
    const events = vi.fn();
    const client = new TranslationClient(events);
    const requestId = client.start({ text: 'timeout', kind: 'word' });
    vi.advanceTimersByTime(CLIENT_TIMEOUT_MS);
    expect(port.postMessage).toHaveBeenLastCalledWith({ type: 'cancel', requestId });
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', requestId, error: expect.objectContaining({ code: 'TIMEOUT' }) }));
    client.dispose();
  });

  it('reports worker disconnection once and reconnects on explicit retry', () => {
    const firstPort = fakePort();
    const secondPort = fakePort();
    mock.connect.mockReturnValueOnce(firstPort).mockReturnValueOnce(secondPort);
    const events = vi.fn();
    const client = new TranslationClient(events);
    const first = client.start({ text: 'connection', kind: 'word' });
    firstPort.disconnect();
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', requestId: first, error: expect.objectContaining({ code: 'DISCONNECTED' }) }));
    client.start({ text: 'retry', kind: 'word' });
    expect(mock.connect).toHaveBeenCalledTimes(2);
    client.dispose();
    expect(events).toHaveBeenCalledTimes(1);
    expect(secondPort.disconnect).toHaveBeenCalledOnce();
  });

  it('drops callbacks and clears all timers after disposal', () => {
    const port = fakePort();
    mock.connect.mockReturnValue(port);
    const events = vi.fn();
    const client = new TranslationClient(events);
    const requestId = client.start({ text: 'cleanup', kind: 'word' });
    client.dispose();
    port.receive({ type: 'error', requestId, error: { code: 'SERVER', message: 'late', retryable: true } });
    vi.advanceTimersByTime(CLIENT_TIMEOUT_MS);
    expect(events).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
