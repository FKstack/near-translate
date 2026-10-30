import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseVersion } from './release-tools.mjs';

/** Scope belongs to one committed version's notes, never a mutable Release body. */
export function parseReleaseScope(notes) {
  const declarations = notes.match(/<!--\s*release-scope\s*:/g) ?? [];
  if (!declarations.length) return 'all';
  if (declarations.length !== 1) throw new Error('Release notes must declare release-scope at most once.');
  const marker = /^<!-- release-scope: (all|extensions-only) -->$/m.exec(notes.replaceAll('\r\n', '\n'));
  if (!marker) throw new Error('Invalid release-scope. Use <!-- release-scope: extensions-only --> or <!-- release-scope: all --> on its own line.');
  return marker[1];
}

export function readReleaseScope(version, root = process.cwd()) {
  parseVersion(version);
  let notes;
  try { notes = readFileSync(path.join(root, 'docs', 'releases', `v${version}.md`), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return 'all'; throw error; }
  return parseReleaseScope(notes);
}
