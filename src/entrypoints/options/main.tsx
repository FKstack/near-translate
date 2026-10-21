import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { browser } from 'wxt/browser';
import { DEFAULT_MODEL, type ConnectionSettings, type ProviderId } from '@/shared/contracts';
import { apiOriginPattern, getProvider, normalizeBaseUrl, PROVIDERS } from '@/shared/api-config';
import { WEB_ORIGINS } from '@/platform/settings';
import '@/ui/app.css';

function Options() {
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [provider, setProvider] = useState<ProviderId>('deepseek');
  const [baseUrl, setBaseUrl] = useState(getProvider('deepseek').baseUrl);
  const [jsonMode, setJsonMode] = useState(true);
  const [profiles, setProfiles] = useState<ConnectionSettings['profiles']>({});
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
  const apply = (settings: ConnectionSettings) => {
    setModel(settings.model); setEnabled(settings.enabled); setIncludeContext(settings.includeContext);
    setHasApiKey(settings.hasApiKey); setWebAccess(settings.webAccess);
    setProvider(settings.provider); setBaseUrl(settings.baseUrl); setJsonMode(settings.jsonMode); setProfiles(settings.profiles);
  };
  useEffect(() => {
    void browser.runtime.sendMessage({ type: 'get-connection-settings' }).then((settings: ConnectionSettings) => {
      if (!settings?.profiles) throw new Error('设置不可用');
      apply(settings); setReady(true);
    }).catch(() => setError('读取设置失败，请重新加载扩展。'));
  }, []);
  const preset = getProvider(provider);
  const savedProfile = profiles[provider];
  let keepsKey = false;
  try { keepsKey = hasApiKey && !removeKey && normalizeBaseUrl(baseUrl) === savedProfile?.baseUrl; } catch { /* Invalid address is explained on save. */ }
  function selectProvider(id: ProviderId) {
    const next = profiles[id] ?? { ...getProvider(id), hasApiKey: false };
    setProvider(id); setModel(next.model); setBaseUrl(next.baseUrl); setJsonMode(next.jsonMode);
    setHasApiKey(next.hasApiKey); setApiKey(''); setRemoveKey(false); setError('');
    setNotice('已载入此服务的配置；点击保存设置后切换。未保存的输入不会保留。');
  }
  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setNotice(''); setError('');
    try {
      const normalizedUrl = normalizeBaseUrl(baseUrl);
      if (!model.trim()) throw new Error('请填写服务支持的模型名称。');
      if (preset.requiresApiKey && !apiKey.trim() && !keepsKey && !removeKey) throw new Error('请填写此 API 地址的 API Key。');
      // Request from the submit gesture, before awaiting any other operation.
      const granted = removeKey || !enabled || await browser.permissions.request({ origins: [apiOriginPattern(normalizedUrl)] });
      if (!granted) throw new Error('未获得此 API 地址的访问权限，设置尚未保存。');
      const result = await browser.runtime.sendMessage({ type: 'save-settings', settings: { provider, baseUrl: normalizedUrl, jsonMode, model, apiKey, enabled, includeContext }, keepExistingKey: !removeKey });
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
    <section className="panel"><h2>1. 连接模型 API</h2>
      <form onSubmit={save}><fieldset disabled={busy || !ready}>
        <div className="field"><label htmlFor="provider">API 服务商</label><select id="provider" value={provider} onChange={event => selectProvider(event.target.value as ProviderId)}>{PROVIDERS.map(value => <option key={value.id} value={value.id}>{value.label}</option>)}</select>
          <div className="muted">每个服务分别记忆模型、地址与 Key。支持 OpenAI Chat Completions 兼容接口；Claude 可通过 OpenRouter 或兼容网关使用。</div></div>
        <div className="field"><label htmlFor="baseUrl">API Base URL</label><input id="baseUrl" type="url" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} required maxLength={2048} placeholder="https://your-api.example/v1" />
          <div className="muted">填写服务提供的 API 基址（保留 /v1 等路径），也可粘贴完整 /chat/completions 地址。保存时授权此 API 域名；更换地址后请重新填写 Key。本机服务支持 HTTP。</div></div>
        <div className="field"><label htmlFor="apiKey">{preset.label} API Key</label><input id="apiKey" type="password" autoComplete="off" value={apiKey} onChange={event => { setApiKey(event.target.value); setRemoveKey(false); }} placeholder={keepsKey ? '已保存；留空保留现有 Key' : preset.requiresApiKey ? '填写此服务的 API Key' : '可留空（无鉴权的本地或自建服务）'} />
          <div className="muted">Key 保存在本机扩展存储中，不同步。翻译内容发送到上方配置的 API 地址，按服务商规则计费。{preset.docsUrl && <a href={preset.docsUrl} target="_blank" rel="noreferrer">查看服务文档</a>}</div>
          {hasApiKey && <button type="button" onClick={() => { setRemoveKey(true); setApiKey(''); setNotice('点击保存后将删除已有 Key。'); }}>删除已保存的 Key</button>}
        </div>
        <div className="field"><label htmlFor="model">模型名</label><input id="model" type="text" value={model} onChange={event => setModel(event.target.value)} required maxLength={200} placeholder="填写你有权访问的模型 ID" /><div className="muted">按服务文档填写完整模型 ID；聚合服务可能包含厂商前缀，本地模型须已下载。DeepSeek 默认 deepseek-flash，关闭思考。</div></div>
        <label className="check"><input type="checkbox" checked={jsonMode} onChange={event => setJsonMode(event.target.checked)} />JSON 模式</label>
        <p className="muted">仅对词典请求启用 JSON 输出约束。服务不支持 response_format 时请关闭；关闭后仍会校验结果格式。</p>
        <label className="check"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />启用翻译</label>
        <label className="check"><input type="checkbox" checked={includeContext} onChange={event => setIncludeContext(event.target.checked)} />附带所在句或附近一句上下文，提高词义判断准确度</label>
        <p className="muted">额外上下文最多 600 字符，只在你点击翻译时发送；只翻译选中内容，保持术语、数字和代码标识符。</p>
        <div className="actions"><button className="primary" disabled={busy || !ready} type="submit">{busy ? '正在保存…' : '保存设置'}</button><span className="muted">{keepsKey ? '✓ 已配置 Key' : preset.requiresApiKey ? '尚未配置 Key' : '支持无 Key 连接'}</span></div>
      </fieldset>
      </form>
    </section>
    <section className="panel"><h2>2. 启用网页划词</h2><p className="muted">自动在选区旁显示按钮，需要网页访问权限。双击英文单词或拖选句段，点击「译」查看结果。</p><button type="button" className="primary" onClick={() => void grantAccess()} disabled={webAccess}>{webAccess ? '✓ 网页权限已启用' : '启用网页划词'}</button><p className="muted">浏览器设置页和内置 PDF 页无法直接显示按钮。PDF 请从工具栏打开近译阅读器。</p></section>
    <section className="panel"><h2>3. 翻译 PDF</h2><p className="muted">在线 PDF：在 PDF 标签页点击扩展图标，再点击「用阅读器打开当前 PDF」。本地 PDF：进入阅读器后选择文件。支持可选择文字的文档。</p><button onClick={() => void browser.tabs.create({ url: browser.runtime.getURL('/reader.html') })}>打开 PDF 阅读器</button></section>
    <div role="status" className="status success">{notice}</div>{error && <div role="alert" className="status notice error">{error}</div>}
  </main>;
}

createRoot(document.getElementById('root')!).render(<Options />);
