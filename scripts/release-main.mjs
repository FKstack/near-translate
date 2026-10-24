import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { nextReleaseVersion, run, updatePackageVersion } from './lib/release-tools.mjs';

if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.GITHUB_REPOSITORY) {
  throw new Error('release-main.mjs is reserved for the main GitHub Actions workflow. Use feature:release locally.');
}
const git = args => run('git', args).stdout;
if (git(['status', '--porcelain', '--untracked-files=no'])) throw new Error('Release checkout must be clean.');
git(['fetch', 'origin', 'main', '--tags']);
// Queued main runs deliberately release the newest main. An earlier release can
// never force-push over a feature merged while this workflow was waiting.
git(['checkout', '--detach', 'origin/main']);
let head = git(['rev-parse', 'HEAD']);
const originalVersion = JSON.parse(readFileSync('package.json', 'utf8')).version;
const tags = {};
for (const tag of git(['tag', '--list']).split('\n').filter(Boolean)) {
  if (/^(?:v|userscript-v)\d+\.\d+\.\d+$/.test(tag)) tags[tag] = git(['rev-list', '-n', '1', tag]);
}
const version = nextReleaseVersion(originalVersion, head, tags);
if (version !== originalVersion) {
  updatePackageVersion(process.cwd(), version);
  git(['add', '--', 'package.json', 'package-lock.json']);
  git(['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com', 'commit', '-m', `chore: release v${version}`]);
  // A concurrent update rejects this ordinary fast-forward push. We never force
  // push or silently publish a version commit that main did not accept.
  run('git', ['push', 'origin', 'HEAD:refs/heads/main'], { inherit: true });
  head = git(['rev-parse', 'HEAD']);
}
const tag = `v${version}`;
const repository = process.env.GITHUB_REPOSITORY;
const release = run('gh', ['release', 'view', tag, '--repo', repository, '--json', 'url,isDraft,isPrerelease'], { allowFailure: true });
let url;
if (release.status === 0) {
  const existing = JSON.parse(release.stdout);
  if (existing.isDraft || existing.isPrerelease) throw new Error(`${tag} already exists as a draft or prerelease. Resolve it before publishing stable userscripts.`);
  if (tags[tag] !== head) throw new Error(`${tag} points at different code; refusing to reuse the Release.`);
  url = existing.url;
  console.log(`Reusing ${url} to retry publication.`);
} else {
  if (!/release not found|HTTP 404|Not Found/i.test(`${release.stderr}\n${release.stdout}`)) {
    throw new Error(`Could not inspect existing release: ${release.stderr || release.stdout}`);
  }
  const notes = `docs/releases/v${version}.md`;
  const args = ['release', 'create', tag, '--repo', repository, '--target', head, '--title', `近译 v${version}`];
  if (tags[tag]) args.push('--verify-tag');
  args.push(...(existsSync(notes) ? ['--notes-file', notes] : ['--generate-notes']));
  url = run('gh', args).stdout;
  console.log(`Created ${url}; build and publication start next.`);
}
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `release_tag=${tag}\nrelease_sha=${head}\n`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Release created\n\n[${tag}](${url}) from main commit \`${head}\`.\n\nThe next job builds, tests and publishes the distributions. A Release alone does not confirm deployment.\n`);
