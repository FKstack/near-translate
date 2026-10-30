import { appendFileSync, readFileSync } from 'node:fs';
import { readReleaseScope } from './lib/release-scope.mjs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const scope = readReleaseScope(version);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
  `release_scope=${scope}\npublish_userscripts=${scope === 'all'}\n`);
console.log(`Release v${version}: ${scope}.`);
