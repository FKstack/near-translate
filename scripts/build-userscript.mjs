import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { marked } from 'marked';
import { assembleUserscript, USERSCRIPT_NAME, userscriptGuidePage, userscriptInstallPage, userscriptSettingsPage } from './lib/userscript-build.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const result = await build({
  root,
  configFile: false,
  envDir: false,
  publicDir: false,
  mode: 'production',
  define: { 'process.env.NODE_ENV': '"production"' },
  resolve: { alias: [
    { find: /^wxt\/browser$/, replacement: path.join(root, 'src/userscript/browser.ts') },
    { find: '@', replacement: path.join(root, 'src') },
  ] },
  oxc: { jsx: { runtime: 'automatic', development: false } },
  build: {
    write: false,
    copyPublicDir: false,
    target: ['chrome111', 'edge111', 'firefox114'],
    minify: true,
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
const notices = (await Promise.all(noticeSources.map(async ([name, source]) => `${name}\n${await readFile(source, 'utf8')}`))).join('\n\n');
const { userScript, metadata } = assembleUserscript(bundles[0].output, version, notices);
const outDir = path.join(root, '.output/userscript');
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
