/** Pure PDF geometry reconstruction; coordinates use the viewport's top-left origin. */
export interface PdfTextRun {
  text: string;
  x: number;
  y: number;
  width: number;
  size: number;
  fontFamily?: string;
  fontName?: string;
}

export interface PdfTextLink { x: number; y: number; width: number; height: number; url: string }
export interface PdfLayoutOptions { format: 'markdown' | 'text'; width: number; links?: PdfTextLink[] }
export interface PdfLayoutResult { text: string; warnings: string[] }

interface Line { runs: PdfTextRun[]; x: number; y: number; right: number; size: number }

function median(values: number[]) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 12;
}

function makeLine(runs: PdfTextRun[]): Line {
  const ordered = runs.slice().sort((a, b) => a.x - b.x);
  return {
    runs: ordered, x: ordered.reduce((left, run) => Math.min(left, run.x), Number.POSITIVE_INFINITY),
    y: median(ordered.map((run) => run.y)),
    right: ordered.reduce((right, run) => Math.max(right, run.x + run.width), Number.NEGATIVE_INFINITY),
    size: median(ordered.map((run) => run.size)),
  };
}

function buildLines(runs: PdfTextRun[]) {
  const groups: PdfTextRun[][] = [];
  for (const run of runs.slice().sort((a, b) => a.y - b.y || a.x - b.x)) {
    const group = groups.at(-1);
    const previous = group?.[0];
    if (group && previous && Math.abs(run.y - previous.y) <= Math.max(2, Math.min(run.size, previous.size) * 0.3)) group.push(run);
    else groups.push([run]);
  }
  return groups.map(makeLine);
}

function cells(line: Line) {
  const result: PdfTextRun[][] = [];
  for (const run of line.runs) {
    const cell = result.at(-1);
    const previous = cell?.at(-1);
    if (!cell || (previous && run.x - previous.x - previous.width > Math.max(18, line.size * 1.8))) {
      result.push([run]);
    } else cell.push(run);
  }
  return result;
}

const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
function needsSpace(previous: string, next: string, gap: number, size: number) {
  if (/\s$/u.test(previous) || /^\s/u.test(next) || gap <= Math.max(0.5, size * 0.13)) return false;
  if (/[([{“‘]$/u.test(previous) || /^[,.;:!?，。；：！？、)\]}”’]/u.test(next)) return false;
  if (cjk.test(previous.slice(-1)) && cjk.test(next[0] ?? '')) return false;
  return true;
}

function rawText(runs: PdfTextRun[]) {
  let text = '';
  let previous: PdfTextRun | undefined;
  for (const run of runs) {
    if (previous && needsSpace(text, run.text, run.x - previous.x - previous.width, run.size)) text += ' ';
    text += run.text;
    previous = run;
  }
  return text.trim();
}

