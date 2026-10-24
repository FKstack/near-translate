import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { browser } from './browser';
import { GUIDE_URL, isSettingsPage } from './locations';
import type { ConnectionSettings, EditableSettings, ProviderId } from '../shared/contracts';
import { getProvider, isProviderId, normalizeBaseUrl, PROVIDERS } from '../shared/api-config';
import { LANGUAGES, type SourceLanguage, type TargetLanguage } from '../shared/languages';

interface Reply { ok?: boolean; settings?: ConnectionSettings; error?: string }
async function request<T>(message: Record<string, unknown>): Promise<T> {
  return await browser.runtime.sendMessage(message) as T;
}

function draftOf(settings: ConnectionSettings): EditableSettings {
  return {
    translationEngine: settings.translationEngine ?? 'deepl-web', enabled: settings.enabled,
    includeContext: settings.includeContext, sentenceAnalysisEnabled: settings.sentenceAnalysisEnabled,
    sourceLanguage: settings.sourceLanguage ?? 'auto', targetLanguage: settings.targetLanguage ?? 'zh-Hans',
    provider: settings.provider, model: settings.model, baseUrl: settings.baseUrl,
    jsonMode: settings.jsonMode, apiKey: '',
  };
}

function Settings() {
  const [saved, setSaved] = useState<ConnectionSettings>();
  const [draft, setDraft] = useState<EditableSettings>();
  const [busy, setBusy] = useState(false);
  const [removeKey, setRemoveKey] = useState(false);
  const [legacyPassphrase, setLegacyPassphrase] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const savedRevision = useRef<number | undefined>(undefined);
  const apply = (settings: ConnectionSettings) => {
    savedRevision.current = settings.connectionRevision;
    setSaved(settings); setDraft(draftOf(settings)); setRemoveKey(false);
  };
  useEffect(() => {
    let active = true;
    let generation = 0;
    const refresh = (initial: boolean) => {
      const owner = ++generation;
      void request<ConnectionSettings>({ type: 'get-connection-settings' }).then(settings => {
        if (!settings?.profiles) throw new Error('读取配置失败，请重新加载此页。');
        if (!active || generation !== owner) return;
        const changed = !initial && savedRevision.current !== undefined && savedRevision.current !== settings.connectionRevision;
        savedRevision.current = settings.connectionRevision;
        setSaved(settings);
        // Never refill a saved Key into the form. Keep other unfinished edits
        // when another settings page changes the shared connection.
        setDraft(previous => initial || !previous ? draftOf(settings) : {
          ...previous, apiKey: '',
        });
        if (changed) {
          setLegacyPassphrase('');
          setNotice('设置已在另一页面更新。未保存的服务地址和模型名称仍保留。');
        }
      }).catch(() => { if (active && generation === owner) setError('读取配置失败，请重新加载此页。'); });
    };
    const onSettings = (message: unknown) => {
      if (message && typeof message === 'object' && (message as { type?: unknown }).type === 'settings-changed') refresh(false);
    };
    browser.runtime.onMessage.addListener(onSettings);
    refresh(true);
    return () => { active = false; generation++; browser.runtime.onMessage.removeListener(onSettings); };
  }, []);

  async function importLegacy(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(''); setNotice('');
    try {
      const reply = await request<Reply>({ type: 'import-legacy-keys', passphrase: legacyPassphrase });
      if (reply?.settings) setSaved(reply.settings);
      if (!reply?.ok || !reply.settings) throw new Error(reply?.error ?? '导入失败，旧版 Key 仍然保留。');
      savedRevision.current = reply.settings.connectionRevision;
      setSaved(reply.settings);
      setNotice('旧版 Key 已导入，返回网页即可翻译。以后不再需要口令。');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '导入失败，旧版 Key 仍然保留。'); }
    finally {
      setLegacyPassphrase('');
      setDraft(value => value ? { ...value, apiKey: '' } : value);
      setBusy(false);
    }
  }
  function selectProvider(provider: ProviderId) {
    if (!draft) return;
    const profile = saved?.profiles[provider] ?? getProvider(provider);
    setDraft({ ...draft, provider, baseUrl: profile.baseUrl, model: profile.model, jsonMode: profile.jsonMode, apiKey: '' });
    setRemoveKey(false); setNotice('点击保存设置后切换服务。'); setError('');
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const settings = { ...draft, ...(draft.translationEngine === 'model' ? { baseUrl: normalizeBaseUrl(draft.baseUrl) } : {}) };
      if (settings.translationEngine === 'model' && !settings.model.trim()) throw new Error('请填写服务支持的模型名称。');
      const reply = await request<Reply>({ type: 'save-settings', settings, keepExistingKey: !removeKey });
      if (!reply?.ok || !reply.settings) throw new Error(reply?.error ?? '保存设置失败，请重试。');
      apply(reply.settings);
      setNotice('设置已保存，返回网页即可翻译。');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '保存设置失败。'); }
    finally { setDraft(value => value ? { ...value, apiKey: '' } : value); setBusy(false); }
  }

  const modelMode = draft?.translationEngine === 'model';
  const profile = draft ? saved?.profiles[draft.provider] : undefined;
  const preset = draft ? getProvider(draft.provider) : undefined;
  let keepsKey = false;
  try { keepsKey = !removeKey && profile?.hasApiKey === true && !!draft && normalizeBaseUrl(draft.baseUrl) === profile.baseUrl; } catch { /* Explained when saving. */ }

  return <main>
    <header><p className="eyebrow">近译 · 篡改猴版</p><h1>阅读与翻译设置</h1>
      <p>网页双语、划词和阅读模式。阅读模式无需 Key，按 <kbd>Alt</kbd> + <kbd>Shift</kbd> + <kbd>R</kbd> 打开。</p>
      <a href={GUIDE_URL} target="_blank" rel="noreferrer">安装与使用说明 ↗</a></header>
    <div role="status" className="notice">{notice}</div>
    {error && <p role="alert" className="error">{error}</p>}
    {!draft || !saved ? <p>正在读取本机配置…</p> : <>
      <section><h2>翻译服务</h2>
        <form onSubmit={save}><fieldset disabled={busy}>
          <label>翻译方式<select value={draft.translationEngine} onChange={event => { setDraft({ ...draft, translationEngine: event.target.value === 'model' ? 'model' : 'deepl-web', apiKey: '' }); setError(''); }}>
            <option value="deepl-web">DeepL 免费翻译（实验性，无需 Key）</option><option value="model">大模型 API</option>
          </select></label>
          <div className="pair"><label>源语言<select value={draft.sourceLanguage} onChange={event => setDraft({ ...draft, sourceLanguage: event.target.value as SourceLanguage })}>
            <option value="auto">自动识别</option>{LANGUAGES.map(language => <option key={language.code} value={language.code}>{language.label}</option>)}
          </select></label><label>目标语言<select value={draft.targetLanguage} onChange={event => setDraft({ ...draft, targetLanguage: event.target.value as TargetLanguage })}>
            {LANGUAGES.map(language => <option key={language.code} value={language.code}>{language.label}</option>)}
          </select></label></div>
          {modelMode ? <>
            <label>API 服务商<select value={draft.provider} onChange={event => { if (isProviderId(event.target.value)) selectProvider(event.target.value); }}>
              {PROVIDERS.map(provider => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
            </select></label>
            <label>API Base URL<input type="url" value={draft.baseUrl} required maxLength={2048} onChange={event => setDraft({ ...draft, baseUrl: event.target.value })} /></label>
            <p className="hint">通常无需修改。自定义服务请填写其兼容 API 地址。</p>
            <label>{preset?.label} API Key<input type="password" autoComplete="off" spellCheck={false} value={draft.apiKey}
              onChange={event => { setDraft({ ...draft, apiKey: event.target.value }); setRemoveKey(false); }}
              placeholder={keepsKey ? '已保存，留空保留' : preset?.requiresApiKey ? '填写 API Key' : '无鉴权接口可留空'} /></label>
            {(profile?.hasApiKey || saved.legacyKeyProviders?.includes(draft.provider)) && <label className="check"><input type="checkbox" checked={removeKey} onChange={event => { setRemoveKey(event.target.checked); setDraft({ ...draft, apiKey: '' }); }} />保存时删除此服务的 Key</label>}
            <label>模型名称<input value={draft.model} required maxLength={200} onChange={event => setDraft({ ...draft, model: event.target.value })} /></label>
            <label className="check"><input type="checkbox" checked={draft.jsonMode} onChange={event => setDraft({ ...draft, jsonMode: event.target.checked })} />词典和句子拆解使用 JSON 模式</label>
            <label className="check"><input type="checkbox" checked={draft.includeContext} onChange={event => setDraft({ ...draft, includeContext: event.target.checked })} />划词翻译附带附近一句上下文</label>
            <label className="check"><input type="checkbox" checked={draft.sentenceAnalysisEnabled} onChange={event => setDraft({ ...draft, sentenceAnalysisEnabled: event.target.checked })} />长句翻译后追加句子拆解（额外一次模型请求）</label>
          </> : <p className="hint">点击翻译时才把正文或选中文字发送至 DeepL。实验性免费服务可能限流或调整，遇到限制请稍后手动重试。词典解释和句子拆解需要模型 API。</p>}
          <label className="check"><input type="checkbox" checked={draft.enabled} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} />启用翻译</label>
          <button type="submit">{busy ? '正在处理…' : '保存设置'}</button>
        </fieldset></form>
      </section>
      {modelMode && <p className="hint">API Key 保存在篡改猴的本机存储中，保存后在各个网页直接使用。Key 只用于连接你配置的翻译服务。</p>}
      {saved.legacyKeyMigrationAvailable && <details><summary>导入旧版保存的 Key</summary>
        <p>旧版加密保存的 Key 可以用原口令导入一次，之后不再需要口令。也可以直接在上方重新填写 Key。</p>
        <form onSubmit={importLegacy}><fieldset disabled={busy}>
          <label>旧版口令<input type="password" autoComplete="off" value={legacyPassphrase} required minLength={12} maxLength={128} onChange={event => setLegacyPassphrase(event.target.value)} /></label>
          <button type="submit">导入旧版 Key</button>
        </fieldset></form>
      </details>}
    </>}
    <footer>本版支持网页阅读与翻译；PDF 和文档转换请继续使用扩展版。脚本更新由篡改猴按你的更新设置管理。</footer>
  </main>;
}

