export const USERSCRIPT_NAME: string;
export const USERSCRIPT_BASE_URL: string;
export const USERSCRIPT_REPOSITORY: string;
export function userscriptMetadata(version: string): string;
export type UserscriptBundleEntry = {
  type: 'chunk'; isEntry: boolean; imports: string[]; dynamicImports: string[];
  modules: Record<string, unknown>; code: string;
} | { type: 'asset'; fileName: string; source: string | Uint8Array };
export function assembleUserscript(output: UserscriptBundleEntry[], version: string, notices?: string): { userScript: string; metadata: string };
export function userscriptInstallPage(version: string): string;
export function userscriptSettingsPage(): string;
export function userscriptGuidePage(content: string): string;
