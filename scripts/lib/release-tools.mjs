import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

export function parseVersion(version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error(`Expected a stable major.minor.patch version, received ${version}.`);
  }
  const parts = version.split('.').map(Number);
  if (parts.some(part => !Number.isSafeInteger(part))) throw new Error('Version number is too large.');
  return parts;
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

export function bumpVersion(version, bump = 'patch') {
  const parts = parseVersion(version);
  const index = { major: 0, minor: 1, patch: 2 }[bump];
  if (index === undefined) throw new Error('--bump must be patch, minor or major.');
  parts[index] += 1;
  for (let next = index + 1; next < 3; next += 1) parts[next] = 0;
  const result = parts.join('.');
  parseVersion(result);
  return result;
}

export function versionFromTag(tag) {
  const match = /^(?:v|userscript-v)(\d+\.\d+\.\d+)$/.exec(tag);
  if (!match) throw new Error('Release tag must be v<version> (or an existing userscript-v<version> tag).');
  parseVersion(match[1]);
  return match[1];
}

export function assertReleaseVersion(tag, version) {
  if (versionFromTag(tag) !== version) throw new Error('Release tag must match package.json version.');
}

export function assertNoNewerRelease(version, releasedTags) {
  parseVersion(version);
  for (const tag of releasedTags) {
    if (/^(?:v|userscript-v)\d+\.\d+\.\d+$/.test(tag) && compareVersions(versionFromTag(tag), version) > 0) {
      throw new Error(`A newer stable Release (${tag}) exists; refusing to overwrite its update files with ${version}.`);
    }
  }
}

// A version already installed by users must never be reused for different code.
// The same commit is allowed so failed builds/deployments can be retried.
export function nextReleaseVersion(version, head, tags) {
  let candidate = version;
  parseVersion(candidate);
  for (const tag of Object.keys(tags)) {
    if (!/^(?:v|userscript-v)\d+\.\d+\.\d+$/.test(tag)) continue;
    const published = versionFromTag(tag);
    if (compareVersions(published, candidate) > 0) candidate = bumpVersion(published);
  }
  while ([`v${candidate}`, `userscript-v${candidate}`].some(tag => tags[tag] && tags[tag] !== head)) {
    candidate = bumpVersion(candidate);
  }
  return candidate;
}

export function parseFeatureOptions(args) {
  const options = { bump: 'patch', all: false, dryRun: false, title: '', notesFile: '' };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--all') options.all = true;
    else if (flag === '--dry-run') options.dryRun = true;
    else if (['--bump', '--title', '--notes-file'].includes(flag)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
      options[{ '--bump': 'bump', '--title': 'title', '--notes-file': 'notesFile' }[flag]] = value;
    } else throw new Error(`Unknown option: ${flag}`);
  }
  if (!['patch', 'minor', 'major', 'none'].includes(options.bump)) throw new Error('--bump must be patch, minor, major or none.');
  return options;
}

export function githubRepository(remote) {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(remote);
  if (!match || match[1].endsWith('/.')) throw new Error('origin must point to a GitHub repository.');
  return match[1];
}

export function run(command, args, { cwd = process.cwd(), allowFailure = false, inherit = false, env = process.env } = {}) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', windowsHide: true, stdio: inherit ? 'inherit' : 'pipe', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${command} ${args[0] ?? ''} failed (${result.status}).\n${result.stderr ?? ''}${result.stdout ?? ''}`.trim());
  }
  return { status: result.status, stdout: result.stdout?.trim() ?? '', stderr: result.stderr?.trim() ?? '' };
}

export function updatePackageVersion(root, version) {
  parseVersion(version);
  const updates = ['package.json', 'package-lock.json'].map(name => {
    const file = `${root}/${name}`;
    const json = JSON.parse(readFileSync(file, 'utf8'));
    json.version = version;
    if (name === 'package-lock.json') {
      if (!json.packages?.['']) throw new Error('package-lock.json is missing the root package.');
      json.packages[''].version = version;
    }
    return [file, `${JSON.stringify(json, null, 2)}\n`];
  });
  for (const [file, contents] of updates) writeFileSync(file, contents);
}

export function githubPushArgs(remote, refspec) {
  // Use the signed-in gh account for HTTPS without changing global credentials.
  const authentication = remote.startsWith('https://github.com/')
    ? ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential'] : [];
  return [...authentication, 'push', 'origin', refspec];
}
