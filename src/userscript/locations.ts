export const PROJECT_URL = 'https://github.com/FKstack/near-translate';
export const GUIDE_URL = 'https://fkstack.github.io/near-translate/userscript/guide.html';
export const SETTINGS_URL = 'https://fkstack.github.io/near-translate/userscript/settings.html';

/** Credential entry is limited to our own static page, never an arbitrary article. */
export function isSettingsPage(href: string): boolean {
  try {
    const current = new URL(href);
    const settings = new URL(SETTINGS_URL);
    return current.origin === settings.origin && current.pathname === settings.pathname;
  } catch { return false; }
}
