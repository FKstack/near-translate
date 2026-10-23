import { execFileSync } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

// Parse Markdown so examples in fenced/inline code are not mistaken for links.
// Work from Git's candidate list: a local ignored build file cannot make a
// broken link appear valid when a contributor clones the repository.
const root = await realpath(fileURLToPath(new URL('..', import.meta.url)));
const gitPaths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
  cwd: root,
  encoding: 'utf8',
}).split('\0').filter(Boolean);
// `git add -A` records removals; deleted tracked paths are not upload candidates.
const present = await Promise.all(gitPaths.map(async (file) => {
  try { return (await stat(path.join(root, file))).isFile(); } catch { return false; }
}));
const candidates = gitPaths.filter((_, index) => present[index]);
const candidateSet = new Set(candidates.map((file) => file.replaceAll('\\', '/')));
const selected = process.argv.slice(2);
const markdown = selected.length ? selected : candidates.filter((file) => /\.md$/i.test(file));
const cache = new Map();
const problems = [];
let checked = 0;
let external = 0;
let machinePaths = 0;

function relative(file) {
  return path.relative(root, file).replaceAll('\\', '/');
}

function plain(tokens = []) {
  return tokens.map((token) => {
    if (token.type === 'html') return '';
    if (token.tokens) return plain(token.tokens);
    return token.text ?? token.raw ?? '';
  }).join('');
}

function headingSlug(value) {
  return value.toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:amp|lt|gt|quot|apos);/g, '')
    .replace(/[^\p{L}\p{M}\p{N}_\s-]/gu, '')
    .replace(/\s/g, '-');
}

async function document(file) {
  if (cache.has(file)) return cache.get(file);
  const content = await readFile(file, 'utf8');
  const tokens = marked.lexer(content);
  const anchors = new Set();
  const duplicates = new Map();
  const links = [];
  marked.walkTokens(tokens, (token) => {
    if (token.type === 'heading') {
      const base = headingSlug(plain(token.tokens));
      let slug = base;
      let occurrence = duplicates.get(base) ?? 0;
      while (anchors.has(slug)) slug = `${base}-${++occurrence}`;
      duplicates.set(base, occurrence);
      anchors.add(slug);
    }
    if (token.type === 'html') {
      for (const match of token.raw.matchAll(/\b(?:id|name)\s*=\s*["']([^"']+)["']/gi)) anchors.add(match[1]);
    }
    if (token.type === 'link' || token.type === 'image') links.push(token.href);
  });
  const parsed = { anchors, links };
  cache.set(file, parsed);
  return parsed;
}

for (const name of markdown) {
  const file = path.resolve(root, name);
  const from = relative(file);
  if (from.startsWith('../') || path.isAbsolute(from)) {
    problems.push(`${name}: source is outside the repository`);
    continue;
  }
  let source;
  try {
    source = await document(file);
  } catch (error) {
    problems.push(`${from}: cannot read Markdown (${error.code ?? error.message})`);
    continue;
  }
  for (const href of source.links) {
    // Historical machine paths are metadata, not portable repository links.
    if (/^(?:[a-z]:[\\/]|\\\\)/i.test(href)) { machinePaths++; continue; }
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) { external++; continue; }
    checked++;
    let pathname;
    let fragment;
    try {
      const hash = href.indexOf('#');
      pathname = decodeURIComponent((hash < 0 ? href : href.slice(0, hash)).split('?')[0]);
      fragment = hash < 0 ? '' : decodeURIComponent(href.slice(hash + 1));
    } catch {
      problems.push(`${from}: malformed URL ${href}`);
      continue;
    }
    const target = pathname.startsWith('/')
      ? path.resolve(root, `.${pathname}`)
      : path.resolve(path.dirname(file), pathname || path.basename(file));
    let repositoryPath = relative(target);
    if (repositoryPath.startsWith('../') || path.isAbsolute(repositoryPath)) {
      problems.push(`${from}: link leaves the repository: ${href}`);
      continue;
    }
    let targetStat;
    try {
      targetStat = await stat(target);
    } catch {
      problems.push(`${from}: missing target ${href}`);
      continue;
    }
    if (targetStat.isDirectory()) {
      const prefix = repositoryPath ? `${repositoryPath}/` : '';
      if (!candidates.some((candidate) => candidate.startsWith(prefix))) {
        problems.push(`${from}: directory has no publishable files: ${href}`);
      }
      if (fragment) {
        repositoryPath = `${prefix}README.md`;
        if (!candidateSet.has(repositoryPath)) {
          problems.push(`${from}: directory anchor needs a README.md: ${href}`);
          continue;
        }
        const parsed = await document(path.join(root, repositoryPath));
        if (!parsed.anchors.has(fragment.replace(/^user-content-/, ''))) problems.push(`${from}: missing anchor ${href}`);
      }
      continue;
    }
    if (!candidateSet.has(repositoryPath)) {
      problems.push(`${from}: target is ignored or excluded from Git: ${href}`);
      continue;
    }
    if (fragment && /\.md$/i.test(target)) {
      const parsed = await document(target);
      if (!parsed.anchors.has(fragment.replace(/^user-content-/, ''))) problems.push(`${from}: missing anchor ${href}`);
    }
  }
}

if (problems.length) {
  console.error(`Documentation link check failed (${problems.length}):\n${problems.map((problem) => `- ${problem}`).join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(`Documentation links passed: ${markdown.length} Markdown files, ${checked} repository links (${external} external URLs, ${machinePaths} historical machine paths skipped).`);
}
