import { mkdtempSync, readFileSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bumpVersion, compareVersions, githubPushArgs, githubRepository, parseFeatureOptions, run, updatePackageVersion } from './lib/release-tools.mjs';

const options = parseFeatureOptions(process.argv.slice(2));
const root = run('git', ['rev-parse', '--show-toplevel']).stdout;
process.chdir(root);
const git = args => run('git', args);
const branch = git(['branch', '--show-current']).stdout;
if (!branch || ['main', 'master'].includes(branch)) throw new Error('Run feature:release from a feature branch, not main or a detached HEAD.');
if (git(['diff', '--name-only', '--diff-filter=U']).stdout) throw new Error('Resolve merge conflicts before releasing.');
if (!options.all && git(['diff', '--name-only']).stdout) {
  throw new Error('Tracked files have unstaged changes. Stage the intended changes first, or explicitly use --all. Untracked files are not added by default.');
}
const remote = git(['remote', 'get-url', 'origin']).stdout;
const repository = githubRepository(remote);
const initialVersion = JSON.parse(readFileSync('package.json', 'utf8')).version;
const title = options.title || `feat: ${branch.replace(/^codex\//, '').replaceAll('-', ' ')}`;
const customNotes = options.notesFile ? readFileSync(path.resolve(options.notesFile), 'utf8') : '';
const staged = git(['diff', '--cached', '--name-only']).stdout.split('\n').filter(Boolean);
run(process.execPath, ['scripts/check-repository.mjs'], { inherit: true });

if (options.dryRun) {
  console.log(JSON.stringify({ dryRun: true, branch, repository, title, bump: options.bump,
    localVersion: initialVersion, proposedVersion: options.bump === 'none' ? initialVersion : bumpVersion(initialVersion, options.bump),
    stage: options.all ? 'all non-ignored repository changes (explicit --all)' : [...staged, 'package.json', 'package-lock.json'],
    notesFile: options.notesFile || null,
    actions: ['fetch main and tags; choose an unused version', 'commit staged changes and version files', 'push feature branch', 'create or reuse main PR', 'wait for CI', 'squash merge pinned PR head', 'main workflow creates Release, then builds and publishes'],
  }, null, 2));
  process.exit(0);
}

run('gh', ['auth', 'status'], { inherit: true });
git(['fetch', 'origin', 'main', '--tags']);
const mainVersion = JSON.parse(git(['show', 'origin/main:package.json']).stdout).version;
const baseline = compareVersions(initialVersion, mainVersion) < 0 ? mainVersion : initialVersion;
if (options.bump === 'none' && compareVersions(initialVersion, mainVersion) <= 0) {
  throw new Error('--bump none requires a manually prepared version higher than origin/main.');
}
let version = options.bump === 'none' ? initialVersion : bumpVersion(baseline, options.bump);
const tags = new Set(git(['tag', '--list']).stdout.split('\n'));
if (options.bump === 'none' && (tags.has(`v${version}`) || tags.has(`userscript-v${version}`))) {
  throw new Error(`Version ${version} is already tagged. Prepare an unused version or choose a bump.`);
}
while (tags.has(`v${version}`) || tags.has(`userscript-v${version}`)) version = bumpVersion(version);
console.log(`Preparing ${branch} for v${version}.`);
if (options.all) git(['add', '-A', '--', '.']);
updatePackageVersion(root, version);
git(['add', '--', 'package.json', 'package-lock.json']);
git(['commit', '-m', title]);
const head = git(['rev-parse', 'HEAD']).stdout;
run('git', githubPushArgs(remote, `HEAD:refs/heads/${branch}`), { inherit: true });

const existing = JSON.parse(run('gh', ['pr', 'list', '--repo', repository, '--head', branch, '--base', 'main', '--state', 'open', '--json', 'number,url', '--limit', '2']).stdout);
if (existing.length > 1) throw new Error('Multiple open pull requests match this feature branch. Resolve them before merging.');
const directory = mkdtempSync(path.join(tmpdir(), 'near-translate-release-'));
const bodyFile = path.join(directory, 'notes.md');
let pr;
try {
  writeFileSync(bodyFile, customNotes || `${title}\n\nRelease version: v${version}\n\nAfter the squash merge, Release main creates the GitHub Release and publishes the tested distributions.\n`);
  if (!existing.length) {
    run('gh', ['pr', 'create', '--repo', repository, '--head', branch, '--base', 'main', '--title', title, '--body-file', bodyFile], { inherit: true });
  } else {
    run('gh', ['pr', 'edit', String(existing[0].number), '--repo', repository, '--title', title, '--body-file', bodyFile]);
  }
  pr = JSON.parse(run('gh', ['pr', 'view', branch, '--repo', repository, '--json', 'number,url,headRefOid,isDraft']).stdout);
} finally {
  unlinkSync(bodyFile);
  rmdirSync(directory);
}
console.log(`Pull request: ${pr.url}`);
if (pr.isDraft) throw new Error('The pull request is a draft. Mark it ready and rerun the checks/merge explicitly.');
if (pr.headRefOid !== head) throw new Error('The remote PR head changed; refusing to merge a different commit.');

// Check registration is asynchronous immediately after push / PR creation.
let registered = false;
for (let attempt = 0; attempt < 24; attempt += 1) {
  const checks = JSON.parse(run('gh', ['pr', 'view', String(pr.number), '--repo', repository, '--json', 'statusCheckRollup']).stdout).statusCheckRollup;
  if (checks?.length) { registered = true; break; }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
}
if (!registered) throw new Error(`CI checks have not registered for ${pr.url}. No merge was attempted. Check Actions before retrying.`);
run('gh', ['pr', 'checks', String(pr.number), '--repo', repository, '--watch', '--fail-fast', '--interval', '10'], { inherit: true });
run('gh', ['pr', 'merge', String(pr.number), '--repo', repository, '--squash', '--match-head-commit', head, '--subject', title], { inherit: true });
console.log(`Merged ${pr.url} with a linear squash commit. Follow Release main in GitHub Actions for the Release and publication result.`);
