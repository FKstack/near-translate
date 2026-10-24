import { mountSelectionTranslator } from '../selection/mount';
import { mountPageTranslator } from '../page/mount';
import { createReadingMode, type ReadingModeController } from '../reading/mount';
import { TranslationServiceStatusClient } from '../platform/service-status';
import { browser } from './browser';
import { installRuntime } from './runtime';
import { mountSettings } from './Settings';
import { SETTINGS_URL, isSettingsPage } from './locations';

declare const GM_registerMenuCommand: (name: string, action: () => void | Promise<void>) => string | number;
declare const GM_unregisterMenuCommand: (id: string | number) => void;
declare const GM_openInTab: (url: string, options: { active: boolean; insert: boolean; setParent: boolean }) => unknown;

async function main(): Promise<void> {
  if (window.top !== window || !/^https?:$/.test(location.protocol)
    || !['text/html', 'application/xhtml+xml'].includes(document.contentType)) return;
  const settingsPage = isSettingsPage(location.href);
  // The extension and the script share UI hosts. Let the already-running instance own the article.
  if (!settingsPage && document.querySelector('near-translate[data-near-translate],near-page-translate[data-near-page-ui]')) return;
  const openSettings = () => { GM_openInTab(SETTINGS_URL, { active: true, insert: true, setParent: true }); };
  const disposeRuntime = await installRuntime({ onOpenSettings: openSettings });
  const menus: Array<string | number> = [];
  const menu = (name: string, action: () => void | Promise<void>) => { menus.push(GM_registerMenuCommand(name, action)); };
  const cleanup: Array<() => void> = [disposeRuntime];

  if (settingsPage) cleanup.push(mountSettings());
  else {
    const serviceStatus = new TranslationServiceStatusClient();
    let selectionHost: HTMLElement | undefined;
    let closeSelection = () => {};
    const disposeSelection = mountSelectionTranslator({ source: 'web', onHost(host, close) { selectionHost = host; closeSelection = close; } });
    let reading: ReadingModeController | undefined;
    const getReading = () => reading ??= createReadingMode({ serviceStatus, onSelectionPortal(portal) {
      closeSelection();
      if (selectionHost) (portal ?? document.documentElement).append(selectionHost);
    } });
    let openReading = () => getReading().open();
    const disposePage = mountPageTranslator({ serviceStatus, onRead: translations => getReading().open(translations), onReadingAction: action => { openReading = action; } });
    const shortcut = (event: KeyboardEvent) => {
      if (!event.altKey || !event.shiftKey || event.code !== 'KeyR') return;
      event.preventDefault(); openReading();
    };
    document.addEventListener('keydown', shortcut, true);
    menu('近译 · 阅读当前网页', () => { openReading(); });
    menu('近译 · 翻译设置', openSettings);
    menu('近译 · 解锁本页模型 Key', async () => {
      if (!globalThis.crypto?.subtle) {
        globalThis.alert('近译：此网页不支持安全解锁，请使用 HTTPS 页面。本地阅读与免费翻译仍可使用。');
        return;
      }
      // A native sandbox dialog keeps the passphrase out of the article's DOM and keyboard events.
      const passphrase = globalThis.prompt('近译：输入密钥库口令以解锁本页模型 Key。口令仅留在本页；此原生输入框中的文字可见。');
      if (passphrase === null) return;
      try {
        const reply = await browser.runtime.sendMessage({ type: 'unlock-key-vault', passphrase }) as { ok?: boolean; error?: string };
        globalThis.alert(reply?.ok ? '近译：本页模型 Key 已解锁。刷新或离开本页后需重新解锁。' : reply?.error ?? '解锁失败，请重试。');
      } catch { globalThis.alert('近译：解锁失败，请重试。'); }
    });
    menu('近译 · 锁定本页模型 Key', async () => {
      try {
        const reply = await browser.runtime.sendMessage({ type: 'lock-key-vault' }) as { ok?: boolean };
        globalThis.alert(reply?.ok ? '近译：本页模型 Key 已锁定。' : '近译：锁定失败，请重试。');
      } catch { globalThis.alert('近译：锁定失败，请重试。'); }
    });
    cleanup.push(() => { document.removeEventListener('keydown', shortcut, true); disposePage(); reading?.dispose(); disposeSelection(); serviceStatus.dispose(); });
  }
  const unload = (event: PageTransitionEvent) => {
    if (event.persisted) return;
    window.removeEventListener('pagehide', unload);
    for (const id of menus) GM_unregisterMenuCommand(id);
    for (const dispose of cleanup.reverse()) dispose();
  };
  window.addEventListener('pagehide', unload);
}

void main().catch(() => { console.error('近译初始化失败，请确认篡改猴已获得脚本执行和存储权限，然后刷新页面。'); });