function escapeMarkdown(value: string) { return value.replace(/([\\`*_\[\]<>])/gu, '\\$1'); }

function safeUrl(value: string) {
  try {
    const url = new URL(value);
    return ['https:', 'http:', 'mailto:'].includes(url.protocol)
      ? url.href.replace(/[()\s<>]/gu, (character) => character === '(' ? '%28' : character === ')' ? '%29' : encodeURIComponent(character)) : null;
  } catch { return null; }
}

function linkForRun(run: PdfTextRun, links: PdfTextLink[]) {
  return links.find((link) => {
    const centerX = run.x + run.width / 2;
    const centerY = run.y - run.size / 2;
    return centerX >= link.x - 1 && centerX <= link.x + link.width + 1
      && centerY >= link.y - 2 && centerY <= link.y + link.height + 2;
  });
}

function renderRuns(runs: PdfTextRun[], options: PdfLayoutOptions) {
  if (options.format === 'text') return rawText(runs);
  const groups: Array<{ runs: PdfTextRun[]; url: string | null }> = [];
  for (const run of runs) {
    const link = linkForRun(run, options.links ?? []);
    const url = link ? safeUrl(link.url) : null;
    const previous = groups.at(-1);
    if (previous && previous.url === url) previous.runs.push(run);
    else groups.push({ runs: [run], url });
  }
  let text = '';
  let previous: PdfTextRun | undefined;
  for (const group of groups) {
    const first = group.runs[0]!;
    if (previous && needsSpace(text, first.text, first.x - previous.x - previous.width, first.size)) text += ' ';
    const label = escapeMarkdown(rawText(group.runs));
    text += group.url ? `[${label}](${group.url})` : label;
    previous = group.runs.at(-1);
  }
  return text.trim();
}

function columnGutter(lines: Line[], width: number) {
  const candidates: Array<{ x: number; gap: number }> = [];
  for (const line of lines) {
    const split = cells(line);
    if (split.length !== 2) continue;
    const left = split[0]!;
    const right = split[1]!;
    // Short aligned cells are more likely a table than newspaper columns.
    if (rawText(left).length < 22 || rawText(right).length < 22) continue;
    const end = Math.max(...left.map((run) => run.x + run.width));
    const start = right[0]!.x;
    if (start - end >= Math.max(width * 0.055, line.size * 3)) {
      candidates.push({ x: (start + end) / 2, gap: start - end });
    }
  }
  if (candidates.length < 3) return null;
  const gutter = median(candidates.map(({ x }) => x));
  return candidates.filter(({ x, gap }) => Math.abs(x - gutter) < gap / 2).length >= 3 ? gutter : null;
}

function columnRegions(lines: Line[], gutter: number | null): Line[][] {
  if (gutter === null) return [lines];
  // Restrict reordering to the vertical band supported by long column text.
  // Tables, headers and footers outside it must retain their own row structure.
  const evidence = lines.map((line, index) => {
    const split = cells(line);
    if (split.length !== 2 || rawText(split[0]!).length < 22 || rawText(split[1]!).length < 22) return -1;
    const leftEnd = split[0]!.reduce((end, run) => Math.max(end, run.x + run.width), 0);
    return leftEnd < gutter && split[1]![0]!.x > gutter ? index : -1;
  }).filter((index) => index >= 0);
  const first = evidence[0], last = evidence.at(-1);
  if (first === undefined || last === undefined) return [lines];
  const result: Line[][] = [];
  if (first > 0) result.push(lines.slice(0, first));
  let left: Line[] = [];
  let right: Line[] = [];
  const flush = () => {
    if (left.length) result.push(left);
    if (right.length) result.push(right);
    left = []; right = [];
  };
  for (const line of lines.slice(first, last + 1)) {
    const spanning = line.runs.some((run) => run.x < gutter && run.x + run.width > gutter);
    if (spanning) { flush(); result.push([line]); continue; }
    const leftRuns = line.runs.filter((run) => run.x + run.width / 2 < gutter);
    const rightRuns = line.runs.filter((run) => run.x + run.width / 2 >= gutter);
    if (leftRuns.length) left.push(makeLine(leftRuns));
    if (rightRuns.length) right.push(makeLine(rightRuns));
  }
  flush();
  if (last + 1 < lines.length) result.push(lines.slice(last + 1));
  return result;
}

function isMonospace(line: Line) {
  const text = rawText(line.runs);
  // Unembedded Type0 CJK fonts can report monospace despite being ordinary
  // prose. Equal-width CJK glyphs alone are not evidence of source code.
  if (cjk.test(text) && (text.match(/[\u0020-\u007e]/gu)?.length ?? 0) < text.length * 0.5) return false;
  const total = line.runs.reduce((sum, run) => sum + run.text.length, 0);
  const mono = line.runs.reduce((sum, run) => sum + (/mono|courier|consol|typewriter/iu.test(`${run.fontFamily} ${run.fontName}`) ? run.text.length : 0), 0);
  return total > 0 && mono / total >= 0.7;
}

function isList(text: string) { return /^(?:[•●▪◦‣⁃–—*-]|\d{1,3}[.)]|[a-zA-Z][.)])\s+/u.test(text); }

function headingLevel(line: Line, bodySize: number) {
  const text = rawText(line.runs);
  if (text.length > 160 || isList(text)) return 0;
  if (line.size >= bodySize * 1.65) return 1;
  if (line.size >= bodySize * 1.3) return 2;
  if (line.size >= bodySize * 1.14 && line.runs.some((run) => /bold|black|heavy|demi/iu.test(`${run.fontFamily} ${run.fontName}`))) return 3;
  return 0;
}

function tableLength(lines: Line[], start: number) {
  const first = cells(lines[start]!);
  if (first.length < 2 || first.length > 8 || first.some((cell) => rawText(cell).length > 55)) return 0;
  let end = start + 1;
  while (end < lines.length) {
    const previous = lines[end - 1]!;
    const current = lines[end]!;
    const next = cells(current);
    if (current.y - previous.y > Math.max(current.size, previous.size) * 2.2
      || next.length !== first.length || next.some((cell, index) =>
        rawText(cell).length > 55 || Math.abs(cell[0]!.x - first[index]![0]!.x) > Math.max(8, current.size * 0.8))) break;
    end++;
  }
  return end - start >= 2 ? end - start : 0;
}

function joinParagraph(previous: string, next: string) {
  // Join line-wrapped English words, retaining intentional en/em dashes.
  if (/[a-z]{2}-$/iu.test(previous) && /^[a-z]/u.test(next)) return previous.slice(0, -1) + next;
  const separator = cjk.test(previous.slice(-1)) && cjk.test(next[0] ?? '') ? '' : ' ';
  return previous + separator + next;
}

function renderRegion(lines: Line[], options: PdfLayoutOptions, bodySize: number) {
  const blocks: string[] = [];
  const regionLeft = Math.min(...lines.map((line) => line.x));
  let paragraph = '';
  const flush = () => { if (paragraph) blocks.push(paragraph); paragraph = ''; };
  for (let index = 0; index < lines.length;) {
    const line = lines[index]!;
    if (isMonospace(line)) {
      flush();
      const code: Line[] = [line];
      while (index + code.length < lines.length && isMonospace(lines[index + code.length]!)) code.push(lines[index + code.length]!);
      const left = Math.min(...code.map((entry) => entry.x));
      const text = code.map((entry) => ' '.repeat(Math.min(80, Math.max(0, Math.round((entry.x - left) / (entry.size * 0.6))))) + rawText(entry.runs)).join('\n');
      const fence = '`'.repeat(Math.max(3, ...Array.from(text.matchAll(/`+/gu), ([run]) => run.length + 1)));
      blocks.push(options.format === 'markdown' ? `${fence}\n${text}\n${fence}` : text);
      index += code.length;
      continue;
    }
    const table = tableLength(lines, index);
    if (table) {
      flush();
      const rows = lines.slice(index, index + table).map((entry) => cells(entry).map((cell) => renderRuns(cell, options)));
      if (options.format === 'markdown') {
        const markdownRows = rows.map((row) => `| ${row.map((value) => value.replace(/\|/gu, '\\|')).join(' | ')} |`);
        markdownRows.splice(1, 0, `| ${rows[0]!.map(() => '---').join(' | ')} |`);
        blocks.push(markdownRows.join('\n'));
      } else blocks.push(rows.map((row) => row.join('\t')).join('\n'));
      index += table;
      continue;
    }
    const raw = rawText(line.runs);
    const rendered = renderRuns(line.runs, options);
    const level = headingLevel(line, bodySize);
    if (level) {
      flush();
      blocks.push(options.format === 'markdown' ? `${'#'.repeat(level)} ${rendered}` : rendered);
    } else if (isList(raw)) {
      flush();
      const indent = ' '.repeat(Math.min(8, Math.max(0, Math.round((line.x - regionLeft) / (bodySize * 1.8)))) * 2);
      const normalized = options.format === 'markdown'
        ? rendered.replace(/^[•●▪◦‣⁃–—*]\s+/u, '- ').replace(/^([a-zA-Z])[.)]\s+/u, '- ') : rendered;
      const previous = blocks.at(-1);
      if (previous && /^(?:\s*)(?:[-*]|\d+[.)])\s/u.test(previous)) blocks[blocks.length - 1] = `${previous}\n${indent}${normalized}`;
      else blocks.push(`${indent}${normalized}`);
    } else {
      const previous = lines[index - 1];
      const newParagraph = previous && (line.y - previous.y > Math.max(bodySize, line.size) * 1.65
        || line.x - previous.x > bodySize * 1.4);
      if (newParagraph) flush();
      paragraph = paragraph ? joinParagraph(paragraph, rendered) : rendered;
    }
    index++;
  }
  flush();
  return blocks.join('\n\n');
}

