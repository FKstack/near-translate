import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'vite';
import { marked } from 'marked';
import { assembleUserscript, OPENCC_REQUIRE_URL, READABILITY_REQUIRE_URL, USERSCRIPT_NAME, userscriptGuidePage, userscriptInstallPage, userscriptSettingsPage } from './lib/userscript-build.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const greasyfork = process.argv.includes('--greasyfork');
const distribution = greasyfork ? 'greasyfork' : 'github';
const chineseVariants = path.join(root, 'src/core/chinese-variants.ts');
const result = await build({
  root,
  configFile: false,
  envDir: false,
  publicDir: false,
  mode: 'production',
  define: { 'process.env.NODE_ENV': '"production"' },
  resolve: { alias: [
    ...(greasyfork ? [{ find: /^@mozilla\/readability$/, replacement: path.join(root, 'src/userscript/greasyfork-readability.ts') }] : []),
    { find: /^wxt\/browser$/, replacement: path.join(root, 'src/userscript/browser.ts') },
    { find: '@', replacement: path.join(root, 'src') },
  ] },
  plugins: greasyfork ? [{
    name: 'greasyfork-opencc-library',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer) return null;
      const clean = importer.replace(/\?.*$/, '');
      const resolved = source.startsWith('@/') ? path.join(root, 'src', source.slice(2))
        : source.startsWith('.') ? path.resolve(path.dirname(clean), source) : null;
      if (resolved && path.normalize(resolved.replace(/\.ts$/, '')) === path.normalize(chineseVariants.replace(/\.ts$/, ''))) {
        return path.join(root, 'src/userscript/greasyfork-chinese-variants.ts');
      }
      return null;
    },
  }] : [],
  oxc: { jsx: { runtime: 'automatic', development: false } },
  build: {
    write: false,
    copyPublicDir: false,
    target: ['chrome111', 'edge111', 'firefox114'],
    minify: !greasyfork,
    sourcemap: false,
    cssCodeSplit: false,
    lib: { entry: path.join(root, 'src/userscript/main.tsx'), formats: ['iife'], name: 'NearTranslateUserscript', fileName: () => `${USERSCRIPT_NAME}.user.js` },
    rolldownOptions: { output: { codeSplitting: false } },
  },
});
const bundles = Array.isArray(result) ? result : [result];
if (bundles.length !== 1 || !('output' in bundles[0])) throw new Error('Unexpected userscript build output.');

// Keep complete license texts inside the standalone installation file. No
// runtime request or PDF asset preparation is needed for these notices.
const noticeSources = [
  ['Near Translate', path.join(root, 'LICENSE')],
  ['React', path.join(path.dirname(require.resolve('react/package.json')), 'LICENSE')],
  ['React DOM', path.join(path.dirname(require.resolve('react-dom/package.json')), 'LICENSE')],
  ['Scheduler', path.join(path.dirname(require.resolve('scheduler/package.json')), 'LICENSE')],
  ['Mozilla Readability', path.join(path.dirname(require.resolve('@mozilla/readability/package.json')), 'LICENSE.md')],
  ['Apache License 2.0', path.join(root, 'third_party/licenses/Apache-2.0.txt')],
];
const openccRoot = path.resolve(path.dirname(require.resolve('opencc-js')), '../..');
noticeSources.push(['OpenCC JavaScript', path.join(openccRoot, 'LICENSE')],
  ['OpenCC data', path.join(openccRoot, 'THIRD_PARTY_LICENSES.md')]);
