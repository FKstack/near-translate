export type ReleaseScope = 'all' | 'extensions-only';
export function parseReleaseScope(notes: string): ReleaseScope;
export function readReleaseScope(version: string, root?: string): ReleaseScope;
