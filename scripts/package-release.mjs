import { cp, mkdir, readFile, realpath, copyFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import assert from 'node:assert/strict';

const root = await realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const output = await realpath(path.join(root, '.output'));
assert.equal(output, path.join(root, '.output'), 'Build output must be inside workspace.');
const destination = path.join(root, 'artifacts');
await mkdir(destination, { recursive: true });
assert.equal(await realpath(destination), destination, 'Release destination must be inside workspace.');
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
assert.match(version, /^\d+\.\d+\.\d+$/);
const unitReport = JSON.parse(await readFile(path.join(output, 'unit-results.json'), 'utf8'));
assert.equal(unitReport.success, true, 'Unit tests must pass before packaging.');
assert.equal(unitReport.numFailedTests, 0);
const unitTests = unitReport.numPassedTests;
const browserTests = {};
for (const browser of ['chrome', 'edge']) {
  const report = JSON.parse(await readFile(path.join(output, 'e2e-evidence', browser, 'summary.json'), 'utf8'));
  assert.equal(report.config.metadata.extensionVersion, version, 'Browser evidence must match this release.');
  assert.equal(report.stats.unexpected, 0, 'Browser tests must pass before packaging.');
  assert(report.stats.expected > 0);
  browserTests[browser] = report.stats.expected;
}

function zipEntries(zip) {
  let end = zip.length - 22;
  while (end >= Math.max(0, zip.length - 65557) && zip.readUInt32LE(end) !== 0x06054b50) end--;
  assert(end >= 0, 'ZIP directory missing.');
  const count = zip.readUInt16LE(end + 10);
  let offset = zip.readUInt32LE(end + 16);
  const entries = new Map();
  for (let index = 0; index < count; index++) {
    assert.equal(zip.readUInt32LE(offset), 0x02014b50);
    const method = zip.readUInt16LE(offset + 10);
    const size = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const local = zip.readUInt32LE(offset + 42);
    const name = zip.toString('utf8', offset + 46, offset + 46 + nameLength);
    assert.equal(zip.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const bytes = zip.subarray(start, start + size);
    entries.set(name, method === 8 ? inflateRawSync(bytes) : bytes);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

const artifacts = [];
for (const browser of ['chrome', 'edge']) {
  const source = path.join(output, `near-translate-${version}-${browser}.zip`);
  const bytes = await readFile(source);
  const entries = zipEntries(bytes);
  for (const required of ['manifest.json', 'background.js', 'options.html', 'popup.html', 'reader.html', 'content-scripts/selection.js', 'pdfjs/pdf.worker.mjs', 'pdfjs/version.json', 'licenses/near-translate.txt', 'licenses/react.txt', 'licenses/react-dom.txt', 'licenses/scheduler.txt', 'licenses/pdfjs-dist.txt']) assert(entries.has(required), `Missing ${required}`);
  const manifest = JSON.parse(entries.get('manifest.json').toString());
  assert.equal(manifest.version, version);
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.host_permissions ?? [], []);
  assert.deepEqual(manifest.optional_host_permissions, ['http://*/*', 'https://*/*']);
  assert(!manifest.permissions.includes('tabs'));
  assert(!manifest.content_scripts?.length, 'Website scripts must be runtime-registered.');
  for (const [name, content] of entries) {
    assert(!name.includes('chrome-runtime') && !name.includes('e2e-') && !name.includes('node_modules'));
    if (/\.(js|html)$/.test(name)) assert(!content.includes(Buffer.from('fake-test-key')), 'Test credential must not be shipped.');
  }
  const filename = `near-translate-${browser}-v${version}.zip`;
  await copyFile(source, path.join(destination, filename));
  artifacts.push({ browser, filename, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), entries: entries.size });
  const evidence = path.join(output, 'e2e-evidence', browser);
  const report = path.join(destination, 'reports', browser);
  await mkdir(path.dirname(report), { recursive: true });
  await cp(path.join(evidence, 'playwright-report'), report, { recursive: true });
  const screenshots = [
    ['extension-double-click-wor-251bb-with-context-copy-and-close', 'web-word-card.png'],
    ['extension-context-switch-r-34695-est-and-settings-show-Flash', 'options.png'],
    ['extension-local-PDF-text-l-6df69--searches-and-changes-pages', 'pdf-reader-card.png'],
    ['page-translation-whole-pag-06966-hidden-and-editable-content', 'page-bilingual.png'],
    ['page-translation-dark-page-58008--model-output-is-inert-text', 'page-dark.png'],
    ['extension-sentence-analysi-f1754-er-the-ordinary-translation', 'sentence-analysis-card.png'],
    ['extension-sentence-analysi-bc939--model-markup-as-plain-text', 'sentence-analysis-small-viewport.png'],
    ['extension-grammar-colors-m-c0aae-ce-analysis-is-switched-off', 'sentence-analysis-colors.png'],
  ];
  await mkdir(path.join(destination, 'screenshots'), { recursive: true });
  for (const [folder, file] of screenshots) await copyFile(path.join(evidence, 'test-results', folder, file), path.join(destination, 'screenshots', `${browser}-${file}`));
}
await copyFile(path.join(root, 'docs', 'guides', 'INSTALL.md'), path.join(destination, '安装说明.md'));
await copyFile(path.join(root, 'docs', 'development', 'VALIDATION.md'), path.join(destination, '验证记录.md'));
await writeFile(path.join(destination, 'SHA256SUMS.txt'), artifacts.map(item => `${item.sha256}  ${item.filename}`).join('\n') + '\n');
let realApiVerified = false;
try {
  const proof = JSON.parse(await readFile(path.join(output, 'installed-diagnostic.json'), 'utf8'));
  const sample = proof.states?.find(item => item.phase === 'result' && item.version === version && typeof item.result?.translation === 'string');
  if (sample) {
    realApiVerified = true;
    await writeFile(path.join(destination, 'connection-check.json'), JSON.stringify({ version, sample: sample.sample ?? 'JavaScript', result: sample.result }, null, 2) + '\n');
  }
} catch (error) { if (error?.code !== 'ENOENT') throw error; }
try {
  const pageProof = JSON.parse(await readFile(path.join(output, 'go-page-optimized-repeat.json'), 'utf8'));
  const result = pageProof.result;
  if (result?.phase === 'complete' && result.version === version && result.failed === 0 && result.completed === result.total && result.total > 0) {
    realApiVerified = true;
    await writeFile(path.join(destination, 'connection-check.json'), JSON.stringify({
      version, kind: 'whole-page', url: pageProof.sourceUrl, model: result.model,
      elapsedMs: result.elapsedMs, firstMs: result.firstMs, completed: result.completed,
      failed: result.failed, translatedChars: result.translatedChars,
    }, null, 2) + '\n');
    const baseline = JSON.parse(await readFile(path.join(output, 'go-page-baseline.json'), 'utf8'));
    const optimized = JSON.parse(await readFile(path.join(output, 'go-page-optimized-32.json'), 'utf8'));
    const metric = run => Object.fromEntries(['version', 'elapsedMs', 'firstMs', 'completed', 'total', 'failed', 'translatedChars']
      .filter(key => run.result[key] !== undefined).map(key => [key, run.result[key]]));
    await writeFile(path.join(destination, `performance-go-v${version}.json`), JSON.stringify({
      url: pageProof.sourceUrl, realApi: true, model: result.model, localTranslationCache: false,
      baseline: metric(baseline), optimized: [metric(optimized), metric(pageProof)],
    }, null, 2) + '\n');
    await copyFile(path.join(root, 'docs', 'reports', 'PERFORMANCE.md'), path.join(destination, '性能实测.md'));
  }
} catch (error) { if (error?.code !== 'ENOENT') throw error; }
try {
  const proof = JSON.parse(await readFile(path.join(output, 'installed-sentence-check.json'), 'utf8'));
  const result = proof.result;
  if (proof.realApi === true && result?.phase === 'complete' && result.version === version
    && typeof result.translation === 'string' && result.analysis?.mainClause?.text && result.analysis?.chunks?.length) {
    realApiVerified = true;
    await writeFile(path.join(destination, `sentence-analysis-example-v${version}.json`), JSON.stringify({
      version, realApi: true, model: result.model, source: result.source, translation: result.translation,
      analysis: result.analysis, timing: result.timing,
    }, null, 2) + '\n');
    await writeFile(path.join(destination, 'connection-check.json'), JSON.stringify({
      version, kind: 'sentence-analysis', model: result.model, timing: result.timing,
      chunks: result.analysis.chunks.length,
    }, null, 2) + '\n');
  }
} catch (error) { if (error?.code !== 'ENOENT') throw error; }
await writeFile(path.join(destination, 'release.json'), JSON.stringify({
  version, defaultModel: 'deepseek-flash', protocol: 'openai-chat-completions',
  providers: ['deepseek', 'openai', 'gemini', 'qwen', 'moonshot', 'siliconflow', 'openrouter', 'ollama', 'custom'],
  unitTests, browserTests, realApiVerified, artifacts,
}, null, 2) + '\n');
console.log(JSON.stringify({ version, artifacts }, null, 2));