let notices = (await Promise.all(noticeSources.map(async ([name, source]) => `${name}\n${await readFile(source, 'utf8')}`))).join('\n\n');
if (greasyfork) {
  const openccBytes = await readFile(path.join(openccRoot, 'dist/umd/full.js'));
  if (!OPENCC_REQUIRE_URL.endsWith(createHash('sha256').update(openccBytes).digest('hex'))) throw new Error('OpenCC package differs from the pinned @require content.');
  const readabilityBytes = await readFile(path.join(path.dirname(require.resolve('@mozilla/readability/package.json')), 'Readability.js'));
  if (!READABILITY_REQUIRE_URL.endsWith(createHash('sha256').update(readabilityBytes).digest('hex'))) throw new Error('Readability package differs from the pinned @require content.');
  const sourceRows = await Promise.all([
    ['react', ['react.production.js', 'react-jsx-runtime.production.js']],
    ['react-dom', ['react-dom.production.js', 'react-dom-client.production.js']],
    ['scheduler', ['scheduler.production.js']],
  ].map(async ([name, files]) => {
    const details = JSON.parse(await readFile(require.resolve(`${name}/package.json`), 'utf8'));
    return files.map(file => `${name} ${details.version}: https://cdn.jsdelivr.net/npm/${name}@${details.version}/cjs/${file}`).join('\n');
  }));
  notices = 'Greasy Fork distribution: the application is bundled without minification.\n'
    + 'React 19 and React DOM are embedded because official packages expose CommonJS modules rather than standalone UMD scripts; bundling preserves their shared module state.\n'
    + 'Their original production sources are formatted by the bundler; no additional identifier minification is applied.\n'
    + 'React 19 official UMD removal: https://react.dev/blog/2024/04/25/react-19-upgrade-guide#umd-builds-removed\n'
    + sourceRows.join('\n')
    + '\nMozilla Readability 0.6.0 (external @require): https://cdn.jsdelivr.net/npm/@mozilla/readability@0.6.0/Readability.js\n'
    + 'OpenCC JavaScript 1.4.2 (external @require): https://github.com/nk2028/opencc-js/tree/v1.4.2\n\n'
    + notices;
}
const { userScript, metadata } = assembleUserscript(bundles[0].output, version, notices, distribution);
const outDir = path.join(root, greasyfork ? '.output/greasyfork' : '.output/userscript');
if (greasyfork) {
  const siteGreasyFork = path.join(root, '.output/userscript-site/greasyfork');
  await Promise.all([mkdir(outDir, { recursive: true }), mkdir(siteGreasyFork, { recursive: true })]);
  await writeFile(path.join(outDir, `${USERSCRIPT_NAME}.user.js`), userScript);
  await writeFile(path.join(outDir, 'settings.html'), userscriptSettingsPage());
  await writeFile(path.join(siteGreasyFork, `${USERSCRIPT_NAME}.user.js`), userScript);
  const listing = await readFile(path.join(root, 'docs/guides/GREASYFORK_LISTING.md'), 'utf8');
  await writeFile(path.join(outDir, 'description.md'), listing);
  await writeFile(path.join(siteGreasyFork, 'description.md'), listing);
  console.log(`Greasy Fork ${version}: ${Buffer.byteLength(userScript)} bytes; readable, non-minified script in .output/greasyfork; OpenCC uses a pinned @require with SHA-256.`);
  process.exit(0);
}
const siteDir = path.join(root, '.output/userscript-site');
const siteScripts = path.join(siteDir, 'userscript');
await Promise.all([mkdir(outDir, { recursive: true }), mkdir(siteScripts, { recursive: true })]);
for (const destination of [outDir, siteScripts]) {
  await writeFile(path.join(destination, `${USERSCRIPT_NAME}.user.js`), userScript);
  await writeFile(path.join(destination, `${USERSCRIPT_NAME}.meta.js`), metadata);
}
const installPage = userscriptInstallPage(version);
await writeFile(path.join(siteScripts, 'index.html'), installPage);
await writeFile(path.join(siteScripts, 'settings.html'), userscriptSettingsPage());
const guideSource = await readFile(path.join(root, 'docs/guides/USERSCRIPT.md'), 'utf8');
await writeFile(path.join(siteScripts, 'guide.html'), userscriptGuidePage(await marked.parse(guideSource)));
await writeFile(path.join(siteDir, 'index.html'), installPage.replaceAll('href="./', 'href="./userscript/'));
await writeFile(path.join(siteDir, '.nojekyll'), '');
console.log(`Userscript ${version}: ${Math.ceil(Buffer.byteLength(userScript) / 1024)} KiB; standalone .user.js + .meta.js in .output/userscript; Pages site in .output/userscript-site.`);
