import { browser } from 'wxt/browser';
import { publicSettings, WEB_ORIGINS } from './settings';
import { DEEPL_WEB_PREPARATION_PERMISSION } from '../shared/translation-engine';
import type { TranslationServiceStatus } from '../shared/contracts';

const SCRIPT_ID = 'near-translate-selection';
const PREPARATION_SCRIPT_ID = 'near-translate-network-prepare';
const BROADCAST_TIMEOUT_MS = 1_500;
const recoveringTabs = new Map<number, symbol>();

/** Frozen or outdated receivers must not hold the serialized settings save open. */
function notifyBestEffort(send: (pending: () => boolean) => Promise<unknown>): Promise<void> {
  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, BROADCAST_TIMEOUT_MS);
    try { void Promise.resolve(send(() => !settled)).then(finish, finish); }
    catch { finish(); }
  });
}

function recoverableOrigin(url: string | undefined): string | undefined {
  if (!url) return;
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return;
    // Browser-managed stores reject extension injection. Do not attempt it.
    if (['chromewebstore.google.com', 'chrome.google.com', 'microsoftedge.microsoft.com', 'addons.mozilla.org'].includes(parsed.hostname)) return;
    return `${parsed.protocol}//${parsed.hostname}/*`;
  } catch { /* A tab may be closing or have no inspectable URL. */ }
}

export async function synchronizeContentRegistration(): Promise<void> {
  const settings = await publicSettings();
  // Optional preparation must not prevent ordinary UI registration on a platform failure.
  try {
    const preparationScripts = await browser.scripting.getRegisteredContentScripts({ ids: [PREPARATION_SCRIPT_ID] });
    const prepares = settings.enabled && settings.webAccess && settings.apiAccess
      && settings.translationEngine === 'deepl-web'
      && await browser.permissions.contains({ permissions: [DEEPL_WEB_PREPARATION_PERMISSION] });
    if (prepares) {
      const registration = { id: PREPARATION_SCRIPT_ID, js: ['content-scripts/network-prepare.js'],
        matches: WEB_ORIGINS, allFrames: false, persistAcrossSessions: true, runAt: 'document_start' as const };
      if (preparationScripts.length) await browser.scripting.updateContentScripts([registration]);
      else await browser.scripting.registerContentScripts([registration]);
    } else if (preparationScripts.length) {
      await browser.scripting.unregisterContentScripts({ ids: [PREPARATION_SCRIPT_ID] });
    }
  } catch { /* The background also rechecks permissions before any preparation request. */ }
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
  const recoveryOwners: Array<[number, symbol]> = [];
  const tabNotifications = notifyBestEffort(async pending => {
    const tabs = await browser.tabs.query({});
    if (!pending()) return;
    await Promise.all(tabs.filter(tab => tab.id !== undefined).map(async tab => {
      try {
        await browser.tabs.sendMessage(tab.id!, { type: 'settings-changed', settings });
      } catch {
        const origin = recoverableOrigin(tab.url);
        if (!pending() || !settings.enabled || !settings.webAccess || !origin || recoveringTabs.has(tab.id!)) return;
        const owner = Symbol();
        recoveringTabs.set(tab.id!, owner);
        recoveryOwners.push([tab.id!, owner]);
        try {
          // A save or permission change can race the failed notification. Read
          // current capabilities before inserting UI, then let the entry point
          // obtain its own fresh settings instead of resending this snapshot.
          const current = await publicSettings();
          if (!pending() || !current.enabled || !current.webAccess) return;
          if (!await browser.permissions.contains({ origins: [origin] }) || !pending()) return;
          await browser.scripting.executeScript({ target: { tabId: tab.id!, allFrames: true }, files: ['/content-scripts/selection.js'] });
        } catch { /* Closed, protected or frozen tabs never block saving. */ }
        finally {
          if (recoveringTabs.get(tab.id!) === owner) recoveringTabs.delete(tab.id!);
        }
      }
    }));
  }).finally(() => {
    // Also release a recovery whose browser operation never acknowledged. The
    // pending guard prevents any late failure from starting another injection.
    for (const [tabId, owner] of recoveryOwners) if (recoveringTabs.get(tabId) === owner) recoveringTabs.delete(tabId);
  });
  await Promise.all([
    notifyBestEffort(() => browser.runtime.sendMessage({ type: 'settings-changed', settings })),
    tabNotifications,
  ]);
}

/** A service state change wakes receivers once; idle pages do not poll the worker. */
export async function broadcastTranslationStatus(status: TranslationServiceStatus): Promise<void> {
  const message = { type: 'translation-status-changed', status: {
    engine: status.engine, cooldownUntil: status.cooldownUntil, checkedAt: status.checkedAt,
  } };
  const runtime = notifyBestEffort(() => browser.runtime.sendMessage(message));
  // Tab enumeration failure must not prevent already open extension pages from
  // receiving the event or turn an optional notification into a translation failure.
  const tabs = await Promise.resolve().then(() => browser.tabs.query({})).catch(() => []);
  await Promise.all([
    runtime,
    ...tabs.filter(tab => tab.id !== undefined).map(tab => notifyBestEffort(
      () => browser.tabs.sendMessage(tab.id!, message),
    )),
  ]);
}
