import { createHash } from 'node:crypto';

export const REQUIRED_DOCUMENT_FONT = Object.freeze({
  path: 'fonts/NearDocumentSans.ttf',
  bytes: 10642808,
  sha256: '40d7aa23a3cb25765a3b019136fdfe70a9f08f428d8e1042f0d472fde376132a',
});

const ARCHIVE_EXTENSION = /\.(?:zip|zipx|gz|gzip|tgz|svgz|7z|rar|xz|txz|bz|bz2|bzip2|tbz|tbz2|tar|taz|z|lz|lzma|lzo|tlz|lz4|zst|zstd|tzst|br|cab|jar|war|ear|crx|vsix|nupkg|whl|apk|aab|xpi|epub|docx|xlsx|pptx|odt|ods|odp)$/i;
const SIGNATURES = [
  ['gzip', [0x1f, 0x8b, 0x08]],
  ['ZIP', [0x50, 0x4b, 0x03, 0x04]],
  ['ZIP', [0x50, 0x4b, 0x05, 0x06]],
  ['ZIP', [0x50, 0x4b, 0x07, 0x08]],
  ['7z', [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]],
  ['RAR', [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]],
  ['RAR', [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]],
  ['xz', [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]],
  ['Zstandard', [0x28, 0xb5, 0x2f, 0xfd]],
  ['LZ4', [0x04, 0x22, 0x4d, 0x18]],
  ['lzip', [0x4c, 0x5a, 0x49, 0x50]],
  ['Unix compress', [0x1f, 0x9d]],
  ['Unix pack', [0x1f, 0x1e]],
  ['CAB', [0x4d, 0x53, 0x43, 0x46]],
];

/** @param {Uint8Array} bytes @param {number[]} signature @param {number} [offset] */
function startsWith(bytes, signature, offset = 0) {
  return bytes.length >= offset + signature.length && signature.every((value, index) => bytes[offset + index] === value);
}

/**
 * Inspect unpacked entries, never the outer distribution ZIP. Signatures prevent
 * known archive formats from bypassing the gate merely by changing a suffix.
 * Formats without a reliable signature (for example Brotli) are rejected by
 * extension. Ordinary compressed image/font formats are deliberately allowed.
 * @param {Iterable<readonly [string, Uint8Array]>} entries
 */
export function findNestedArchives(entries) {
  const found = [];
  for (const [name, bytes] of entries) {
    if (typeof name !== 'string' || !(bytes instanceof Uint8Array)) throw new TypeError('Expected unpacked package entries with names and byte arrays.');
    if (name.endsWith('/') || name.endsWith('\\')) continue;
    const reasons = [];
    const extension = name.match(ARCHIVE_EXTENSION)?.[0];
    if (extension) reasons.push(`archive extension ${extension}`);
    const signature = SIGNATURES.find(([, prefix]) => startsWith(bytes, prefix));
    if (signature) reasons.push(`${signature[0]} signature`);
    if (startsWith(bytes, [0x42, 0x5a, 0x68]) && bytes[3] >= 0x31 && bytes[3] <= 0x39) reasons.push('bzip2 signature');
    if (startsWith(bytes, [0x75, 0x73, 0x74, 0x61, 0x72], 257)) reasons.push('tar signature');
    if (reasons.length) found.push({ name, reasons });
  }
  return found;
}

/** @param {Iterable<readonly [string, Uint8Array]>} entries */
export function assertNoNestedArchives(entries) {
  const found = findNestedArchives(entries);
  if (found.length) throw new Error(`Nested compressed/archive resources are not allowed in release packages:\n${found
    .map(({ name, reasons }) => `- ${JSON.stringify(name)} (${reasons.join('; ')})`).join('\n')}`);
}

/** @param {Iterable<readonly [string, Uint8Array]>} entries */
export function assertRequiredDocumentFont(entries) {
  const entry = Array.from(entries).find(([name]) => name === REQUIRED_DOCUMENT_FONT.path);
  if (!entry) throw new Error(`Missing required raw document font: ${REQUIRED_DOCUMENT_FONT.path}`);
  const bytes = entry[1];
  if (bytes.byteLength !== REQUIRED_DOCUMENT_FONT.bytes) throw new Error(`Invalid document font size: ${REQUIRED_DOCUMENT_FONT.path}; expected ${REQUIRED_DOCUMENT_FONT.bytes} bytes, received ${bytes.byteLength}.`);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== REQUIRED_DOCUMENT_FONT.sha256) throw new Error(`Invalid document font SHA-256: ${REQUIRED_DOCUMENT_FONT.path}; expected ${REQUIRED_DOCUMENT_FONT.sha256}, received ${sha256}.`);
}

/** @param {Iterable<readonly [string, Uint8Array]>} entries */
export function assertStorePackageResources(entries) {
  const files = Array.from(entries);
  assertNoNestedArchives(files);
  assertRequiredDocumentFont(files);
}
