import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = await realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const args = process.argv.slice(2);
let output;
const directories = [];
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--output') {
    if (output || !args[index + 1]) throw new Error('Use --output <report.json> once.');
    output = path.resolve(root, args[++index]);
  } else if (args[index].startsWith('--')) {
    throw new Error(`Unknown option: ${args[index]}`);
  } else directories.push(args[index]);
}
if (!directories.length) directories.push('.output/chrome-mv3', '.output/edge-mv3');

function insideWorkspace(target) {
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Analyze extension directories and write reports only inside this workspace.');
  }
}

function group(filename) {
  if (filename.startsWith('pdfjs/')) return filename.split('/').slice(0, 2).join('/');
  return filename.split('/')[0];
}

async function analyze(directory) {
  const target = await realpath(path.resolve(root, directory));
  insideWorkspace(target);
  if (!(await stat(target)).isDirectory()) throw new Error('Expected a build directory.');
  const files = [];
  async function visit(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const filename = path.join(folder, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Build directories must not contain symbolic links.');
      if (entry.isDirectory()) await visit(filename);
      else if (entry.isFile()) {
        const bytes = await readFile(filename);
        files.push({ path: path.relative(target, filename).split(path.sep).join('/'), bytes: bytes.length, gzipBytes: gzipSync(bytes).length });
      }
    }
  }
  await visit(target);
  files.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
  const groups = new Map();
  for (const file of files) {
    const name = group(file.path);
    const current = groups.get(name) ?? { name, files: 0, bytes: 0, gzipBytes: 0 };
    current.files++; current.bytes += file.bytes; current.gzipBytes += file.gzipBytes;
    groups.set(name, current);
  }
  let version;
  try { version = JSON.parse(await readFile(path.join(target, 'manifest.json'), 'utf8')).version; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return {
    directory: path.relative(root, target).split(path.sep).join('/'), version,
    files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    gzipBytes: files.reduce((sum, file) => sum + file.gzipBytes, 0),
    groups: [...groups.values()].sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name)),
    largestFiles: files.slice(0, 20),
  };
}

const report = {
  schemaVersion: 1,
  measurement: 'Raw file bytes and sum of individually gzip-compressed files; gzip is an estimate, not a ZIP size or runtime memory measurement.',
  builds: [],
};
for (const directory of directories) report.builds.push(await analyze(directory));
if (output) {
  insideWorkspace(output);
  await mkdir(path.dirname(output), { recursive: true });
  // Check the resolved parent as well, so an existing junction cannot redirect writes.
  insideWorkspace(await realpath(path.dirname(output)));
  try { insideWorkspace(await realpath(output)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify(report, null, 2));