const styles = `
:host{display:block;color:#23332c;font:15px/1.7 system-ui,-apple-system,"Segoe UI",sans-serif;background:#f5f7f1;min-height:100vh;color-scheme:light;--border:#d9e2d8}
*{box-sizing:border-box}main{max-width:780px;margin:auto;padding:42px 22px 60px}header{margin-bottom:24px}h1{font-size:30px;line-height:1.3;margin:6px 0 16px}h2{font-size:20px;margin:0 0 20px}p{margin:10px 0}a{color:#236648}kbd{border:1px solid #bbcabc;border-radius:4px;padding:1px 5px;font-size:12px}.eyebrow{color:#52705b;font-size:13px;letter-spacing:2px}section{background:#fff;border:1px solid var(--border);border-radius:16px;padding:26px;margin:20px 0}label{display:block;margin:14px 0 8px;font-weight:550}input,select,button{font:inherit}input:not([type=checkbox]),select{display:block;width:100%;margin-top:6px;padding:10px 12px;border:1px solid #b7c7b7;border-radius:8px;background:white;color:#23332c}input:focus,select:focus{outline:2px solid #438263;outline-offset:2px}.check{display:flex;align-items:center;gap:9px;font-weight:400}.check input{width:17px;height:17px;accent-color:#286b4c}.pair{display:grid;grid-template-columns:1fr 1fr;gap:18px}button{cursor:pointer;border:1px solid #286b4c;background:#286b4c;color:white;padding:9px 20px;border-radius:8px;margin:16px 8px 0 0}button:disabled{opacity:.55;cursor:wait}.secondary{background:#fff;color:#286b4c}fieldset{border:0;margin:0;padding:0;min-width:0}.hint,footer{font-size:13px;color:#607168}.notice{color:#246346;white-space:pre-line}.error{padding:12px;color:#9f2b35;background:#fff0ef;border-radius:8px}.actions{display:flex;align-items:center;flex-wrap:wrap;gap:12px}.actions button{margin:0}@media(max-width:500px){main{padding:24px 12px}section{padding:18px}.pair{grid-template-columns:1fr;gap:0}h1{font-size:25px}}
`;

export function mountSettings(): () => void {
  if (!isSettingsPage(location.href)) throw new Error('请从近译的专用设置页配置服务。');
  const host = document.createElement('near-userscript-settings');
  host.setAttribute('data-near-page-ui', '');
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style'); style.textContent = styles;
  const container = document.createElement('div'); shadow.append(style, container);
  document.body.replaceChildren(host);
  const root = createRoot(container); root.render(<Settings />);
  return () => { root.unmount(); host.remove(); };
}
