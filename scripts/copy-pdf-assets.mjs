import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const packageRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.join(projectRoot, 'public', 'pdfjs');
await mkdir(destination, { recursive: true });
const assets = [
  ['build/pdf.worker.mjs', 'pdf.worker.mjs'],
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
