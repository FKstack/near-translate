import type { ErrorCode, TranslationError } from '../shared/contracts';

/** Carries safe, user-facing failure information across the provider boundary. */
export class TranslationFailure extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, retryable = false) {
    super(message);
    this.name = 'TranslationFailure';
    this.code = code;
    this.retryable = retryable;
  }
}

export function toTranslationError(error: unknown): TranslationError {
  if (error instanceof TranslationFailure) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return { code: 'DISCONNECTED', message: '翻译请求已取消。', retryable: true };
  }
  if (error instanceof TypeError) {
    return { code: 'NETWORK', message: '无法连接 DeepSeek，请检查网络后重试。', retryable: true };
  }
  // Never send an arbitrary server/browser exception (which may contain secrets) to a page.
  return { code: 'SERVER', message: '翻译暂时失败，请稍后重试。', retryable: true };
}

export function httpFailure(status: number): TranslationFailure {
  if (status === 401 || status === 403) {
    return new TranslationFailure('AUTH', 'API Key 无效或没有访问权限，请在设置中检查。');
  }
  if (status === 402) {
    return new TranslationFailure('BALANCE', 'DeepSeek 账户余额不足，请充值后重试。');
  }
  if (status === 429) {
    return new TranslationFailure('RATE_LIMIT', '请求过于频繁，请稍后重试。', true);
  }
  if (status === 408 || status === 504) {
    return new TranslationFailure('TIMEOUT', 'DeepSeek 响应超时，请重试。', true);
  }
  if (status === 400 || status === 404 || status === 422) {
    return new TranslationFailure('CONFIG', 'DeepSeek 拒绝了请求，请检查设置中的模型名称。');
  }
  return new TranslationFailure('SERVER', `DeepSeek 服务暂时不可用（HTTP ${status}），请稍后重试。`, true);
}
