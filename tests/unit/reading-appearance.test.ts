import { describe, expect, it } from 'vitest';
import { DEFAULT_READING_PREFERENCES, READING_PRESETS, normalizeReadingPreferences, readingStyle, applyReadingStyle } from '../../src/shared/reading';
import { bestTextColor, contrastRatio, readingAppearanceVariables } from '../../src/shared/reading-appearance';

describe('personal reading styles', () => {
  it('upgrades old preferences while retaining every existing choice', () => {
    const old = { theme: 'dark', fontSize: 24, lineHeight: 2, width: 'wide', fontFamily: 'sans', mode: 'bilingual', focus: true };
    expect(normalizeReadingPreferences(old)).toEqual({ ...DEFAULT_READING_PREFERENCES, ...old });
  });

  it.each([
    ['columnWidth', -1, 480], ['columnWidth', 1500, 1080], ['letterSpacing', .5, .12],
    ['wordSpacing', .5, .2], ['paragraphSpacing', .1, .6], ['paragraphSpacing', 3, 2],
    ['translationScale', 0, .8], ['translationScale', 99, 1.2], ['wordSpacing', -.1, 0],
  ])('bounds %s without invalid CSS or oversized layout', (key, value, expected) => {
    expect(normalizeReadingPreferences({ [key]: value })[key as keyof typeof DEFAULT_READING_PREFERENCES]).toBe(expected);
  });

  it('accepts only finite numeric values, known layout options and six-digit opaque colors', () => {
    const value = normalizeReadingPreferences({ columnWidth: Infinity, wordSpacing: NaN, codeWrap: 'true',
      translationStyle: 'html', textAlign: 'unsafe', colors: { background: '#AACCEE', text: 'red; background:url(https://private/)', accent: '#fff' } });
    expect(value).toMatchObject({ columnWidth: 720, wordSpacing: 0, codeWrap: false, textAlign: 'start', translationStyle: 'line',
      colors: { background: '#aaccee', text: '#293c32', accent: '#28664b' } });
  });

  it('stores only one independent appearance snapshot, stripping content, mode and nested profiles', () => {
    const input = { ...DEFAULT_READING_PREFERENCES, savedStyle: { theme: 'paper', mode: 'translation',
      article: 'private body', url: 'private URL', apiKey: 'private Key', savedStyle: { theme: 'dark' },
      colors: { background: '#112233', text: '#eeeeee', accent: '#abcdef', private: 'private' } } };
    const result = normalizeReadingPreferences(input);
    expect(result.savedStyle).toEqual({ ...readingStyle({ ...DEFAULT_READING_PREFERENCES }), theme: 'paper',
      colors: { background: '#112233', text: '#eeeeee', accent: '#abcdef' } });
    expect(JSON.stringify(result)).not.toContain('private');
    expect(result.savedStyle).not.toHaveProperty('savedStyle');
    expect(result.savedStyle).not.toHaveProperty('mode');
    result.savedStyle!.colors.text = '#ffffff';
    expect(input.savedStyle.colors.text).toBe('#eeeeee');
    for (const malformed of [[], '', true, 123]) expect(normalizeReadingPreferences({ savedStyle: malformed }).savedStyle).toBeNull();
  });

  it('applies any scene or personal style without changing bilingual mode or the saved personal style', () => {
    const personal = readingStyle(normalizeReadingPreferences({ theme: 'custom', fontSize: 30 }));
    const previous = normalizeReadingPreferences({ mode: 'translation', savedStyle: personal, focus: true });
    for (const scene of READING_PRESETS) {
      const next = applyReadingStyle(previous, scene.style);
      expect(next.mode).toBe('translation');
      expect(next.savedStyle).toEqual(personal);
      expect(readingStyle(next)).toEqual(scene.style);
      next.colors.text = '#ffffff';
      expect(scene.style.colors.text).toBe(DEFAULT_READING_PREFERENCES.colors.text);
    }
    expect(applyReadingStyle(previous, personal)).toMatchObject({ theme: 'custom', fontSize: 30, mode: 'translation', savedStyle: personal });
  });
});

describe('reading appearance and contrast', () => {
  it('computes standard relative-luminance contrast and selects a readable opposite foreground', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBe(21);
    expect(contrastRatio('#112233', '#112233')).toBe(1);
    expect(contrastRatio('#ffffff', '#000000')).toBe(21);
    for (const background of ['#777777', '#0099aa', '#ffcc00', '#440044', '#ffffff', '#000000']) {
      expect(contrastRatio(bestTextColor(background), background)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps system themes in CSS while applying all bounded typography variables', () => {
    const variables = readingAppearanceVariables(normalizeReadingPreferences({ theme: 'system', width: 'custom',
      columnWidth: 910, fontSize: 26, lineHeight: 2.1, letterSpacing: .12, wordSpacing: .16, paragraphSpacing: 2, translationScale: .9, textAlign: 'justify' }));
    expect(variables).toEqual({ '--nr-font-size': '26px', '--nr-line-height': 2.1, '--nr-column': '910px',
      '--nr-letter-spacing': '0.12em', '--nr-word-spacing': '0.16em', '--nr-paragraph-spacing': '2em', '--nr-text-align': 'justify', '--nr-translation-scale': .9 });
  });

  it('honors the custom body color while preserving readable controls and links during low-contrast experiments', () => {
    const colors = { background: '#eeeeee', text: '#dddddd', accent: '#eeeeee' };
    const variables = readingAppearanceVariables(normalizeReadingPreferences({ theme: 'custom', colors }));
    expect(variables['--nr-body-text']).toBe(colors.text);
    expect(variables['--nr-bg']).toBe(colors.background);
    expect(contrastRatio(String(variables['--nr-text']), colors.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(String(variables['--nr-accent']), colors.background)).toBeGreaterThanOrEqual(4.5);
    expect(variables.colorScheme).toBe('light');
    expect(readingAppearanceVariables(normalizeReadingPreferences({ theme: 'custom', colors: { ...colors, background: '#111111' } })).colorScheme).toBe('dark');
  });

  it.each(['#ffffff', '#777777', '#000000'])('keeps control text readable on every derived surface for %s', background => {
    const variables = readingAppearanceVariables(normalizeReadingPreferences({ theme: 'custom',
      colors: { background, text: '#767676', accent: '#767676' } }));
    for (const surface of ['--nr-bg', '--nr-panel', '--nr-control', '--nr-hover', '--nr-accent-soft']) {
      expect(contrastRatio(String(variables['--nr-text']), String(variables[surface]))).toBeGreaterThanOrEqual(4.5);
    }
    for (const surface of ['--nr-bg', '--nr-control', '--nr-hover', '--nr-accent-soft']) {
      expect(contrastRatio(String(variables['--nr-accent']), String(variables[surface]))).toBeGreaterThanOrEqual(4.5);
    }
  });
});
