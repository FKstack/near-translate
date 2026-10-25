import type { TranslationRateLimitDiagnostic } from '../shared/contracts';

/** Never retain upstream text, request content, destinations or credentials. */
export function publicDeepLRateDiagnostic(value: unknown): TranslationRateLimitDiagnostic | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const item = value as Record<string, unknown>;
  if (item.origin !== undefined && item.origin !== 'upstream') return;
  const source = item.source ?? (item.httpStatus === 429 ? 'http-429' : undefined);
  if (source !== 'http-429' && source !== 'json-too-many-requests') return;
  if (typeof item.httpStatus !== 'number' || !Number.isInteger(item.httpStatus) || item.httpStatus < 200 || item.httpStatus > 599
    || source === 'http-429' && item.httpStatus !== 429
    || typeof item.at !== 'number' || !Number.isSafeInteger(item.at) || item.at < 0) return;
  const result: TranslationRateLimitDiagnostic = { source, httpStatus: item.httpStatus, at: item.at };
  if (typeof item.retryAfterMs === 'number' && Number.isFinite(item.retryAfterMs) && item.retryAfterMs >= 0
    && item.retryAfterMs <= Number.MAX_SAFE_INTEGER) result.retryAfterMs = item.retryAfterMs;
  if (typeof item.responseReason === 'string' && ['rate-limit', 'quota', 'concurrency', 'payload-limit', 'authentication'].includes(item.responseReason))
    result.responseReason = item.responseReason as TranslationRateLimitDiagnostic['responseReason'];
  return result;
}
