import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertNoNewerRelease, assertReleaseVersion, bumpVersion, compareVersions, githubPushArgs, githubRepository, nextReleaseVersion, parseFeatureOptions, parseVersion, run, updatePackageVersion, versionFromTag } from '../../scripts/lib/release-tools.mjs';

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) {
    if (path.dirname(path.resolve(directory)) !== path.resolve(tmpdir())) throw new Error('Temporary fixture cleanup escaped the named temp directory.');
    rmSync(directory, { recursive: true, force: true });
  }
});
function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'near-translate-release-test-'));
  temporary.push(directory);
  writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'near-translate', version: '0.11.3', scripts: { test: 'vitest' } }));
  writeFileSync(path.join(directory, 'package-lock.json'), JSON.stringify({ version: '0.11.3', packages: { '': { version: '0.11.3' }, example: { version: '8.0.0' } } }));
  return directory;
}

describe('Release version integrity', () => {
  it('bumps stable versions without lexicographic ordering mistakes', () => {
    expect(bumpVersion('0.11.9')).toBe('0.11.10');
    expect(bumpVersion('0.11.9', 'minor')).toBe('0.12.0');
    expect(bumpVersion('0.11.9', 'major')).toBe('1.0.0');
    expect(compareVersions('0.11.10', '0.11.9')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    for (const value of ['v1.2.3', '01.2.3', '1.2.3-beta.1', '1.2', '1.2.9007199254740992']) {
      expect(() => parseVersion(value)).toThrow();
    }
  });

  it('rejects tag and build version mismatches, including injected refs', () => {
    expect(versionFromTag('v0.11.4')).toBe('0.11.4');
    expect(versionFromTag('userscript-v0.11.3')).toBe('0.11.3');
    expect(() => assertReleaseVersion('v0.11.4', '0.11.3')).toThrow(/must match/);
    for (const tag of ['main', 'refs/tags/v0.11.4', 'v0.11.4;echo hi', 'v00.11.4']) expect(() => versionFromTag(tag)).toThrow();
  });

  it('retries the same commit idempotently and bumps versions occupied by other code', () => {
    expect(nextReleaseVersion('0.11.4', 'same-sha', { 'v0.11.4': 'same-sha' })).toBe('0.11.4');
    expect(nextReleaseVersion('0.11.3', 'main-sha', { 'userscript-v0.11.3': 'feature-sha', 'v0.11.4': 'other-sha' })).toBe('0.11.5');
    expect(nextReleaseVersion('0.10.0', 'main-sha', { 'v0.11.9': 'other-sha' })).toBe('0.11.10');
    expect(nextReleaseVersion('0.11.4', 'main-sha', { 'v0.11.2': 'older-sha' })).toBe('0.11.4');
  });

  it('changes both package roots and leaves dependencies and scripts intact', () => {
    const directory = fixture();
    updatePackageVersion(directory, '0.11.4');
    expect(JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'))).toEqual({ name: 'near-translate', version: '0.11.4', scripts: { test: 'vitest' } });
    expect(JSON.parse(readFileSync(path.join(directory, 'package-lock.json'), 'utf8'))).toEqual({ version: '0.11.4', packages: { '': { version: '0.11.4' }, example: { version: '8.0.0' } } });
  });

  it('validates both files before modifying either version', () => {
    const directory = fixture();
    writeFileSync(path.join(directory, 'package-lock.json'), '{"version":"0.11.3"}');
    const original = readFileSync(path.join(directory, 'package.json'), 'utf8');
    expect(() => updatePackageVersion(directory, '0.11.4')).toThrow(/root package/);
    expect(readFileSync(path.join(directory, 'package.json'), 'utf8')).toBe(original);
  });

  it('blocks a delayed or manually retried old Release from downgrading public update files', () => {
    expect(() => assertNoNewerRelease('0.11.4', ['v0.11.4', 'v0.11.2', 'unrelated-tag'])).not.toThrow();
    expect(() => assertNoNewerRelease('0.11.9', ['userscript-v0.11.10'])).toThrow(/newer stable Release/);
  });
});

describe('Feature publication safety', () => {
  it('stages only already staged content by default and accepts an explicit all flag', () => {
    expect(parseFeatureOptions([])).toEqual({ bump: 'patch', all: false, dryRun: false, title: '', notesFile: '' });
    expect(parseFeatureOptions(['--all', '--dry-run', '--bump', 'none', '--title', 'feat: 阅读模式', '--notes-file', 'notes with spaces.md'])).toEqual({ bump: 'none', all: true, dryRun: true, title: 'feat: 阅读模式', notesFile: 'notes with spaces.md' });
    for (const flags of [['--bump', 'wrong'], ['--notes-file'], ['--force'], ['--title', '--all']]) expect(() => parseFeatureOptions(flags)).toThrow();
  });

  it('uses the expected GitHub repository for HTTPS and SSH remotes', () => {
    for (const remote of ['https://github.com/FKstack/near-translate.git', 'git@github.com:FKstack/near-translate.git', 'ssh://git@github.com/FKstack/near-translate.git']) {
      expect(githubRepository(remote)).toBe('FKstack/near-translate');
    }
    for (const remote of ['https://github.com.evil.test/FKstack/near-translate', 'https://github.com/FKstack/near-translate/../../other', 'file:///tmp/repo']) expect(() => githubRepository(remote)).toThrow();
  });

  it('uses gh credentials per HTTPS push without force or global config changes', () => {
    const ref = 'HEAD:refs/heads/codex/feature-a';
    expect(githubPushArgs('https://github.com/FKstack/near-translate.git', ref)).toEqual(['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', 'push', 'origin', ref]);
    expect(githubPushArgs('git@github.com:FKstack/near-translate.git', ref)).toEqual(['push', 'origin', ref]);
  });

  it('passes hostile-looking notes as literal process arguments without invoking a shell', () => {
    const text = '`echo nope` $(echo nope) ; "with spaces"\nsecond line';
    expect(run(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', text]).stdout).toBe(text);
    expect(() => run(process.execPath, ['-e', 'process.exit(3)'])).toThrow(/failed \(3\)/);
  });

  it('performs a real Git dry run without changing versions, the index or untracked files', () => {
    const directory = fixture();
    mkdirSync(path.join(directory, 'scripts/lib'), { recursive: true });
    for (const file of ['feature-release.mjs', 'check-repository.mjs', 'lib/release-tools.mjs']) {
      copyFileSync(path.resolve('scripts', file), path.join(directory, 'scripts', file));
    }
    run('git', ['init', '--initial-branch=codex/dry-run'], { cwd: directory });
    run('git', ['remote', 'add', 'origin', 'https://github.com/FKstack/near-translate.git'], { cwd: directory });
    writeFileSync(path.join(directory, 'feature.txt'), 'intended feature');
    writeFileSync(path.join(directory, 'unrelated.png'), 'unrelated local file');
    run('git', ['add', '--', 'feature.txt', 'package.json', 'package-lock.json'], { cwd: directory });
    const before = run('git', ['diff', '--cached', '--binary'], { cwd: directory }).stdout;
    const packageBefore = readFileSync(path.join(directory, 'package.json'), 'utf8');
    const output = run(process.execPath, ['scripts/feature-release.mjs', '--dry-run', '--title', 'feat: example'], { cwd: directory }).stdout;
    const plan = JSON.parse(output.slice(output.indexOf('{\n  "dryRun"')));
    expect(plan.stage).not.toContain('unrelated.png');
    expect(plan.proposedVersion).toBe('0.11.4');
    expect(readFileSync(path.join(directory, 'package.json'), 'utf8')).toBe(packageBefore);
    expect(run('git', ['diff', '--cached', '--binary'], { cwd: directory }).stdout).toBe(before);
    expect(run('git', ['log', '-1'], { cwd: directory, allowFailure: true }).status).not.toBe(0);
    expect(readFileSync(path.join(directory, 'unrelated.png'), 'utf8')).toBe('unrelated local file');
  });
});
