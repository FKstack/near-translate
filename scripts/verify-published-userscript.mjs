import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';

const page = process.env.PAGE_URL;
const tag = process.env.RELEASE_TAG;
if (!page || !tag) throw new Error('PAGE_URL and RELEASE_TAG are required.');
const base = new URL(page.endsWith('/') ? page : `${page}/`);
if (base.protocol !== 'https:') throw new Error('Published update source must use HTTPS.');
const checks = [
  ['.output/userscript/near-translate.user.js', 'userscript/near-translate.user.js'],
  ['.output/userscript/near-translate.meta.js', 'userscript/near-translate.meta.js'],
  ['.output/greasyfork/near-translate.user.js', 'greasyfork/near-translate.user.js'],
  ['.output/greasyfork/description.md', 'greasyfork/description.md'],
].map(([file, relative]) => ({ url: new URL(relative, base), expected: createHash('sha256').update(readFileSync(file)).digest('hex') }));

for (let attempt = 0; attempt < 8; attempt += 1) {
  const results = await Promise.allSettled(checks.map(async ({ url, expected }) => {
    const probe = new URL(url);
    probe.searchParams.set('release', tag);
    probe.searchParams.set('attempt', String(attempt));
    const response = await fetch(probe, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`${url.pathname}: HTTP ${response.status}`);
    const actual = createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');
    if (actual !== expected) throw new Error(`${url.pathname}: CDN still serves different bytes.`);
  }));
  const failures = results.filter(result => result.status === 'rejected');
  if (!failures.length) {
    console.log(`Verified ${tag}: GitHub and Greasy Fork Pages update sources exactly match the tested build. Greasy Fork will fetch its source on its automatic synchronization schedule.`);
    process.exit(0);
  }
  console.log(`Pages verification attempt ${attempt + 1}: ${failures.map(result => result.reason.message).join(' ')}`);
  if (attempt < 7) await setTimeout(5000);
}
throw new Error('Pages deployment completed but update-source bytes did not match the tested release. Check the deployment before claiming publication succeeded.');
