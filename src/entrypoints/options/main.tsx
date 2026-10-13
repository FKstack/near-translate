import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { browser } from 'wxt/browser';
import { DEFAULT_MODEL, type PublicSettings } from '@/shared/contracts';
import { WEB_ORIGINS } from '@/platform/settings';
import '@/ui/app.css';

function Options() {
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [apiKey, setApiKey] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [includeContext, setIncludeContext] = useState(true);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [webAccess, setWebAccess] = useState(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [removeKey, setRemoveKey] = useState(false);
  const apply = (settings: PublicSettings) => {
    setModel(settings.model); setEnabled(settings.enabled); setIncludeContext(settings.includeContext);
    setHasApiKey(settings.hasApiKey); setWebAccess(settings.webAccess);
  };
  useEffect(() => {
    void browser.runtime.sendMessage({ type: 'get-settings' }).then((settings: PublicSettings) => { apply(settings); setReady(true); }).catch(() => setError('读取设置失败，请重新加载扩展。'));
  }, []);
  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setNotice(''); setError('');
    try {
      const result = await browser.runtime.sendMessage({ type: 'save-settings', settings: { model, apiKey, enabled, includeContext }, keepExistingKey: !removeKey });
      if (!result?.ok) throw new Error(result?.error ?? '保存失败，请重试。');
      apply(result.settings); setApiKey(''); setRemoveKey(false); setNotice('设置已保存。已打开的网页如未出现按钮，请刷新一次。');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '保存失败。'); }
    finally { setBusy(false); }
  }
  async function grantAccess() {
    setError(''); setNotice('');
    try {
      const granted = await browser.permissions.request({ origins: WEB_ORIGINS });
      if (!granted) { setNotice('网页访问权限尚未启用，你仍可使用 PDF 阅读器。'); return; }
      const settings = await browser.runtime.sendMessage({ type: 'refresh-permissions' });
      if (typeof settings?.webAccess !== 'boolean') throw new Error('权限已授予，但网页启用失败，请重试。');
      setWebAccess(settings.webAccess); setNotice('网页划词已启用。请刷新之前打开的网页，然后双击英文或拖选句段。');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '授权失败。'); }
  }
  return <main className="page">
    <header className="brand"><span className="brand-icon" aria-hidden="true">译</span><div><h1>近译 · 英文划词翻译</h1><div className="muted">选中，点击，读懂。网页与 PDF 共用你的翻译设置。</div></div></header>
    <section className="panel"><h2>1. 连接 DeepSeek</h2>
      <form onSubmit={save}>
        <div className="field"><label htmlFor="apiKey">DeepSeek API Key</label><input id="apiKey" type="password" autoComplete="off" value={apiKey} onChange={event => { setApiKey(event.target.value); setRemoveKey(false); }} placeholder={hasApiKey && !removeKey ? '已保存；留空保留现有 Key' : '填写你的 API Key'} />
          <div className="muted">Key 保存在本机扩展存储中，不同步。仅在点击翻译时调用官方 API，按你的账户用量计费。<a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noreferrer">获取 API Key</a></div>
          {hasApiKey && <button type="button" onClick={() => { setRemoveKey(true); setApiKey(''); setNotice('点击保存后将删除已有 Key。'); }}>删除已保存的 Key</button>}
        </div>
        <div className="field"><label htmlFor="model">模型名</label><input id="model" type="text" value={model} onChange={event => setModel(event.target.value)} required maxLength={120} /><div className="muted">默认 deepseek-flash，使用非思考模式。模型名可按 DeepSeek 官方支持列表修改。</div></div>
        <label className="check"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />启用翻译</label>
        <label className="check"><input type="checkbox" checked={includeContext} onChange={event => setIncludeContext(event.target.checked)} />附带所在句或附近一句上下文，提高词义判断准确度</label>
        <p className="muted">额外上下文最多 600 字符，只在你点击翻译时发送；只翻译选中内容，保持术语、数字和代码标识符。</p>
        <div className="actions"><button className="primary" disabled={busy || !ready} type="submit">{busy ? '正在保存…' : '保存设置'}</button><span className="muted">{hasApiKey && !removeKey ? '✓ 已配置 Key' : '尚未配置 Key'}</span></div>
      </form>
    </section>
    <section className="panel"><h2>2. 启用网页划词</h2><p className="muted">自动在选区旁显示按钮，需要网页访问权限。双击英文单词或拖选句段，点击「译」查看结果。</p><button type="button" className="primary" onClick={() => void grantAccess()} disabled={webAccess}>{webAccess ? '✓ 网页权限已启用' : '启用网页划词'}</button><p className="muted">浏览器设置页和内置 PDF 页无法直接显示按钮。PDF 请从工具栏打开近译阅读器。</p></section>
    <section className="panel"><h2>3. 翻译 PDF</h2><p className="muted">在线 PDF：在 PDF 标签页点击扩展图标，再点击「用阅读器打开当前 PDF」。本地 PDF：进入阅读器后选择文件。支持可选择文字的文档。</p><button onClick={() => void browser.tabs.create({ url: browser.runtime.getURL('/reader.html') })}>打开 PDF 阅读器</button></section>
    <div role="status" className="status success">{notice}</div>{error && <div role="alert" className="status notice error">{error}</div>}
  </main>;
}

createRoot(document.getElementById('root')!).render(<Options />);