/** Best-effort reconstruction, deliberately avoiding claims of exact document round-tripping. */
export function layoutPdfPage(input: PdfTextRun[], options: PdfLayoutOptions): PdfLayoutResult {
  const runs = input.filter((run) => run.text.trim() && [run.x, run.y, run.width, run.size].every(Number.isFinite) && run.size > 0);
  if (!runs.length) return { text: '', warnings: [] };
  const lines = buildLines(runs);
  // Repeated body lines carry more evidence than short large title fragments.
  const sizes = new Map<number, number>();
  let weight = 0;
  for (const run of runs) {
    const count = Math.max(1, Math.min(100, run.text.length));
    sizes.set(run.size, (sizes.get(run.size) ?? 0) + count);
    weight += count;
  }
  let bodySize = 12;
  let cumulative = 0;
  for (const [size, count] of [...sizes].sort(([a], [b]) => a - b)) {
    cumulative += count;
    if (cumulative >= weight / 2) { bodySize = size; break; }
  }
  const gutter = columnGutter(lines, options.width);
  const text = columnRegions(lines, gutter).map((region) => renderRegion(region, options, bodySize)).filter(Boolean).join('\n\n');
  return { text, warnings: gutter === null ? [] : ['检测到双栏排版，已按先左栏后右栏读取，请核对阅读顺序。'] };
}
