import { describe, expect, it } from 'vitest';
import { publicDeepLRateDiagnostic } from '../../src/shared/translation-diagnostic';

describe('public DeepL rate diagnostic whitelist', () => {
  it('exposes status and safe clues without copying text, addresses or credentials', () => {
    expect(publicDeepLRateDiagnostic({ origin: 'upstream', source: 'http-429', httpStatus: 429, at: 1234,
      retryAfterMs: 120_000, responseReason: 'quota', body: 'private-original-text', url: 'https://private.example', key: 'private-key' }))
      .toEqual({ source: 'http-429', httpStatus: 429, at: 1234, retryAfterMs: 120_000, responseReason: 'quota' });
  });
  it('keeps a JSON limit distinct from an HTTP 429', () => {
    expect(publicDeepLRateDiagnostic({ source: 'json-too-many-requests', httpStatus: 200, at: 1234 }))
      .toEqual({ source: 'json-too-many-requests', httpStatus: 200, at: 1234 });
    expect(publicDeepLRateDiagnostic({ source: 'http-429', httpStatus: 200, at: 1234 })).toBeUndefined();
  });
  it('accepts a legacy HTTP diagnostic without inventing a status for local rejection', () => {
    expect(publicDeepLRateDiagnostic({ httpStatus: 429, at: 1234 }))
      .toEqual({ source: 'http-429', httpStatus: 429, at: 1234 });
    expect(publicDeepLRateDiagnostic({ source: 'local-capacity', httpStatus: 429, at: 1234 })).toBeUndefined();
  });
  it('omits invalid optional fields and rejects invalid required fields', () => {
    expect(publicDeepLRateDiagnostic({ source: 'http-429', httpStatus: 429, at: 1234, retryAfterMs: Infinity, responseReason: 'private-body' }))
      .toEqual({ source: 'http-429', httpStatus: 429, at: 1234 });
    for (const value of [null, {}, { httpStatus: 429, at: NaN }, { httpStatus: 429, at: -1 },
      { origin: 'local', httpStatus: 429, at: 1234 }, { source: 'json-too-many-requests', httpStatus: 999, at: 1234 }])
      expect(publicDeepLRateDiagnostic(value)).toBeUndefined();
  });
  it('never coerces or retains a non-string response reason', () => {
    const reason = { privateText: 'private-original', toString() { throw new Error('Coercion must not run'); } };
    expect(publicDeepLRateDiagnostic({ source: 'http-429', httpStatus: 429, at: 1234, responseReason: reason }))
      .toEqual({ source: 'http-429', httpStatus: 429, at: 1234 });
    expect(publicDeepLRateDiagnostic({ source: 'http-429', httpStatus: 429, at: 1234,
      responseReason: { privateText: 'private-original', toString: () => 'quota' } }))
      .toEqual({ source: 'http-429', httpStatus: 429, at: 1234 });
  });
});
