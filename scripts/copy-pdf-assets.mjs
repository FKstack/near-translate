import { cp, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const packageRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.join(projectRoot, 'public', 'pdfjs');
const licenses = path.join(projectRoot, 'public', 'licenses');
await mkdir(licenses, { recursive: true });
for (const filename of ['Apache-2.0.txt', 'NotoSansSC-OFL.txt', 'pdf-lib-fontkit.txt']) {
  await cp(path.join(projectRoot, 'third_party', 'licenses', filename), path.join(licenses, filename));
}
await cp(path.join(projectRoot, 'LICENSE'), path.join(licenses, 'near-translate.txt'));
for (const dependency of ['react', 'react-dom', 'scheduler', 'pdfjs-dist']) {
  const dependencyRoot = path.dirname(require.resolve(`${dependency}/package.json`));
  await cp(path.join(dependencyRoot, 'LICENSE'), path.join(licenses, `${dependency}.txt`));
}
const openccRoot = path.resolve(path.dirname(require.resolve('opencc-js')), '../..');
for (const [dependency, license, filename] of [
  ['marked', 'LICENSE', 'marked.txt'],
  ['pdf-lib', 'LICENSE.md', 'pdf-lib.txt'],
  ['@pdf-lib/standard-fonts', 'LICENSE.md', 'pdf-lib-standard-fonts.txt'],
  ['@pdf-lib/upng', 'LICENSE', 'pdf-lib-upng.txt'],
  ['@mozilla/readability', 'LICENSE.md', 'mozilla-readability-NOTICE.txt'],
  ['@pdf-lib/fontkit', 'README.md', 'pdf-lib-fontkit-README.md'],
  ['pako', 'LICENSE', 'pako.txt'],
]) {
  const dependencyRoot = path.dirname(require.resolve(`${dependency}/package.json`));
  await cp(path.join(dependencyRoot, license), path.join(licenses, filename));
}
await cp(path.join(path.dirname(require.resolve('tslib')), 'LICENSE.txt'), path.join(licenses, 'tslib.txt'));
await cp(path.join(openccRoot, 'LICENSE'), path.join(licenses, 'opencc-js-MIT.txt'));
await cp(path.join(openccRoot, 'LICENSES', 'Apache-2.0.txt'), path.join(licenses, 'opencc-data-Apache-2.0.txt'));
await cp(path.join(openccRoot, 'THIRD_PARTY_LICENSES.md'), path.join(licenses, 'opencc-js-THIRD_PARTY_LICENSES.md'));
const fonts = path.join(projectRoot, 'public', 'fonts');
await mkdir(fonts, { recursive: true });
if (await realpath(fonts) !== path.join(await realpath(projectRoot), 'public', 'fonts')) {
  throw new Error('Generated fonts must remain inside the project public directory.');
}
// The repository keeps a compact source; store packages must contain the real
// TTF, with the outer extension ZIP providing compression instead of nesting gzip.
const sourceFonts = path.join(projectRoot, 'third_party', 'fonts');
const font = gunzipSync(await readFile(path.join(sourceFonts, 'NearDocumentSans.ttf.gz')), { maxOutputLength: 32 * 1024 * 1024 });
if (font.length !== 10_642_808
  || createHash('sha256').update(font).digest('hex') !== '40d7aa23a3cb25765a3b019136fdfe70a9f08f428d8e1042f0d472fde376132a') {
  throw new Error('The local document font does not match the verified TrueType source.');
}
await writeFile(path.join(fonts, 'NearDocumentSans.ttf'), font);
await cp(path.join(sourceFonts, 'README.md'), path.join(fonts, 'README.md'));
// Clear the obsolete generated archive after the safe destination was verified.
await unlink(path.join(fonts, 'NearDocumentSans.ttf.gz')).catch(error => { if (error.code !== 'ENOENT') throw error; });
await mkdir(destination, { recursive: true });
const assets = [
  // Keep the stable local URL while shipping the upstream production worker.
  ['build/pdf.worker.min.mjs', 'pdf.worker.mjs'],
  ['cmaps', 'cmaps'],
  ['standard_fonts', 'standard_fonts'],
  ['wasm', 'wasm'],
  ['iccs', 'iccs'],
  ['web/images', 'images'],
  ['LICENSE', 'LICENSE'],
];
for (const [source, target] of assets) {
  await cp(path.join(packageRoot, source), path.join(destination, target), {
    recursive: true,
    force: true,
  });
}
const { version } = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
await writeFile(path.join(destination, 'version.json'), `${JSON.stringify({ version })}\n`);
console.log(`PDF.js ${version}: local worker, fonts, CMaps, images and decoders copied.`);
