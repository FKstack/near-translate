import type { ReadingPreferences } from './reading';

function channels(color: string): number[] {
  return [1, 3, 5].map(index => parseInt(color.slice(index, index + 2), 16));
}

function luminance(color: string): number {
  const [r, g, b] = channels(color).map(value => {
    const channel = value / 255;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  });
  return r! * .2126 + g! * .7152 + b! * .0722;
}

/** WCAG relative-luminance contrast for normalized opaque #rrggbb colors. */
export function contrastRatio(foreground: string, background: string): number {
  const first = luminance(foreground); const second = luminance(background);
  return (Math.max(first, second) + .05) / (Math.min(first, second) + .05);
}

export function bestTextColor(background: string): string {
  return contrastRatio('#ffffff', background) >= contrastRatio('#000000', background) ? '#ffffff' : '#000000';
}

function mix(background: string, foreground: string, amount: number): string {
  const base = channels(background); const ink = channels(foreground);
  return '#' + base.map((value, index) => Math.round(value * (1 - amount) + ink[index]! * amount)
    .toString(16).padStart(2, '0')).join('');
}

/** Presentation variables only; no CSS, URLs, article content, or font downloads. */
export function readingAppearanceVariables(preferences: ReadingPreferences): Record<string, string | number> {
  const widths = { narrow: 580, comfortable: 720, wide: 860, custom: preferences.columnWidth };
  const variables: Record<string, string | number> = {
    '--nr-font-size': `${preferences.fontSize}px`, '--nr-line-height': preferences.lineHeight,
    '--nr-column': `${widths[preferences.width]}px`, '--nr-letter-spacing': `${preferences.letterSpacing}em`,
    '--nr-word-spacing': `${preferences.wordSpacing}em`, '--nr-paragraph-spacing': `${preferences.paragraphSpacing}em`,
    '--nr-text-align': preferences.textAlign, '--nr-translation-scale': preferences.translationScale,
  };
  if (preferences.theme !== 'custom') return variables;
  const { background, text, accent } = preferences.colors;
  const uiText = contrastRatio(text, background) >= 4.5 ? text : bestTextColor(background);
  const uiAccent = contrastRatio(accent, background) >= 4.5 ? accent : uiText;
  const surface = (candidate: string, foregrounds: string[]) => foregrounds.every(ink => contrastRatio(ink, candidate) >= 4.5)
    ? candidate : background;
  // Keep controls readable even while the user experiments with a low-contrast body color.
  return { ...variables, '--nr-bg': background, '--nr-panel': surface(mix(background, uiText, .045), [uiText]),
    '--nr-text': uiText, '--nr-body-text': text, '--nr-title': uiText, '--nr-muted': uiText,
    '--nr-faint': mix(background, uiText, .25), '--nr-accent': uiAccent,
    '--nr-accent-soft': surface(mix(background, uiAccent, .1), [uiText, uiAccent]), '--nr-control': background,
    '--nr-hover': surface(mix(background, uiText, .08), [uiText, uiAccent]), '--nr-translated': uiText,
    '--nr-error': uiText, colorScheme: luminance(background) < .2 ? 'dark' : 'light' };
}
