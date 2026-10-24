import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));

/** Add the project homepage without replacing installation or update files. */
export async function buildProjectSite(outDir) {
  const files = [
    ['site/index.html', 'index.html'],
    ['site/styles.css', 'assets/site.css'],
    ['public/brand/near-translate.svg', 'assets/near-translate.svg'],
    ['docs/assets/readme/reader-bilingual.png', 'assets/reader-bilingual.png'],
    ['docs/assets/readme/word-context.png', 'assets/word-context.png'],
    ['docs/assets/store/v0.11.1/04-pdf-selection-1280x800.png', 'assets/pdf-selection.png'],
  ];
  // Read every input before touching the output, so a missing source cannot
  // leave a partially copied homepage in a previously successful build.
  const contents = await Promise.all(files.map(([source]) => readFile(path.join(root, source))));
  await mkdir(path.join(outDir, 'assets'), { recursive: true });
  await Promise.all(files.map(([, destination], index) => writeFile(path.join(outDir, destination), contents[index])));
  await writeFile(path.join(outDir, '.nojekyll'), '');
}
