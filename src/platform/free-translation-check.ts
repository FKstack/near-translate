import type { TranslationError, TranslationProvider } from '../shared/contracts';

export const FREE_TRANSLATION_SAMPLE = 'The library opens at nine in the morning.';
export type FreeTranslationCheckResult = { ok: true; translation: string; elapsedMs: number }
  | { ok: false; error: TranslationError };

/** Owns one explicit, public-text service check. The actual provider still owns the shared service budget. */
export class FreeTranslationCheck {
  private owner?: { controller: AbortController; result: Promise<FreeTranslationCheckResult> };

  constructor(private readonly provider: TranslationProvider, private readonly toError: (error: unknown) => TranslationError,
    private readonly clock = () => Date.now(), private readonly timeoutMs = 20_000) {}

  run(): Promise<FreeTranslationCheckResult> {
    if (this.owner) return this.owner.result;
    const startedAt = this.clock();
    const controller = new AbortController();
    let complete!: (result: FreeTranslationCheckResult) => void;
    const owner = { controller, result: new Promise<FreeTranslationCheckResult>(resolve => { complete = resolve; }) };
    this.owner = owner;
    let settled = false;
    let timedOut = false;
    const finish = (value: FreeTranslationCheckResult) => { if (!settled) { settled = true; complete(value); } };
    const abort = () => finish({ ok: false, error: timedOut
      ? { code: 'TIMEOUT', message: '测试等待超过 20 秒，请稍后再试。', retryable: true }
      : { code: 'DISCONNECTED', message: '测试已取消，可以重新测试。', retryable: true } });
    controller.signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    void (async () => {
      try {
        let translation = '';
        for await (const event of this.provider.translate({ text: FREE_TRANSLATION_SAMPLE, kind: 'text',
          sourceLanguage: 'en', targetLanguage: 'zh-Hans' }, controller.signal)) {
          if (controller.signal.aborted) break;
          if (event.type === 'result' && event.result.kind === 'text') translation = event.result.translation;
        }
        if (controller.signal.aborted) return;
        if (!translation.trim() || translation.length > 2_000) {
          finish({ ok: false, error: { code: 'INVALID_RESPONSE', message: '测试未收到完整译文，请重试。', retryable: true } });
        } else finish({ ok: true, translation, elapsedMs: Math.max(0, this.clock() - startedAt) });
      } catch (error) {
        if (!controller.signal.aborted) finish({ ok: false, error: this.toError(error) });
      } finally {
        clearTimeout(timeout); controller.signal.removeEventListener('abort', abort);
        // An ignored abort keeps the single owner occupied until the provider really releases its work.
        if (this.owner === owner) this.owner = undefined;
      }
    })();
    return owner.result;
  }

  cancel(): void { this.owner?.controller.abort(); }
}
