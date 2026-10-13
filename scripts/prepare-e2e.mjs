import { cp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const workspace = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const output = resolve(workspace, '.output');
const source = resolve(output, 'chrome-mv3');
const target = resolve(output, 'e2e-extension');
const actualOutput = await realpath(output);
assert.equal(relative(workspace, actualOutput), '.output', 'Refuse an output directory outside this workspace.');
assert.equal(target, resolve(actualOutput, 'e2e-extension'), 'Refuse an unexpected test-copy path.');
assert.equal(relative(actualOutput, await realpath(source)), 'chrome-mv3', 'Refuse an external build source.');
const productionPath = resolve(source, 'manifest.json');
const productionText = await readFile(productionPath, 'utf8');
const production = JSON.parse(productionText);
const origins = ['http://*/*', 'https://*/*'];
assert(origins.every(origin => production.optional_host_permissions?.includes(origin)), 'Production must retain optional website access.');
assert(!origins.some(origin => production.host_permissions?.includes(origin)), 'Production must not request all website access at installation.');

try {
  const existing = await realpath(target);
  const destination = relative(actualOutput, existing);
  assert(destination === 'e2e-extension' && !destination.startsWith(`..${sep}`), 'Refuse an external test-copy deletion.');
  await rm(target, { recursive: true, force: true });
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
await cp(source, target, { recursive: true });
const testManifest = {
  ...production,
  host_permissions: [...new Set([...(production.host_permissions ?? []), ...origins])],
};
delete testManifest.optional_host_permissions;
await writeFile(resolve(target, 'manifest.json'), JSON.stringify(testManifest, null, 2) + '\n');
assert.equal(await readFile(productionPath, 'utf8'), productionText, 'Production manifest was modified.');
console.log('Prepared isolated E2E extension copy; production website permissions remain optional.');
