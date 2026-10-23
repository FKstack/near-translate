import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

// Inspect Git candidates without staging, reading ignored profiles, or publishing.
const execute = promisify(execFile);
const root = await realpath(path.resolve(import.meta.dirname, '..'));
const { stdout } = await execute('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true });
const candidates = [...new Set(stdout.split('\0').filter(Boolean))];
const issues = [];
const files = [];
let scannedTextFiles = 0;
// This public probe value is deliberately rejected by the service, not a credential.
const invalidPlaceholders = new Set(['sk-native-fetch-probe-deliberately-invalid-not-a-user-key']);
const generated = /^(?:node_modules|\.output|\.wxt|artifacts|coverage|playwright-report|test-results|public\/(?:pdfjs|licenses|fonts))(?:\/|$)/;
const secrets = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['api-key-shape', /\bsk-[A-Za-z0-9_-]{24,}\b/],
];
for (const file of candidates) {
  const full = path.resolve(root, file);
  const relative = path.relative(root, full);
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Unexpected Git candidate path.');
  if (generated.test(file)) issues.push({ file, reason: 'generated-or-local-artifact' });
  if (/(?:^|\/)\.env(?:\..*)?$/.test(file) && !file.endsWith('.env.example')) issues.push({ file, reason: 'local-environment' });
  let details;
  try { details = await lstat(full); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  if (details.isSymbolicLink()) { issues.push({ file, reason: 'symlink-candidate-review' }); continue; }
  if (!details.isFile()) continue;
  files.push({ file, bytes: details.size });
  if (details.size > 20 * 1024 * 1024) issues.push({ file, reason: 'large-source-file-over-20-MiB' });
  if (!/\.(?:[cm]?[jt]sx?|json|md|ya?ml|toml|pem|key|example)$/.test(file)) continue;
  if (details.size > 2 * 1024 * 1024) { issues.push({ file, reason: 'text-too-large-for-token-scan' }); continue; }
  const text = await readFile(full, 'utf8');
  scannedTextFiles++;
  for (const [reason, pattern] of secrets) {
    const matches = text.matchAll(new RegExp(pattern.source, 'g'));
    if ([...matches].some(match => !invalidPlaceholders.has(match[0]))) issues.push({ file, reason });
  }
}
const summary = { schemaVersion: 1,
  scope: 'Existing tracked files plus untracked, non-ignored Git candidates. No staging or remote operations.',
  tokenScan: 'Bounded pattern check for common credential shapes; values and source lines are never included in output.',
  files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0), scannedTextFiles,
  largestFiles: files.sort((a, b) => b.bytes - a.bytes).slice(0, 12), issues };
const outputAt = process.argv.indexOf('--output');
if (outputAt >= 0) {
  const output = path.resolve(root, process.argv[outputAt + 1] ?? '');
  const relative = path.relative(root, output);
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Report must stay inside workspace.');
  await writeFile(output, JSON.stringify(summary, null, 2) + '\n');
}
console.log(JSON.stringify(summary, null, 2));
if (issues.length) process.exitCode = 1;
