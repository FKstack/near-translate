import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { browser } from 'wxt/browser';
import type { PublicSettings } from '@/shared/contracts';
import { languageLabel, readLanguagePair } from '@/shared/languages';
import { DEEPL_WEB_ORIGIN } from '@/shared/translation-engine';
import { WEB_ORIGINS } from '@/platform/settings';
import { FreeSetup } from '@/ui/free-setup/FreeSetup';
import { useFreeSetup } from '@/ui/free-setup/useFreeSetup';
import type { FreeSetupClient } from '@/ui/free-setup/client';
import '@/ui/app.css';

const freeSetupClient: FreeSetupClient = {
  requestPermissions: () => browser.permissions.request({ origins: [...WEB_ORIGINS, DEEPL_WEB_ORIGIN] }),
  sendMessage: message => browser.runtime.sendMessage(message),
};

function Popup() {
  const [settings, setSettings] = useState<PublicSettings>();
  const [error, setError] = useState('');
  const ready = Boolean(settings && !settings.keyVaultLocked && (settings.hasApiKey || settings.requiresApiKey === false) && settings.enabled && settings.apiAccess !== false && settings.webAccess);
  const freeReady = Boolean(settings && settings.translationEngine === 'deepl-web' && ready);
  const languages = readLanguagePair(settings ?? {});
  const freeSetup = useFreeSetup(freeSetupClient, updated => { setSettings(updated); setError(''); });
  useEffect(() => { void browser.runtime.sendMessage({ type: 'get-settings' }).then(setSettings).catch(() => setError('读取设置失败，请重新加载扩展。')); }, []);
  async function openCurrentPdf() {
    setError('');
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      const source = tab?.url;
      let url = browser.runtime.getURL('/reader.html');
      if (source && /^https?:\/\//i.test(source)) url += `?url=${encodeURIComponent(source)}`;
      else if (source?.startsWith('file:')) url += '?local=1';
      else throw new Error('请先打开在线 PDF 标签页，或使用下方入口选择本地 PDF。');
      await browser.tabs.create({ url });
      window.close();
    } catch (reason) { setError(reason instanceof Error ? reason.message : '打开阅读器失败。'); }
  }
  async function openReadingMode() {
    setError('');
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || !tab.url || !/^https?:\/\//i.test(tab.url)) throw new Error('请先打开一篇普通网页文章，再进入阅读模式。PDF请使用下方阅读器。');
      try { await browser.tabs.sendMessage(tab.id, { type: 'open-reading-mode' }); }
      catch {
        // The popup's existing activeTab grant opens local reading on this page only.
        await browser.scripting.executeScript({ target: { tabId: tab.id }, files: ['/content-scripts/selection.js'] });
        await browser.tabs.sendMessage(tab.id, { type: 'open-reading-mode' });
      }
      window.close();
    } catch (reason) { setError(reason instanceof Error ? reason.message : '打开阅读模式失败，请刷新网页后重试。'); }
  }
  return <main className="popup">
    <header className="brand">
      <img className="brand-mark" src="/brand/near-translate.svg" alt="" aria-hidden="true" />
      <div><h1>近译</h1><span className="muted">阅读 · 理解 · 翻译</span></div>
    </header>
    <p className="muted popup-intro">把文章变成安静的阅读页。保留目录、代码和图片，随时切换原文与双语。</p>
    <div className="notice popup-status" role="status" data-ready={ready}>
      <span className="status-dot" aria-hidden="true" />
      <span>{settings ? settings.keyVaultLocked && settings.translationEngine === 'model' ? 'API Key 受密钥库保护。请到翻译设置中解锁或完成加密迁移；本地阅读和免费翻译仍可使用。' : !ready && settings.translationEngine === 'deepl-web' ? '本地阅读已可用。点击下方“启用免费翻译”，一次完成翻译权限设置。' : !settings.hasApiKey && settings.requiresApiKey !== false ? '可先启用免费翻译，无需 Key；已有模型配置会保留。' : !settings.enabled ? '翻译已暂停，可在设置中启用。' : settings.apiAccess === false ? '请在翻译设置中保存并授权当前翻译服务。' : !settings.webAccess ? '翻译服务已配置，请在设置中启用网页划词。' : `已就绪 · ${settings.translationEngine === 'deepl-web' ? 'DeepL 免费翻译' : settings.model}` : '正在读取设置…'}</span>
    </div>
    {settings?.keyVaultLocked && settings.translationEngine === 'model' && <button type="button" className="popup-language" onClick={() => void browser.runtime.openOptionsPage()}>打开翻译设置，解锁密钥库</button>}
    {(!ready || settings?.translationEngine === 'deepl-web') && <FreeSetup compact ready={Boolean(settings)} enabled={freeReady} {...freeSetup} onEnable={() => { setError(''); freeSetup.enable(); }} onTest={() => { setError(''); freeSetup.test(); }}/>}
    <button type="button" className="popup-language" aria-label="修改翻译语言" onClick={() => void browser.runtime.openOptionsPage()}><span>{languageLabel(languages.sourceLanguage)} <span aria-hidden="true">→</span> {languageLabel(languages.targetLanguage)}</span><span>语言设置</span></button>
    <div className="actions popup-actions">
      <button className="primary" onClick={() => void openReadingMode()}>
        <svg className="action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 6C9 4 6 4 3 5v14c3-1 6-1 9 1 3-2 6-2 9-1V5c-3-1-6-1-9 1ZM12 6v14M6 9h3m6 0h3M6 13h3m6 0h3"/></svg>
        <span className="action-copy">阅读当前网页<small>本地打开 · 无需登录或 Key</small></span>
        <svg className="action-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m10 7 5 5-5 5"/></svg>
      </button>
      <button onClick={() => void openCurrentPdf()}>
        <svg className="action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 5.5h6a3 3 0 0 1 2 1 3 3 0 0 1 2-1h6v13h-6a3 3 0 0 0-2 1 3 3 0 0 0-2-1H4z" /><path d="M12 6.5v13" /></svg>
        <span className="action-copy">用阅读器打开当前 PDF</span>
        <svg className="action-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m10 7 5 5-5 5" /></svg>
      </button>
      <button onClick={() => void browser.tabs.create({ url: browser.runtime.getURL('/reader.html') })}>
        <svg className="action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></svg>
        <span className="action-copy">选择本地 PDF / 输入 PDF 链接</span>
        <svg className="action-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m10 7 5 5-5 5" /></svg>
      </button>
      <button onClick={() => void browser.tabs.create({ url: browser.runtime.getURL('/convert.html') })}>
        <svg className="action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8zM14 3v5h5M8 13h8m-2-2 2 2-2 2M16 18H8m2-2-2 2 2 2" /></svg>
        <span className="action-copy">文档转换<small>Markdown、图片与 PDF · 本机处理</small></span>
        <svg className="action-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m10 7 5 5-5 5" /></svg>
      </button>
      <button onClick={() => void browser.runtime.openOptionsPage()}>
        <svg className="action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 7h14M5 17h14M8 4v6M16 14v6" /><circle cx="8" cy="7" r="2" fill="var(--surface, #fffdf8)" /><circle cx="16" cy="17" r="2" fill="var(--surface, #fffdf8)" /></svg>
        <span className="action-copy">翻译设置</span>
        <svg className="action-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m10 7 5 5-5 5" /></svg>
      </button>
    </div>
    {error && <p role="alert" className="notice error">{error}</p>}
    <footer className="popup-footer">DeepL / 大模型 API · {languageLabel(languages.targetLanguage)}</footer>
  </main>;
}

createRoot(document.getElementById('root')!).render(<Popup />);
