import { browser } from 'wxt/browser';
import {
  CLIENT_TIMEOUT_MS,
  HEARTBEAT_MS,
  TRANSLATION_PORT,
  type TranslationInput,
  type TranslationClientMessage,
  type TranslationServerMessage,
  type TranslationError,
} from '../shared/contracts';

/** One owner for a single page's connection and active translation lifecycle. */
export class TranslationClient {
  private port?: ReturnType<typeof browser.runtime.connect>;
  private active?: string;
  private timeout?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private disposed = false;
  // Requests are scoped to this client's Port; keep IDs distinct across retries and reconnects.
  private requestSequence = 0;

  constructor(private readonly onEvent: (event: TranslationServerMessage) => void) {}

  start(input: TranslationInput): string {
    this.cancel();
    const requestId = `request-${++this.requestSequence}`;
    if (this.disposed) return requestId;
    this.active = requestId;
    try {
      this.ensurePort();
      this.send({ type: 'translate', requestId, input });
      this.timeout = setTimeout(() => {
        if (this.active !== requestId) return;
        this.send({ type: 'cancel', requestId });
        this.fail(requestId, { code: 'TIMEOUT', message: '翻译等待时间过长，请重试。', retryable: true });
      }, CLIENT_TIMEOUT_MS);
      this.heartbeat = setInterval(() => {
        if (this.active === requestId) this.send({ type: 'heartbeat', requestId });
      }, HEARTBEAT_MS);
    } catch {
      // Defer failure until the controller has installed the new request ID.
      queueMicrotask(() => this.fail(requestId, { code: 'DISCONNECTED', message: '扩展连接已断开，请刷新页面后重试。', retryable: true }));
    }
    return requestId;
  }

  cancel(): void {
    if (this.active) this.send({ type: 'cancel', requestId: this.active });
    this.finish();
  }

  dispose(): void {
    this.cancel();
    this.disposed = true;
    this.port?.disconnect();
    this.port = undefined;
  }

  private ensurePort(): void {
    if (this.port) return;
    const port = browser.runtime.connect({ name: TRANSLATION_PORT });
    this.port = port;
    port.onMessage.addListener((message: TranslationServerMessage) => {
      if (this.disposed || message.requestId !== this.active) return;
      // A terminal callback may synchronously start the independent analysis request.
      if (message.type === 'result' || message.type === 'analysis' || message.type === 'error') this.finish();
      this.onEvent(message);
    });
    port.onDisconnect.addListener(() => {
      if (this.port !== port) return;
      this.port = undefined;
      const requestId = this.active;
      if (!this.disposed && requestId) this.fail(requestId, {
        code: 'DISCONNECTED', message: '后台连接已中断，请重试；若扩展刚更新，请刷新页面。', retryable: true,
      });
    });
  }

  private send(message: TranslationClientMessage): void {
    try { this.port?.postMessage(message); } catch {
      const stalePort = this.port;
      this.port = undefined;
      try { stalePort?.disconnect(); } catch { /* Invalidated extension contexts cannot disconnect. */ }
      const requestId = this.active;
      if (requestId) queueMicrotask(() => this.fail(requestId, {
        code: 'DISCONNECTED', message: '扩展连接已中断，请刷新页面后重试。', retryable: true,
      }));
    }
  }

  private fail(requestId: string, error: TranslationError): void {
    if (this.disposed || this.active !== requestId) return;
    this.finish();
    this.onEvent({ type: 'error', requestId, error });
  }

  private finish(): void {
    clearTimeout(this.timeout);
    clearInterval(this.heartbeat);
    this.timeout = undefined;
    this.heartbeat = undefined;
    this.active = undefined;
  }
}
