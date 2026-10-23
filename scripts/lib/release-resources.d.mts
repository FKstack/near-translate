export type PackageResourceEntries = Iterable<readonly [string, Uint8Array]>;

export interface NestedArchiveFinding {
  name: string;
  reasons: string[];
}

export const REQUIRED_DOCUMENT_FONT: Readonly<{
  path: 'fonts/NearDocumentSans.ttf';
  bytes: 10642808;
  sha256: '40d7aa23a3cb25765a3b019136fdfe70a9f08f428d8e1042f0d472fde376132a';
}>;

/** Inspect unpacked files; the outer distribution ZIP is not an entry. */
export function findNestedArchives(entries: PackageResourceEntries): NestedArchiveFinding[];
export function assertNoNestedArchives(entries: PackageResourceEntries): void;
export function assertRequiredDocumentFont(entries: PackageResourceEntries): void;
export function assertStorePackageResources(entries: PackageResourceEntries): void;
