import type { ConnectionSettings, TranslationError, TranslationServiceStatus } from '../../shared/contracts';

export const PUBLIC_TEST_SENTENCE = 'The library opens at nine in the morning.';
export interface FreeSetupClient {
  requestPermissions(): Promise<boolean>;
  sendMessage(message: { type: 'enable-free-translation' | 'test-free-translation' | 'get-translation-status' }): Promise<unknown>;
}
export interface FreeTestResult { translation: string; elapsedMs: number }

export class FreeSetupError extends Error {
  constructor(message: string, readonly translationError?: TranslationError) { super(message); this.name = 'FreeSetupError'; }
}

function response(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') throw new FreeSetupError('扩展暂时没有响应，请重新打开面板后重试。');
  const result = value as Record<string, unknown>;
  if (result.ok !== true) {
    const error = result.error;
    if (error && typeof error === 'object' && typeof (error as TranslationError).message === 'string') {
      throw new FreeSetupError((error as TranslationError).message, error as TranslationError);
    }
    throw new FreeSetupError(typeof error === 'string' ? error : '操作没有完成，请重试。');
  }
  return result;
}

/** Invoke the permission request immediately, in the original click's user gesture. */
export async function enableFreeTranslation(client: FreeSetupClient): Promise<ConnectionSettings> {
  const permission = client.requestPermissions();
  if (!await permission) throw new FreeSetupError('未授予翻译权限，设置没有更改。你仍可使用本地阅读；准备好后可再次启用。');
  const result = response(await client.sendMessage({ type: 'enable-free-translation' }));
  if (!result.settings || typeof result.settings !== 'object' || !('profiles' in result.settings)) {
    throw new FreeSetupError('免费翻译已请求启用，但未能读取最新设置。请重新打开面板确认。');
  }
  return result.settings as ConnectionSettings;
}

/** Only an explicit test click calls this action. The background owns the fixed public sample. */
export async function testFreeTranslation(client: FreeSetupClient): Promise<FreeTestResult> {
  const result = response(await client.sendMessage({ type: 'test-free-translation' }));
  if (typeof result.translation !== 'string' || !result.translation.trim() || typeof result.elapsedMs !== 'number'
    || !Number.isFinite(result.elapsedMs) || result.elapsedMs < 0) throw new FreeSetupError('测试未返回完整译文，请稍后手动重试。');
  return { translation: result.translation, elapsedMs: result.elapsedMs };
}

export async function readFreeTranslationStatus(client: FreeSetupClient): Promise<TranslationServiceStatus> {
  const result = response(await client.sendMessage({ type: 'get-translation-status' }));
  const status = result.status as TranslationServiceStatus | undefined;
  if (!status || !['model', 'deepl-web'].includes(status.engine) || !Number.isFinite(status.cooldownUntil)
    || status.cooldownUntil < 0 || !Number.isFinite(status.checkedAt)) throw new FreeSetupError('暂时无法读取翻译服务状态。');
  return status;
}

export function remainingCooldownSeconds(until: number, now: number): number {
  return Number.isFinite(until) && Number.isFinite(now) ? Math.max(0, Math.ceil((until - now) / 1000)) : 0;
}
