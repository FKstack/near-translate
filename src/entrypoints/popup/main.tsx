import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { browser } from 'wxt/browser';
import type { PublicSettings } from '@/shared/contracts';
import '@/ui/app.css';

function Popup() {
  const [settings, setSettings] = useState<PublicSettings>();
  const [error, setError] = useState('');
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
  return <main className="popup">
    <header className="brand"><span className="brand-icon" aria-hidden="true">译</span><div><h1>近译</h1><span className="muted">英文划词翻译</span></div></header>
    <p className="muted">双击单词或拖选句段，点击附近的「译」。</p>
    <div className="notice">{settings ? !settings.hasApiKey ? '首次使用：请先填写 DeepSeek API Key。' : !settings.enabled ? '翻译已暂停，可在设置中启用。' : !settings.webAccess ? 'Key 已配置，请在设置中启用网页划词。' : `已就绪 · ${settings.model}` : '正在读取设置…'}</div>
    <div className="actions"><button className="primary" onClick={() => void openCurrentPdf()}>用阅读器打开当前 PDF</button><button onClick={() => void browser.tabs.create({ url: browser.runtime.getURL('/reader.html') })}>选择本地 PDF / 输入 PDF 链接</button><button onClick={() => void browser.runtime.openOptionsPage()}>翻译设置</button></div>
    {error && <p role="alert" className="notice error">{error}</p>}<footer>默认 deepseek-flash · 简体中文</footer>
  </main>;
}

createRoot(document.getElementById('root')!).render(<Popup />);
