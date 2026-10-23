/** Browser-only conversion fixtures. These ordinary PDF byte streams use no PDF library. */
function pdfBytes(objects: Array<string | Buffer>, version = '1.7'): Buffer {
  const chunks = [Buffer.from(`%PDF-${version}\n%NearConversionFixture\n`, 'ascii')];
  const offsets: number[] = [];
  let length = chunks[0]!.length;
  for (let index = 0; index < objects.length; index++) {
    offsets.push(length);
    const source = objects[index]!;
    const bytes = typeof source === 'string' ? Buffer.from(source, 'ascii') : source;
    const object = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`, 'ascii'), bytes, Buffer.from('\nendobj\n', 'ascii')]);
    chunks.push(object); length += object.length;
  }
  const xref = length;
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`, 'ascii'));
  return Buffer.concat(chunks);
}

function stream(source: string | Buffer): Buffer {
  const bytes = typeof source === 'string' ? Buffer.from(source, 'ascii') : source;
  return Buffer.concat([Buffer.from(`<< /Length ${bytes.length} >>\nstream\n`, 'ascii'), bytes, Buffer.from('\nendstream', 'ascii')]);
}

function literal(value: string) { return value.replace(/[\\()]/g, character => `\\${character}`); }
function text(value: string, x: number, y: number, font = 'F1', size = 11) {
  return `BT /${font} ${size} Tf 1 0 0 1 ${x} ${y} Tm (${literal(value)}) Tj ET`;
}

/**
 * First page has real standard-font headings, table cells, monospace code,
 * lists, independently positioned columns and a URI annotation. Second page
 * intentionally has no text layer and exercises mixed scanned/blank handling.
 */
export function mixedLayoutPdfFixture(options: { blankSecondPage?: boolean } = {}): Buffer {
  const second = options.blankSecondPage ?? true;
  const content = [
    text('Document conversion fixture', 40, 750, 'F2', 24),
    text('A structured document with local processing and readable output.', 40, 712),
    text('Format', 40, 680), text('Purpose', 330, 680),
    text('Markdown', 40, 663), text('Editable notes', 330, 663),
    text('PDF', 40, 646), text('Portable sharing', 330, 646),
    text('function convert() {', 40, 610, 'F3', 10),
    text('return 42;', 52, 596, 'F3', 10), text('}', 40, 582, 'F3', 10),
    text('- First local task', 40, 548), text('- Second local task', 40, 532),
    text('Left column begins with enough words to read.', 40, 488, 'F1', 9),
    text('Right column begins with another paragraph.', 330, 488, 'F1', 9),
    text('Left column carries on with a second line.', 40, 473, 'F1', 9),
    text('Right column carries on in its second line.', 330, 473, 'F1', 9),
    text('Left column ends after this final line.', 40, 458, 'F1', 9),
    text('Right column ends after this final line.', 330, 458, 'F1', 9),
    text('Read the online guide', 40, 415),
  ].join('\n');
  return pdfBytes([
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [3 0 R${second ? ' 4 0 R' : ''}] /Count ${second ? 2 : 1} >>`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R /F2 6 0 R /F3 7 0 R >> >> /Contents 8 0 R /Annots [9 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 10 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>', stream(content),
    '<< /Type /Annot /Subtype /Link /Rect [39 412 145 427] /Border [0 0 0] /A << /S /URI /URI (https://example.com/conversion-guide) >> >>',
    stream('0.9 0.94 0.91 rg 50 500 400 120 re f'),
  ]);
}

export const CHINESE_FIXTURE_TEXT = '中文阅读，自然清晰。';

function utf16Hex(value: string) {
  return [...value].map(character => character.charCodeAt(0).toString(16).padStart(4, '0')).join('').toUpperCase();
}

/**
 * Unembedded STSong-Light Type0 font with a named UniGB-UCS2-H CMap and explicit
 * ToUnicode. The browser must load the packaged local CMap; no external font or
 * PDF network resource is referenced. Chinese glyph rendering uses system font
 * fallback, while Unicode extraction is deterministic through ToUnicode.
 */
export function chineseCMapPdfFixture(): Buffer {
  const characters = [...new Set([...CHINESE_FIXTURE_TEXT])];
  const unicode = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /NearChineseUnicode def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${characters.length} beginbfchar\n${characters.map(character => `<${utf16Hex(character)}> <${utf16Hex(character)}>`).join('\n')}\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;
  return pdfBytes([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 8 0 R >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [5 0 R] /ToUnicode 6 0 R >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /FontDescriptor 7 0 R /DW 1000 >>',
    stream(unicode),
    '<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [-25 -254 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 80 >>',
    stream(`BT /F1 20 Tf 1 0 0 1 50 730 Tm <${utf16Hex(CHINESE_FIXTURE_TEXT)}> Tj ET`),
  ]);
}

export interface GeometryPdfFixtureOptions {
  rotation?: 0 | 90 | 180 | 270;
  userUnit?: number;
  cropBox?: [number, number, number, number];
}

/**
 * Default CropBox is 240x160 points with UserUnit 2 and rotation 90, hence
 * rendering at scale 1 must produce 320x480 pixels. Red/green rectangles make
 * image output non-blank and orientation/crop mistakes visually obvious.
 * Adjacent text fragments must extract as "Conversion" with UserUnit applied.
 */
export function geometryPdfFixture(options: GeometryPdfFixtureOptions = {}): Buffer {
  const rotation = options.rotation ?? 90;
  const unit = options.userUnit ?? 2;
  const box = options.cropBox ?? [30, 20, 270, 180];
  if (![0, 90, 180, 270].includes(rotation) || !Number.isFinite(unit) || unit <= 0
    || box.length !== 4 || !box.every(Number.isFinite) || box[2] <= box[0] || box[3] <= box[1]) throw new Error('Invalid geometry fixture options.');
  const content = [
    '0.2 0.7 0.5 rg 30 20 110 160 re f', '0.9 0.3 0.2 rg 140 20 130 80 re f',
    '0 0 0 rg',
    // Courier's 12pt glyph advance is exactly 7.2pt. 3 letters advance 21.6pt.
    text('Con', 50, 135, 'F1', 12), text('version', 71.6, 135, 'F1', 12),
  ].join('\n');
  return pdfBytes([
    '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /CropBox [${box.join(' ')}] /UserUnit ${unit} /Rotate ${rotation} /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>', stream(content),
  ]);
}
