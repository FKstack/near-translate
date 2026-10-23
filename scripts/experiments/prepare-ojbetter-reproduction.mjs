// Prepare pinned public reference artifacts under ignored .output for research only.
// No browser/profile access, userscript execution, account access or DeepL requests.
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, unlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inflateRawSync } from 'node:zlib';
import { dirname, isAbsolute, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const workspace = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
const execute = promisify(execFile);
const commit = '860106c63ef7bb7d4ec5dcd709f80a9f9a6f1a46';
// Captured from the official download used in this reproduction. A publisher update
// must be reviewed explicitly; never silently replace this baseline with a new build.
const tampermonkeyHash = 'a124e3189ecc0981ce79ef182dd3897a75fe22fc7bf0828e9d293ad7122d3d4d';
const scriptHash = 'ac54e910d52ff40df1e9f25173a79cb2046eb4b9a1849bc1dcf5b6e07d79aa26';
const artifacts = [
  { name: 'tampermonkey.crx', url: 'https://www.tampermonkey.net/crx/tampermonkey_stable.crx', sha256: tampermonkeyHash },
  // Keep the original remote file distinct from any pre-existing working copy.
  { name: 'atcoder-better.remote.js', url: `https://raw.githubusercontent.com/beijixiaohu/OJBetter/${commit}/script/release/atcoder-better.user.js`, sha256: scriptHash },
  { name: 'OJBetter-LICENSE', url: `https://raw.githubusercontent.com/beijixiaohu/OJBetter/${commit}/LICENSE` },
];

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function requireChild(parent, target) {
  const child = relative(parent, target);
  assert(child && !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`), 'Research paths must stay inside their intended directory.');
}
async function ensureDirectory(path, parent) {
  await mkdir(path, { recursive: true });
  const canonical = await realpath(path);
  requireChild(parent, canonical);
  return canonical;
}
const output = await ensureDirectory(resolve(workspace, '.output'), workspace);
const directory = await ensureDirectory(resolve(output, 'ojbetter-reproduction'), output);

async function existingFile(path) {
  try {
    const stat = await lstat(path);
    assert(stat.isFile() && !stat.isSymbolicLink(), 'Cached artifacts must be regular files, not links.');
    requireChild(directory, await realpath(path));
    return await readFile(path);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}
const previousBytes = await existingFile(resolve(directory, 'source-manifest.json'));
const previous = previousBytes ? JSON.parse(previousBytes.toString('utf8')) : {};

function validateArtifact(artifact, bytes) {
  assert(bytes.length > 0, `Empty reference artifact: ${artifact.name}`);
  const previousHash = previous.artifacts?.find(item => item.name === artifact.name)?.sha256;
  const expected = artifact.sha256 ?? previousHash;
  if (expected) assert.equal(sha256(bytes), expected, `Cached/downloaded ${artifact.name} differs from the reviewed baseline; existing files were not replaced.`);
  if (artifact.name.endsWith('.crx')) readCrx(bytes);
  else {
    const text = bytes.toString('utf8');
    assert(!/^\s*(?:<!doctype\s+html|<html\b)/i.test(text), `Expected reference text, received HTML: ${artifact.name}`);
    if (artifact.name.endsWith('.js')) assert(text.includes('==UserScript==') && text.includes('==/UserScript=='), 'Missing original userscript metadata.');
    else assert(text.length >= 20, 'The reference license is unexpectedly short.');
  }
}

async function acquire(artifact) {
  const destination = resolve(directory, artifact.name);
  const cached = await existingFile(destination);
  if (cached) {
    validateArtifact(artifact, cached);
    return { bytes: cached, evidence: { ...artifact, acquisition: 'reused-verified-local', resolvedUrl: null, bytes: cached.length, sha256: sha256(cached) } };
  }
  const temporary = resolve(directory, `.${artifact.name}.${randomUUID()}.partial`);
  try {
    const { stdout } = await execute(process.platform === 'win32' ? 'curl.exe' : 'curl', [
      '--disable', '--fail', '--location', '--silent', '--show-error',
      '--proto', '=https', '--proto-redir', '=https', '--max-redirs', '10',
      '--connect-timeout', '20', '--max-time', '120', '--retry', '2', '--retry-delay', '2',
      '--output', temporary, '--write-out', '%{url_effective}', artifact.url,
    ], { timeout: 400_000, windowsHide: true, maxBuffer: 1024 * 1024 });
    const bytes = await existingFile(temporary);
    assert(bytes, `curl did not create ${artifact.name}.`);
    validateArtifact(artifact, bytes);
    // Exclusive creation also protects an artifact prepared by another process.
    await copyFile(temporary, destination, constants.COPYFILE_EXCL);
    return { bytes, evidence: { ...artifact, acquisition: 'curl-https', resolvedUrl: stdout.trim(), bytes: bytes.length, sha256: sha256(bytes) } };
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

function readCrx(bytes) {
  assert(bytes.length >= 16 && bytes.subarray(0, 4).toString('ascii') === 'Cr24', 'Expected an official CRX container.');
  assert.equal(bytes.readUInt32LE(4), 3, 'Expected the reviewed CRX3 container.');
  const zipOffset = 12 + bytes.readUInt32LE(8);
  assert(zipOffset <= bytes.length - 4 && bytes.readUInt32LE(zipOffset) === 0x04034b50, 'Invalid CRX3 ZIP offset.');
  return { zipOffset, zip: bytes.subarray(zipOffset) };
}

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

// Small ZIP reader for this pinned research package: validates central-directory
// bounds, stored/deflated entries and CRC32; rejects encryption, links and ZIP64.
function unpackEntries(zip) {
  let end = -1;
  for (let offset = zip.length - 22; offset >= Math.max(0, zip.length - 65557); offset--) {
    if (zip.readUInt32LE(offset) === 0x06054b50 && offset + 22 + zip.readUInt16LE(offset + 20) === zip.length) { end = offset; break; }
  }
  assert(end >= 0, 'ZIP end-of-central-directory not found.');
  assert.equal(zip.readUInt16LE(end + 4), 0, 'Multi-disk ZIP is unsupported.');
  assert.equal(zip.readUInt16LE(end + 6), 0, 'Multi-disk ZIP is unsupported.');
  const count = zip.readUInt16LE(end + 10);
  assert(count > 0 && count < 10000 && zip.readUInt16LE(end + 8) === count, 'Unexpected ZIP entry count.');
  const centralSize = zip.readUInt32LE(end + 12);
  const centralOffset = zip.readUInt32LE(end + 16);
  assert(centralOffset + centralSize === end, 'ZIP64 or unexpected central-directory layout.');
  const entries = [];
  const seen = new Set();
  let offset = centralOffset;
  let expandedSize = 0;
  for (let index = 0; index < count; index++) {
    assert(offset + 46 <= end && zip.readUInt32LE(offset) === 0x02014b50, 'Invalid ZIP central-directory entry.');
    const flags = zip.readUInt16LE(offset + 8);
    const method = zip.readUInt16LE(offset + 10);
    const expectedCrc = zip.readUInt32LE(offset + 16);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const size = zip.readUInt32LE(offset + 24);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const attributes = zip.readUInt32LE(offset + 38);
    const localOffset = zip.readUInt32LE(offset + 42);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    assert(next <= end && !(flags & 1) && [0, 8].includes(method), 'Unsupported or encrypted ZIP entry.');
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    assert(name && !/[\\:\u0000\ufffd]/.test(name) && !name.startsWith('/'), 'Unsafe ZIP entry name.');
    const parts = name.replace(/\/$/, '').split('/');
    assert(parts.every(part => part && part !== '.' && part !== '..'), 'ZIP entry escapes extraction directory.');
    const normalized = parts.join('/').toLowerCase();
    assert(!seen.has(normalized), 'Duplicate or case-colliding ZIP entry.');
    seen.add(normalized);
    assert.notEqual((attributes >>> 16) & 0xf000, 0xa000, 'ZIP links are not permitted.');
    assert(localOffset + 30 <= centralOffset && zip.readUInt32LE(localOffset) === 0x04034b50, 'Invalid ZIP local header.');
    const start = localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
    assert(start + compressedSize <= centralOffset, 'ZIP entry data is outside its bounds.');
    expandedSize += size;
    assert(expandedSize <= 64 * 1024 * 1024, 'Research ZIP expanded size is unexpectedly large.');
    const compressed = zip.subarray(start, start + compressedSize);
    const data = method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: Math.max(1, size) });
    assert.equal(data.length, size, 'ZIP entry length mismatch.');
    assert.equal(crc32(data), expectedCrc, 'ZIP entry CRC32 mismatch.');
    entries.push({ name, directory: name.endsWith('/'), data, sha256: sha256(data) });
    offset = next;
  }
  assert.equal(offset, end, 'Unexpected trailing ZIP directory records.');
  return entries;
}

async function matchesArchive(path, entries) {
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    const canonical = await realpath(path);
    requireChild(directory, canonical);
    for (const entry of entries) {
      if (entry.directory) continue;
      const target = resolve(canonical, entry.name);
      requireChild(canonical, await realpath(target));
      const file = await lstat(target);
      if (!file.isFile() || file.isSymbolicLink() || sha256(await readFile(target)) !== entry.sha256) return false;
    }
    return true;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code) || error.code === 'ERR_ASSERTION') return false;
    throw error;
  }
}
async function extractedDirectory(entries, version) {
  const prefix = `tampermonkey-${version}-${tampermonkeyHash.slice(0, 12)}`;
  const candidates = (await readdir(directory, { withFileTypes: true }))
    .filter(item => item.isDirectory() && (item.name === 'tampermonkey' || item.name.startsWith(prefix)))
    .map(item => resolve(directory, item.name));
  for (const candidate of candidates) {
    if (await matchesArchive(candidate, entries)) return { path: candidate, acquisition: 'reused-archive-matching-directory' };
  }
  // Never repair or overwrite an existing official directory, including a directory
  // that another experiment has modified. All extraction writes use a new target.
  const target = await mkdtemp(resolve(directory, `${prefix}-`));
  for (const entry of entries) {
    const path = resolve(target, entry.name);
    requireChild(target, path);
    if (entry.directory) await mkdir(path, { recursive: true });
    else {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, entry.data, { flag: 'wx' });
    }
  }
  assert(await matchesArchive(target, entries), 'Extracted files do not match the reviewed archive.');
  return { path: target, acquisition: 'extracted-into-new-directory' };
}

const evidence = [];
let tampermonkey;
let userscript;
for (const artifact of artifacts) {
  const acquired = await acquire(artifact);
  evidence.push(acquired.evidence);
  if (artifact.name.endsWith('.crx')) {
    const { zipOffset, zip } = readCrx(acquired.bytes);
    const zipPath = resolve(directory, 'tampermonkey.zip');
    const previousZip = await existingFile(zipPath);
    if (previousZip) assert.equal(sha256(previousZip), sha256(zip), 'Existing ZIP differs; it was not overwritten.');
    else await writeFile(zipPath, zip, { flag: 'wx' });
    const entries = unpackEntries(zip);
    const manifestEntry = entries.find(entry => entry.name === 'manifest.json');
    assert(manifestEntry, 'Tampermonkey manifest is missing.');
    const manifest = JSON.parse(manifestEntry.data.toString('utf8'));
    assert.equal(manifest.version, '5.4.1', 'Expected the reviewed Tampermonkey package version.');
    assert.equal(manifest.manifest_version, 3, 'Expected the reviewed MV3 package.');
    const extraction = await extractedDirectory(entries, manifest.version);
    tampermonkey = {
      packageVersion: manifest.version, manifestVersion: manifest.manifest_version,
      runtimeVersionMeasured: false, minimumChromeVersion: manifest.minimum_chrome_version,
      background: manifest.background, permissions: manifest.permissions ?? [],
      hostPermissions: manifest.host_permissions ?? [], optionalHostPermissions: manifest.optional_host_permissions ?? [],
      manifestSha256: manifestEntry.sha256, crxSha256: sha256(acquired.bytes),
      zipSha256: sha256(zip), zipOffset, archiveFilesVerified: entries.filter(entry => !entry.directory).length,
      archiveIntegrity: 'central-directory, decompressed lengths and CRC32 checked',
      crxSignatureCryptographicallyVerified: false,
      extractionDirectory: relative(workspace, extraction.path).split(sep).join('/'),
      extraction: extraction.acquisition,
    };
  } else if (artifact.name.endsWith('.js')) {
    const source = acquired.bytes.toString('utf8');
    userscript = {
      file: artifact.name, sha256: sha256(acquired.bytes),
      metadataVersion: /^\/\/\s*@version\s+(.+)$/m.exec(source)?.[1]?.trim() ?? null,
      executed: false,
    };
  }
}
await writeFile(resolve(directory, 'source-manifest.json'), JSON.stringify({
  generatedAt: new Date().toISOString(), commit, artifacts: evidence,
  tampermonkey, userscript, sourceModified: false,
  researchOnly: true, realUserProfileAccessed: false, deeplRequestsMade: false,
  note: 'Pinned package hashes and repository commit; existing official source directories are read-only. Package version is not a measurement of a running Tampermonkey instance. Copyrighted reference artifacts remain under ignored .output; scripts were not executed.',
}, null, 2) + '\n');
console.log(JSON.stringify({ artifacts: evidence, tampermonkey, userscript }, null, 2));
