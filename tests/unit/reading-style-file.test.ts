import { describe, expect, it } from 'vitest';
import { DEFAULT_READING_PREFERENCES, normalizeReadingPreferences, readingStyle } from '../../src/shared/reading';
import { MAX_READING_STYLE_FILE_BYTES, parseReadingStyleFile, serializeReadingStyle } from '../../src/shared/reading-style-file';

describe('portable reading styles', () => {
  const current = normalizeReadingPreferences({ ...DEFAULT_READING_PREFERENCES, theme: 'custom', fontSize: 26,
    width: 'custom', columnWidth: 900, letterSpacing: .12, wordSpacing: .16, paragraphSpacing: 2,
    codeWrap: true, translationStyle: 'card', translationScale: .9, mode: 'bilingual',
    savedStyle: { theme: 'dark', article: 'private-saved-content' }, article: 'private-body', url: 'private-url', apiKey: 'private-key' });

  it('round trips only the current appearance without article content, mode or a second profile', () => {
    const json = serializeReadingStyle(current);
    expect(parseReadingStyleFile(json)).toEqual(readingStyle(current));
    expect(json).not.toMatch(/private|savedStyle|mode|apiKey|article|url/);
  });

  it('strips unknown nested and envelope fields, and accepts normalized upper-case opaque colors', () => {
    const envelope = JSON.parse(serializeReadingStyle(current));
    Object.assign(envelope, { apiKey: 'private-secret' });
    Object.assign(envelope.style, { article: 'private-body', savedStyle: { theme: 'paper' }, mode: 'translation' });
    Object.assign(envelope.style.colors, { text: '#AABBCC', url: 'private-url' });
    const style = parseReadingStyleFile(JSON.stringify(envelope));
    expect(style.colors.text).toBe('#aabbcc');
    expect(JSON.stringify(style)).not.toContain('private');
    expect(style).not.toHaveProperty('mode');
    expect(style).not.toHaveProperty('savedStyle');
  });

  it.each(['not JSON', 'null', '[]', '{}', '{"format":"near-translate-reading-style","version":999,"style":{}}'])('rejects malformed or unknown-version files: %s', json => {
    expect(() => parseReadingStyleFile(json)).toThrow();
  });

  it.each([{ fontSize: 999 }, { lineHeight: '2' }, { codeWrap: 'true' }, { translationScale: null },
    { theme: 'unsupported' }, { colors: { background: '#ffffff', text: 'red;url(x)', accent: '#123456' } }])('rejects invalid known fields without silently replacing the user style: %j', patch => {
    const envelope = JSON.parse(serializeReadingStyle(current)); Object.assign(envelope.style, patch);
    expect(() => parseReadingStyleFile(JSON.stringify(envelope))).toThrow();
    expect(current.fontSize).toBe(26);
  });

  it('rejects missing settings and excessive UTF-8 input before parsing', () => {
    const envelope = JSON.parse(serializeReadingStyle(current)); delete envelope.style.fontSize;
    expect(() => parseReadingStyleFile(JSON.stringify(envelope))).toThrow();
    expect(() => parseReadingStyleFile('中'.repeat(Math.ceil(MAX_READING_STYLE_FILE_BYTES / 3)))).toThrow('过大');
  });
});
