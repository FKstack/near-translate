import { normalizeReadingPreferences, readingStyle, type ReadingPreferences, type ReadingStyle } from './reading';

export const MAX_READING_STYLE_FILE_BYTES = 16_384;
const FORMAT = 'near-translate-reading-style';

/** Portable appearance only: never exports reading mode, saved profiles, content, URLs or credentials. */
export function serializeReadingStyle(preferences: ReadingPreferences): string {
  return JSON.stringify({ format: FORMAT, version: 1, style: readingStyle(preferences) }, null, 2) + '\n';
}

export function parseReadingStyleFile(text: string): ReadingStyle {
  if (new TextEncoder().encode(text).byteLength > MAX_READING_STYLE_FILE_BYTES) throw new Error('版式文件过大，请选择 16 KB 以内的近译版式 JSON。');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('无法读取版式文件，请选择有效的 JSON 文件。'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('这不是近译版式文件。');
  const envelope = value as Record<string, unknown>;
  if (envelope.format !== FORMAT || envelope.version !== 1) throw new Error('版式文件格式或版本不受支持，当前设置未更改。');
  if (!envelope.style || typeof envelope.style !== 'object' || Array.isArray(envelope.style)) throw new Error('版式内容不完整，当前设置未更改。');
  const source = envelope.style as Record<string, unknown>;
  const style = readingStyle(normalizeReadingPreferences(source));
  for (const key of Object.keys(style) as Array<keyof ReadingStyle>) {
    if (key === 'colors') {
      const colors = source.colors;
      if (!colors || typeof colors !== 'object' || Array.isArray(colors)
        || !['background', 'text', 'accent'].every(color => typeof (colors as Record<string, unknown>)[color] === 'string'
          && /^#[a-f\d]{6}$/i.test((colors as Record<string, string>)[color]!))) {
        throw new Error('版式中的配色无效，当前设置未更改。');
      }
    } else if (source[key] !== style[key]) throw new Error('版式包含缺失或超出范围的设置，当前设置未更改。');
  }
  return style;
}
