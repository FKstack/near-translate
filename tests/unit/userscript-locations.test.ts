import { describe, expect, it } from 'vitest';
import { isSettingsPage, SETTINGS_URL } from '../../src/userscript/locations';

describe('userscript credential entry location', () => {
  it('accepts the dedicated settings document and its own fragments', () => {
    expect(isSettingsPage(SETTINGS_URL)).toBe(true);
    expect(isSettingsPage(`${SETTINGS_URL}#model`)).toBe(true);
  });

  it('rejects articles, lookalike domains, untrusted protocols and neighboring paths', () => {
    for (const href of [
      'https://example.com/article',
      'https://fkstack.github.io.attacker.example/near-translate/userscript/settings.html',
      'https://fkstack.github.io@attacker.example/near-translate/userscript/settings.html',
      'http://fkstack.github.io/near-translate/userscript/settings.html',
      'https://fkstack.github.io/another-project/userscript/settings.html',
      'https://fkstack.github.io/near-translate/userscript/settings.html/extra',
      'https://fkstack.github.io/near-translate/userscript/index.html',
      'javascript:alert(1)',
      'not a URL',
    ]) expect(isSettingsPage(href)).toBe(false);
  });
});
