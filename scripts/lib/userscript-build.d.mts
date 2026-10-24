export const USERSCRIPT_NAME: string;
export const USERSCRIPT_BASE_URL: string;
export const USERSCRIPT_REPOSITORY: string;
export const OPENCC_REQUIRE_URL: string;
export const READABILITY_REQUIRE_URL: string;
export const GREASY_FORK_MAX_BYTES: number;
export type UserscriptDistribution = 'github' | 'greasyfork';
export function userscriptMetadata(version: string, distribution?: UserscriptDistribution): string;
export type UserscriptBundleEntry = {
  type: 'chunk'; isEntry: boolean; imports: string[]; dynamicImports: string[];
  modules: Record<string, unknown>; code: string;
} | { type: 'asset'; fileName: string; source: string | Uint8Array };
export function assembleUserscript(output: UserscriptBundleEntry[], version: string, notices?: string, distribution?: UserscriptDistribution): { userScript: string; metadata: string };
export function userscriptInstallPage(version: string): string;
export function userscriptSettingsPage(): string;
export function userscriptGuidePage(content: string): string;
