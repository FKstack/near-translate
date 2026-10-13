import { browser } from 'wxt/browser';
import { publicSettings, WEB_ORIGINS } from './settings';

const SCRIPT_ID = 'near-translate-selection';

export async function synchronizeContentRegistration(): Promise<void> {
  const settings = await publicSettings();
  const scripts = await browser.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
  if (!settings.enabled || !settings.webAccess) {
    if (scripts.length) await browser.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
    return;
  }
  const registration = {
    id: SCRIPT_ID,
    js: ['content-scripts/selection.js'],
    matches: WEB_ORIGINS,
    allFrames: true,
    matchOriginAsFallback: true,
    persistAcrossSessions: true,
    runAt: 'document_idle' as const,
  };
  if (scripts.length) await browser.scripting.updateContentScripts([registration]);
  else await browser.scripting.registerContentScripts([registration]);
}

export async function broadcastPublicSettings(): Promise<void> {
  const settings = await publicSettings();
  const tabs = await browser.tabs.query({});
  await Promise.allSettled(tabs.filter(tab => tab.id !== undefined).map(tab => browser.tabs.sendMessage(tab.id!, { type: 'settings-changed', settings })));
}
