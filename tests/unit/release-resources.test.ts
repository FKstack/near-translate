import { readFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { assertNoNestedArchives, assertRequiredDocumentFont, assertStorePackageResources, findNestedArchives,
  REQUIRED_DOCUMENT_FONT } from '../../scripts/lib/release-resources.mjs';

const gzipFont = readFileSync(new URL('../../third_party/fonts/NearDocumentSans.ttf.gz', import.meta.url));
const rawFont = gunzipSync(gzipFont);
const plain = Buffer.from('ordinary packaged text');
const files = () => new Map<string, Uint8Array>([
  ['manifest.json', Buffer.from('{"manifest_version":3,"name":"Fixture","version":"1.0.0"}')],
  [REQUIRED_DOCUMENT_FONT.path, rawFont],
]);

describe('store release resource gate', () => {
  it('rejects the actual legacy compressed document font and names it explicitly', () => {
    const entries = new Map([['fonts/NearDocumentSans.ttf.gz', gzipFont]]);
    expect(findNestedArchives(entries)).toEqual([{ name: 'fonts/NearDocumentSans.ttf.gz',
      reasons: ['archive extension .gz', 'gzip signature'] }]);
    expect(() => assertStorePackageResources(entries)).toThrow('fonts/NearDocumentSans.ttf.gz');
  });

  it('accepts the exact original font bytes when expanded and persisted as raw TTF', () => {
    expect(rawFont.byteLength).toBe(10642808);
    expect(() => assertStorePackageResources(files())).not.toThrow();
    expect(REQUIRED_DOCUMENT_FONT).toEqual({ path: 'fonts/NearDocumentSans.ttf', bytes: 10642808,
      sha256: '40d7aa23a3cb25765a3b019136fdfe70a9f08f428d8e1042f0d472fde376132a' });
  });

  it('does not allow changing a gzip suffix to a permitted asset name', () => {
    for (const name of ['fonts/fake.ttf', 'pdfjs/data.bcmap', 'assets/data.bin', 'assets/data']) {
      expect(() => assertNoNestedArchives([[name, gzipFont]])).toThrow(`${name}`);
    }
  });

  it.each([
    ['ZIP', '504b030400000000'], ['empty ZIP', '504b05060000000000000000000000000000000000000000'],
    ['spanned ZIP', '504b070800000000'], ['7z', '377abcaf271c0000'],
    ['RAR4', '526172211a070000'], ['RAR5', '526172211a070100'], ['xz', 'fd377a585a000000'],
    ['bzip2', '425a68390000'], ['Zstandard', '28b52ffd0000'], ['LZ4', '04224d180000'],
    ['lzip', '4c5a49500000'], ['Unix compress', '1f9d00'], ['CAB', '4d5343460000'],
  ])('rejects disguised %s resources by signature', (_format, hex) => {
    const found = findNestedArchives([['assets/disguised.dat', Buffer.from(hex, 'hex')]]);
    expect(found).toHaveLength(1); expect(found[0]?.name).toBe('assets/disguised.dat');
    expect(found[0]?.reasons.some((reason: string) => reason.includes('signature'))).toBe(true);
  });

  it('recognizes an ordinary tar header at its format-defined position', () => {
    const tar = Buffer.alloc(512); tar.write('ustar', 257, 'ascii');
    expect(() => assertNoNestedArchives([['assets/renamed.data', tar]])).toThrow('tar signature');
  });

  it.each(['ZIP', 'zipx', 'gz', 'gzip', 'tgz', 'svgz', '7z', 'rar', 'xz', 'txz', 'bz2', 'tar', 'zst', 'br', 'cab', 'jar', 'xpi', 'docx'])(
    'rejects archive extension .%s even when its content is incomplete or has no signature', extension => {
      expect(() => assertNoNestedArchives([[`nested/resource.${extension}`, plain]])).toThrow('archive extension');
    },
  );

  it('reports every blocked filename rather than only the first', () => {
    const entries = [['data/one.bin', gzipSync(plain)], ['data/two.zip', plain]] as const;
    expect(() => assertNoNestedArchives(entries)).toThrow(/data\/one\.bin[\s\S]*data\/two\.zip/);
  });

  it('allows TTF, packaged WASM, PNG, WOFF2 and compressed PDF CMaps', () => {
    const entries = files();
    entries.set('pdfjs/wasm/decoder.wasm', Buffer.from('0061736d01000000', 'hex'));
    entries.set('icon/128.png', Buffer.from('89504e470d0a1a0a', 'hex'));
    entries.set('pdfjs/standard_fonts/font.woff2', Buffer.from('774f463200000000', 'hex'));
    entries.set('pdfjs/cmaps/Adobe-GB1-UCS2.bcmap', Buffer.from([0x00, 0x20, 0x10, 0x80]));
    expect(findNestedArchives(entries)).toEqual([]);
    expect(() => assertStorePackageResources(entries)).not.toThrow();
  });

  it('does not treat compression inside a normal image as a nested archive', () => {
    const image = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), gzipSync(plain)]);
    expect(findNestedArchives([['icon/example.png', image]])).toEqual([]);
  });

  it('scans extracted entries, not the outer distribution ZIP', () => {
    // The same ZIP signature is forbidden as an entry; the outer transport is
    // handled by the caller's ZIP parser and is never itself an entry here.
    const zip = Buffer.from('504b05060000000000000000000000000000000000000000', 'hex');
    expect(() => assertNoNestedArchives([['assets/nested.zip', zip]])).toThrow('nested.zip');
    expect(() => assertStorePackageResources(files())).not.toThrow();
  });

  it('ignores directory entries even when a directory has an archive suffix', () => {
    expect(findNestedArchives([['folder.zip/', new Uint8Array()]])).toEqual([]);
  });

  it('requires the raw font at its stable runtime path', () => {
    expect(() => assertRequiredDocumentFont([['fonts/other.ttf', rawFont]])).toThrow('Missing required raw document font');
  });

  it('rejects truncated and substituted fonts with a precise size or hash failure', () => {
    expect(() => assertRequiredDocumentFont([[REQUIRED_DOCUMENT_FONT.path, rawFont.subarray(0, rawFont.length - 1)]])).toThrow('Invalid document font size');
    const changed = Buffer.from(rawFont); changed[100] = changed[100]! ^ 1;
    expect(() => assertRequiredDocumentFont([[REQUIRED_DOCUMENT_FONT.path, changed]])).toThrow('Invalid document font SHA-256');
  });

  it('supports a one-shot iterator without silently skipping the font check', () => {
    const entries = files();
    expect(() => assertStorePackageResources(entries.entries())).not.toThrow();
    entries.delete(REQUIRED_DOCUMENT_FONT.path);
    expect(() => assertStorePackageResources(entries.entries())).toThrow('Missing required raw document font');
  });
});
