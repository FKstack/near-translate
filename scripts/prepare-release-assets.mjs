import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assertReleaseVersion, run } from './lib/release-tools.mjs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const tag = process.env.RELEASE_TAG;
if (!tag) throw new Error('RELEASE_TAG is required.');
assertReleaseVersion(tag, version);
const destination = '.output/release-assets';
mkdirSync(destination, { recursive: true });
const files = [
  [`.output/near-translate-${version}-chrome.zip`, `near-translate-chrome-v${version}.zip`],
  [`.output/near-translate-${version}-edge.zip`, `near-translate-edge-v${version}.zip`],
  ['.output/userscript/near-translate.user.js', 'near-translate.user.js'],
  ['.output/userscript/near-translate.meta.js', 'near-translate.meta.js'],
  ['.output/greasyfork/near-translate.user.js', 'near-translate-greasyfork.user.js'],
];
const manifest = { version, tag, commit: run('git', ['rev-parse', 'HEAD']).stdout, files: {} };
for (const [source, name] of files) {
  const bytes = readFileSync(source);
  if (!bytes.length) throw new Error(`Empty release asset: ${source}`);
  if (source.endsWith('.js') && !new RegExp(`^// @version\\s+${version.replaceAll('.', '\\.')}\\s*$`, 'm').test(bytes.toString('utf8'))) {
    throw new Error(`Release asset version differs from ${tag}: ${source}`);
  }
  copyFileSync(source, path.join(destination, name));
  manifest.files[name] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
writeFileSync(path.join(destination, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(path.join(destination, 'SHA256SUMS'), `${Object.entries(manifest.files).map(([name, entry]) => `${entry.sha256}  ${name}`).join('\n')}\n`);
console.log(`Prepared Chrome, Edge, GitHub userscript and readable Greasy Fork assets for ${tag}.`);
