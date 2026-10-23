export interface ReadingColors { background: string; text: string; accent: string }

/** A bounded visual style, independent of article content and translation mode. */
export interface ReadingStyle {
  theme: 'paper' | 'sepia' | 'dark' | 'system' | 'contrast' | 'custom';
  fontSize: number;
  lineHeight: number;
  width: 'narrow' | 'comfortable' | 'wide' | 'custom';
  columnWidth: number;
  fontFamily: 'serif' | 'sans';
  focus: boolean;
  letterSpacing: number;
  wordSpacing: number;
  paragraphSpacing: number;
  textAlign: 'start' | 'justify';
  codeWrap: boolean;
  translationScale: number;
  translationStyle: 'line' | 'card' | 'plain';
  colors: ReadingColors;
}

/** Content-free reading preferences. Article text and browsing history are never persisted. */
export interface ReadingPreferences extends ReadingStyle {
  mode: 'original' | 'bilingual' | 'translation';
  savedStyle: ReadingStyle | null;
}

export const DEFAULT_READING_PREFERENCES: Readonly<ReadingPreferences> = Object.freeze({
  theme: 'sepia', fontSize: 20, lineHeight: 1.85, width: 'comfortable',
  columnWidth: 720, fontFamily: 'serif', mode: 'original', focus: false,
  letterSpacing: 0, wordSpacing: 0, paragraphSpacing: 1.35, textAlign: 'start', codeWrap: false,
  translationScale: 1, translationStyle: 'line',
  colors: Object.freeze({ background: '#f7f3e9', text: '#293c32', accent: '#28664b' }), savedStyle: null,
});

function record(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
}

function number(input: unknown, fallback: number, min: number, max: number, precision = 100): number {
  return typeof input === 'number' && Number.isFinite(input)
    ? Math.max(min, Math.min(max, Math.round(input * precision) / precision)) : fallback;
}

function choice<T extends string>(input: unknown, values: readonly T[], fallback: T): T {
  return typeof input === 'string' && values.includes(input as T) ? input as T : fallback;
}

function color(input: unknown, fallback: string): string {
  return typeof input === 'string' && /^#[a-f\d]{6}$/i.test(input) ? input.toLowerCase() : fallback;
}

function normalizeStyle(input: unknown): ReadingStyle {
  const value = record(input);
  const defaults = DEFAULT_READING_PREFERENCES;
  const colors = record(value.colors);
  return {
    theme: choice(value.theme, ['paper', 'sepia', 'dark', 'system', 'contrast', 'custom'], defaults.theme),
    fontSize: number(value.fontSize, defaults.fontSize, 14, 36, 1),
    lineHeight: number(value.lineHeight, defaults.lineHeight, 1.4, 2.4),
    width: choice(value.width, ['narrow', 'comfortable', 'wide', 'custom'], defaults.width),
    columnWidth: number(value.columnWidth, defaults.columnWidth, 480, 1080, 1),
    fontFamily: choice(value.fontFamily, ['serif', 'sans'], defaults.fontFamily),
    focus: value.focus === true,
    letterSpacing: number(value.letterSpacing, defaults.letterSpacing, 0, .12),
    wordSpacing: number(value.wordSpacing, defaults.wordSpacing, 0, .2),
    paragraphSpacing: number(value.paragraphSpacing, defaults.paragraphSpacing, .6, 2),
    textAlign: choice(value.textAlign, ['start', 'justify'], defaults.textAlign),
    codeWrap: value.codeWrap === true,
    translationScale: number(value.translationScale, defaults.translationScale, .8, 1.2),
    translationStyle: choice(value.translationStyle, ['line', 'card', 'plain'], defaults.translationStyle),
    colors: { background: color(colors.background, defaults.colors.background), text: color(colors.text, defaults.colors.text),
      accent: color(colors.accent, defaults.colors.accent) },
  };
}

export function normalizeReadingPreferences(input: unknown): ReadingPreferences {
  const value = record(input);
  return { ...normalizeStyle(value),
    mode: choice(value.mode, ['original', 'bilingual', 'translation'], DEFAULT_READING_PREFERENCES.mode),
    savedStyle: value.savedStyle && typeof value.savedStyle === 'object' && !Array.isArray(value.savedStyle)
      ? normalizeStyle(value.savedStyle) : null,
  };
}

/** Copies appearance only; saved styles never nest or capture the translation mode. */
export function readingStyle(preferences: ReadingPreferences): ReadingStyle {
  return normalizeStyle(preferences);
}

export function applyReadingStyle(preferences: ReadingPreferences, style: Partial<ReadingStyle>): ReadingPreferences {
  return normalizeReadingPreferences({ ...preferences, ...style, mode: preferences.mode, savedStyle: preferences.savedStyle });
}

export const READING_PRESETS: ReadonlyArray<{ id: string; label: string; description: string; style: ReadingStyle }> = [
  { id: 'longform', label: '舒适长读', description: '暖纸与舒展留白，慢慢读完长文章。', style: readingStyle({ ...DEFAULT_READING_PREFERENCES }) },
  { id: 'technical', label: '技术文档', description: '清晰字体与宽栏，代码保留原有换行。', style: normalizeStyle({ ...DEFAULT_READING_PREFERENCES,
    theme: 'paper', fontFamily: 'sans', fontSize: 19, lineHeight: 1.75, width: 'wide', paragraphSpacing: 1.1 }) },
  { id: 'night', label: '夜间阅读', description: '深色底与稍大字号，适合较暗的环境。', style: normalizeStyle({ ...DEFAULT_READING_PREFERENCES,
    theme: 'dark', fontSize: 22, lineHeight: 1.9, width: 'comfortable', paragraphSpacing: 1.5 }) },
];
