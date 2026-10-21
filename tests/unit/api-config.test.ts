import { describe, expect, it } from 'vitest';
import { apiOriginPattern, completionEndpoint, normalizeBaseUrl, PROVIDERS } from '../../src/shared/api-config';

describe('API connection addresses', () => {
  it('normalizes base and complete endpoints without duplicating paths', () => {
    expect(completionEndpoint(' https://example.com/gateway/v1/chat/completions/ ')).toBe('https://example.com/gateway/v1/chat/completions');
    expect(completionEndpoint('https://api.deepseek.com')).toBe('https://api.deepseek.com/chat/completions');
  });

  it.each([
    ['http://localhost:11434/v1', 'http://localhost/*'],
    ['http://127.0.0.1:1234/v1', 'http://127.0.0.1/*'],
    ['http://[::1]:11434/v1', 'http://[::1]/*'],
  ])('allows local API %s', (value, pattern) => {
    expect(normalizeBaseUrl(value)).toBe(value);
    expect(apiOriginPattern(value)).toBe(pattern);
  });

  it.each(['https://key:secret@example.com/v1', 'https://example.com/v1?key=secret', 'https://example.com/v1#key', 'http://example.com/v1', 'file:///tmp/api', 'javascript:alert(1)', 'https://example.com/\nkey', 'https://example.com\\evil'])('rejects unsafe API address %s', value => {
    expect(() => normalizeBaseUrl(value)).toThrow();
  });

  it('has unique preset identifiers and valid preset endpoints', () => {
    expect(new Set(PROVIDERS.map(value => value.id)).size).toBe(PROVIDERS.length);
    for (const preset of PROVIDERS.filter(value => value.baseUrl)) expect(completionEndpoint(preset.baseUrl)).toMatch(/\/chat\/completions$/);
  });
});
