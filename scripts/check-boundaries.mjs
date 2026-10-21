import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const failures = [];
const root = path.resolve('src');
const allowed = {
  core: new Set(['core', 'shared']),
  providers: new Set(['providers', 'core', 'shared']),
  selection: new Set(['selection', 'core', 'shared', 'ui']),
  page: new Set(['page', 'shared']),
  platform: new Set(['platform', 'shared']),
};
async function check(dir, owner) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await check(file, owner);
    else if (/\.[cm]?[jt]sx?$/.test(file)) {
      const source = await readFile(file, 'utf8');
      const imports = source.matchAll(/(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/g);
      for (const [, specifier] of imports) {
        const target = specifier.startsWith('@/') ? path.resolve(root, specifier.slice(2))
          : specifier.startsWith('.') ? path.resolve(path.dirname(file), specifier) : undefined;
        if (target) {
          const module = path.relative(root, target).split(path.sep)[0];
          const sharedTransport = ['selection', 'page'].includes(owner)
            && target === path.join(root, 'platform', 'translation-client');
          if (!allowed[owner].has(module) && !sharedTransport) failures.push(`${file}: ${owner} 不得依赖 ${specifier}`);
        } else if (['core', 'providers'].includes(owner) && /^(react|wxt)(\/|$)/.test(specifier)) {
          failures.push(`${file}: ${owner} 不得依赖 UI 或浏览器 API`);
        }
      }
    }
  }
}
for (const owner of Object.keys(allowed)) await check(path.join(root, owner), owner);
if (failures.length) { process.stderr.write(failures.join('\n') + '\n'); process.exitCode = 1; }
else process.stdout.write('模块依赖边界检查通过。\n');
