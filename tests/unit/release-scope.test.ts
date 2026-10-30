import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parseReleaseScope, readReleaseScope, type ReleaseScope } from '../../scripts/lib/release-scope.mjs';
import { run } from '../../scripts/lib/release-tools.mjs';

const temporary: string[] = [];
const version = '1.2.3';
const marker = '<!-- release-scope: extensions-only -->';
const scripts = fileURLToPath(new URL('../../scripts/', import.meta.url));

afterEach(() => {
  for (const directory of temporary.splice(0)) {
    if (path.dirname(path.resolve(directory)) !== path.resolve(tmpdir())) throw new Error('Temporary fixture cleanup escaped the named temp directory.');
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(scope?: ReleaseScope) {
  const directory = mkdtempSync(path.join(tmpdir(), 'near-translate-release-scope-'));
  temporary.push(directory);
  const write = (file: string, content: string) => {
    const destination = path.join(directory, file);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  };
  write('package.json', JSON.stringify({ version }));
  if (scope) write(`docs/releases/v${version}.md`, `# v${version}\n\n<!-- release-scope: ${scope} -->\n`);
  write(`.output/near-translate-${version}-chrome.zip`, 'tested-chrome-zip');
  write(`.output/near-translate-${version}-edge.zip`, 'tested-edge-zip');
  // Both script builds still exist in an extension-only workflow after testing.
  for (const file of ['userscript/near-translate.user.js', 'userscript/near-translate.meta.js', 'greasyfork/near-translate.user.js']) {
    write(`.output/${file}`, `// @version ${version}\n// tested script\n`);
  }
  return { directory, write };
}

function execute(script: string, directory: string) {
  return run(process.execPath, [path.join(scripts, script)], { cwd: directory, env: {
    ...process.env,
    // Packaging needs only the source commit, not a writable fixture repository.
    GIT_DIR: run('git', ['rev-parse', '--absolute-git-dir']).stdout,
    GIT_WORK_TREE: directory,
    RELEASE_TAG: `v${version}`,
    GITHUB_OUTPUT: path.join(directory, 'github-output'),
  } });
}

describe('version-specific publication scope', () => {
  it('preserves full publication for existing notes without a marker', () => {
    expect(parseReleaseScope('# Release notes\n\nChanges.\n')).toBe('all');
    expect(parseReleaseScope('<!-- release-scope: all -->\n')).toBe('all');
    expect(parseReleaseScope(`# Release\r\n${marker}\r\n`)).toBe('extensions-only');
  });

  it.each([
    '<!-- release-scope: userscripts-only -->',
    '<!-- release-scope: extensions-only',
    '<!-- release-scope:extensions-only -->',
    `${marker}\n${marker}`,
    `${marker}\n<!-- release-scope: all -->`,
  ])('rejects unknown, malformed or duplicate declarations: %s', notes => {
    expect(() => parseReleaseScope(notes)).toThrow(/release-scope/);
  });

  it('reads only the exact package version notes for every workflow entry point', () => {
    const { directory, write } = fixture();
    write('docs/releases/v1.2.2.md', marker);
    expect(readReleaseScope(version, directory)).toBe('all');
    execute('release-scope.mjs', directory);
    expect(readFileSync(path.join(directory, 'github-output'), 'utf8')).toContain('publish_userscripts=true\n');
    write(`docs/releases/v${version}.md`, marker);
    expect(readReleaseScope(version, directory)).toBe('extensions-only');
    execute('release-scope.mjs', directory);
    expect(readFileSync(path.join(directory, 'github-output'), 'utf8')).toContain('release_scope=extensions-only\npublish_userscripts=false\n');
    expect(() => readReleaseScope('../outside', directory)).toThrow(/stable/);
  });
});

describe('scoped Release attachments', () => {
  it.each(['all', 'extensions-only'] as const)('packages only the %s distributions with matching checksums', scope => {
    const { directory } = fixture(scope);
    execute('prepare-release-assets.mjs', directory);
    const output = path.join(directory, '.output', 'release-assets');
    const expected = [`near-translate-chrome-v${version}.zip`, `near-translate-edge-v${version}.zip`,
      ...(scope === 'all' ? ['near-translate.user.js', 'near-translate.meta.js', 'near-translate-greasyfork.user.js'] : [])];
    expect(readdirSync(output).sort()).toEqual([...expected, 'release-manifest.json', 'SHA256SUMS'].sort());
    const manifest = JSON.parse(readFileSync(path.join(output, 'release-manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ version, tag: `v${version}`, scope });
    expect(Object.keys(manifest.files).sort()).toEqual([...expected].sort());
    const checksums = expected.map(name => {
      const bytes = readFileSync(path.join(output, name));
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      expect(manifest.files[name]).toEqual({ bytes: bytes.length, sha256 });
      return `${sha256}  ${name}`;
    });
    expect(readFileSync(path.join(output, 'SHA256SUMS'), 'utf8')).toBe(`${checksums.join('\n')}\n`);
  });

  it('refuses stale userscript attachments before an extension-only upload can glob them', () => {
    const { directory, write } = fixture('extensions-only');
    write('.output/release-assets/near-translate.user.js', 'previous-build');
    expect(() => execute('prepare-release-assets.mjs', directory)).toThrow(/outside this version and scope/);
    expect(readdirSync(path.join(directory, '.output', 'release-assets'))).toEqual(['near-translate.user.js']);
  });
});
