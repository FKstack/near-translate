import type { ErrorCode, TranslationError } from '../shared/contracts';

/** Carries safe, user-facing failure information across the provider boundary. */
export class TranslationFailure extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly retryAt?: number;
  readonly serviceWide?: true;

  constructor(code: ErrorCode, message: string, retryable = false, retryAt?: number, serviceWide?: true) {
    super(message);
    this.name = 'TranslationFailure';
    this.code = code;
    this.retryable = retryable;
    if (code === 'RATE_LIMIT' && retryable && Number.isSafeInteger(retryAt) && retryAt! >= 0) this.retryAt = retryAt;
    if (serviceWide === true) this.serviceWide = true;
  }
}

export function toTranslationError(error: unknown): TranslationError {
  if (error instanceof TranslationFailure) {
    return { code: error.code, message: error.message, retryable: error.retryable,
      ...(error.retryAt !== undefined ? { retryAt: error.retryAt } : {}),
      ...(error.serviceWide === true ? { serviceWide: true } : {}) };
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return { code: 'DISCONNECTED', message: '翻译请求已取消。', retryable: true };
  }
  if (error instanceof TypeError) {
    return { code: 'NETWORK', message: '无法连接翻译服务，请检查网络后重试。', retryable: true };
  }
  // Never send an arbitrary server/browser exception (which may contain secrets) to a page.
  return { code: 'SERVER', message: '翻译暂时失败，请稍后重试。', retryable: true };
}

export function httpFailure(status: number): TranslationFailure {
  if (status === 401 || status === 403) {
    return new TranslationFailure('AUTH', 'API Key 无效或没有访问权限，请在设置中检查。');
  }
  if (status === 402) {
    return new TranslationFailure('BALANCE', '翻译服务账户余额不足，请充值后重试。');
  }
  if (status === 429) {
    return new TranslationFailure('RATE_LIMIT', '请求过于频繁，请稍后重试。', true);
  }
  if (status === 408 || status === 504) {
    return new TranslationFailure('TIMEOUT', '翻译服务响应超时，请重试。', true);
  }
  if (status === 400 || status === 404 || status === 422) {
    return new TranslationFailure('CONFIG', '翻译服务拒绝了请求，请检查 API 地址、模型名称与接口兼容性。');
  }
  return new TranslationFailure('SERVER', `翻译服务服务暂时不可用（HTTP ${status}），请稍后重试。`, true);
}
