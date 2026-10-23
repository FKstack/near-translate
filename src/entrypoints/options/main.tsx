import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { browser } from 'wxt/browser';
import { DEFAULT_MODEL, type ConnectionSettings, type ProviderId, type TranslationEngine } from '@/shared/contracts';
import { DEEPL_WEB_ORIGIN, DEEPL_WEB_PREPARATION_PERMISSION } from '@/shared/translation-engine';
import { apiOriginPattern, getProvider, normalizeBaseUrl, PROVIDERS } from '@/shared/api-config';
import { WEB_ORIGINS } from '@/platform/settings';
import { LANGUAGES, languageLabel, readLanguagePair, type SourceLanguage, type TargetLanguage } from '@/shared/languages';
import { FreeSetup } from '@/ui/free-setup/FreeSetup';
import { useFreeSetup } from '@/ui/free-setup/useFreeSetup';
import type { FreeSetupClient } from '@/ui/free-setup/client';
import type { KeyVaultStatus } from '@/shared/key-vault';
import { KeyVaultPanel } from '@/ui/key-vault/KeyVaultPanel';
import '@/ui/app.css';

const freeSetupClient: FreeSetupClient = {
  requestPermissions: () => browser.permissions.request({ origins: [...WEB_ORIGINS, DEEPL_WEB_ORIGIN] }),
  sendMessage: message => browser.runtime.sendMessage(message),
};

function Options() {
  const [translationEngine, setTranslationEngine] = useState<TranslationEngine>('deepl-web');
  const [sourceLanguage, setSourceLanguage] = useState<SourceLanguage>('auto');
  const [targetLanguage, setTargetLanguage] = useState<TargetLanguage>('zh-Hans');
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [provider, setProvider] = useState<ProviderId>('deepseek');
  const [baseUrl, setBaseUrl] = useState(getProvider('deepseek').baseUrl);
  const [jsonMode, setJsonMode] = useState(true);
  const [profiles, setProfiles] = useState<ConnectionSettings['profiles']>({});
  const [apiKey, setApiKey] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [includeContext, setIncludeContext] = useState(true);
  const [sentenceAnalysisEnabled, setSentenceAnalysisEnabled] = useState(true);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [webAccess, setWebAccess] = useState(false);
  const [networkPreparationAccess, setNetworkPreparationAccess] = useState(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [removeKey, setRemoveKey] = useState(false);
  const [freeReady, setFreeReady] = useState(false);
  const [vault, setVault] = useState<KeyVaultStatus>();
  const apply = (settings: ConnectionSettings) => {
    setTranslationEngine(settings.translationEngine ?? 'model');
    const languages = readLanguagePair(settings);
    setSourceLanguage(languages.sourceLanguage); setTargetLanguage(languages.targetLanguage);
    setFreeReady(settings.translationEngine === 'deepl-web' && settings.enabled && settings.webAccess && settings.apiAccess !== false);
    setModel(settings.model); setEnabled(settings.enabled); setIncludeContext(settings.includeContext);
    setSentenceAnalysisEnabled(settings.sentenceAnalysisEnabled);
    setHasApiKey(settings.hasApiKey); setWebAccess(settings.webAccess);
    setNetworkPreparationAccess(settings.networkPreparationAccess === true);
    setProvider(settings.provider); setBaseUrl(settings.baseUrl); setJsonMode(settings.jsonMode); setProfiles(settings.profiles);
    setVault(settings.vault);
  };
  const freeSetup = useFreeSetup(freeSetupClient, settings => {
    apply(settings); setApiKey(''); setRemoveKey(false); setError('');
    setNotice('免费翻译已启用。切回原文章继续阅读，点击“翻译正文”才开始翻译。');
  });
  useEffect(() => {
    void browser.runtime.sendMessage({ type: 'get-connection-settings' }).then((settings: ConnectionSettings) => {
      if (!settings?.profiles) throw new Error('设置不可用');
      apply(settings); setReady(true);
    }).catch(() => setError('读取设置失败，请重新加载扩展。'));
  }, []);
  const preset = getProvider(provider);
  const usesDeepL = translationEngine === 'deepl-web';
  const savedProfile = profiles[provider];
  const vaultUnavailable = !vault?.configured || vault.locked || vault.migrationRequired;
  const profileHasSavedKey = hasApiKey || savedProfile?.hasApiKey === true;
  async function changeNetworkPreparation() {
    setError(''); setNotice(''); setBusy(true);
    try {
      const granted = networkPreparationAccess
        ? await browser.permissions.remove({ permissions: [DEEPL_WEB_PREPARATION_PERMISSION] })
        : await browser.permissions.request({ permissions: [DEEPL_WEB_PREPARATION_PERMISSION] });
      if (!granted) { setNotice('连接加速权限未更改，普通翻译仍可使用。'); return; }
      await browser.runtime.sendMessage({ type: 'refresh-permissions' });
      setNetworkPreparationAccess(await browser.permissions.contains({ permissions: [DEEPL_WEB_PREPARATION_PERMISSION] }));
      setNotice(networkPreparationAccess ? '连接加速已关闭。' : '连接加速已启用，新打开的网页生效。');
    } catch { setError('连接加速权限更改失败，普通翻译仍可使用。'); }
    finally { setBusy(false); }
  }
  let keepsKey = false;
  try { keepsKey = profileHasSavedKey && !removeKey && normalizeBaseUrl(baseUrl) === savedProfile?.baseUrl; } catch { /* Invalid address is explained on save. */ }
  function selectProvider(id: ProviderId) {
    const next = profiles[id] ?? { ...getProvider(id), hasApiKey: false };
    setProvider(id); setModel(next.model); setBaseUrl(next.baseUrl); setJsonMode(next.jsonMode);
    setHasApiKey(next.hasApiKey); setApiKey(''); setRemoveKey(false); setError('');
    setNotice('已载入此服务的配置；点击保存设置后切换。未保存的输入不会保留。');
  }
  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setNotice(''); setError('');
    try {
      const normalizedUrl = usesDeepL ? baseUrl : normalizeBaseUrl(baseUrl);
      if (!usesDeepL && !model.trim()) throw new Error('请填写服务支持的模型名称。');
      if (!usesDeepL && vaultUnavailable && (apiKey || removeKey || (profileHasSavedKey && normalizedUrl !== savedProfile?.baseUrl))) throw new Error(vault?.configured ? '请先解锁密钥库，再新增、删除 Key 或更换已有 Key 的 API 地址。' : '请先设置密钥库口令，再保存 API Key。');
      if (!usesDeepL && vaultUnavailable && preset.requiresApiKey && !keepsKey && !removeKey) throw new Error(vault?.configured ? '请先解锁密钥库，再配置此服务的 API Key。' : '请先设置密钥库口令，再配置此服务的 API Key。');
      if (!usesDeepL && preset.requiresApiKey && !apiKey.trim() && !keepsKey && !removeKey) throw new Error('请填写此 API 地址的 API Key。');
      // Request from the submit gesture, before awaiting any other operation.
      const granted = (!usesDeepL && removeKey) || !enabled || await browser.permissions.request(usesDeepL
        ? { origins: [DEEPL_WEB_ORIGIN] }
        : { origins: [apiOriginPattern(normalizedUrl)] });
      if (!granted) throw new Error(usesDeepL ? '未获得 DeepL 翻译服务的访问权限，设置尚未保存。' : '未获得此 API 地址的访问权限，设置尚未保存。');
      const result = await browser.runtime.sendMessage({ type: 'save-settings', settings: { translationEngine, provider, baseUrl: normalizedUrl, jsonMode, model, apiKey, enabled, includeContext, sentenceAnalysisEnabled, sourceLanguage, targetLanguage }, keepExistingKey: usesDeepL || !removeKey });
      if (!result?.ok) throw new Error(result?.error ?? '保存失败，请重试。');
      apply(result.settings); setApiKey(''); setRemoveKey(false); setNotice('设置已保存。已打开的网页如未出现按钮，请刷新一次。');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '保存失败。'); }
    finally { setBusy(false); }
  }
  async function grantAccess() {
    setError(''); setNotice(''); setBusy(true);
    try {
      const granted = await browser.permissions.request({ origins: WEB_ORIGINS });
      if (!granted) { setNotice('网页访问权限尚未启用，你仍可使用 PDF 阅读器。'); return; }
      const settings = await browser.runtime.sendMessage({ type: 'refresh-permissions' });
      if (typeof settings?.webAccess !== 'boolean') throw new Error('权限已授予，但网页启用失败，请重试。');
      setWebAccess(settings.webAccess);
      setFreeReady(settings.translationEngine === 'deepl-web' && settings.enabled && settings.webAccess && settings.apiAccess !== false);
      setNotice('网页翻译已启用。请刷新之前打开的网页，点击右侧双叶按钮翻译整页，或选择文字后翻译。');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '授权失败。'); }
    finally { setBusy(false); }
  }
  return <main className="page">
    <header className="page-header"><div className="brand"><img className="brand-mark" src="/brand/near-translate.svg" alt="" /><div><p className="brand-caption">近译 · 阅读与翻译</p><h1>翻译设置</h1></div></div><p className="muted page-intro">阅读模式可从扩展菜单或网页侧栏直接打开，无需 Key。<br />需要翻译时，网页与 PDF 共用这里的服务设置。</p></header>
    <FreeSetup ready={ready && !busy} enabled={freeReady} {...freeSetup} onEnable={() => { setError(''); setNotice(''); freeSetup.enable(); }} onTest={() => { setError(''); setNotice(''); freeSetup.test(); }}/>
    <div className="settings-layout">
    <section className="panel settings-main" aria-labelledby="service-heading"><div className="section-heading"><span className="section-step" aria-hidden="true">01</span><div><h2 id="service-heading">选择翻译服务</h2><p className="muted">连接常用服务，再调整你的阅读偏好。</p></div></div>
      {(!usesDeepL || vault?.configured || vault?.migrationRequired) && <KeyVaultPanel status={vault} disabled={!ready || busy || freeSetup.enabling || freeSetup.testing}
        sendMessage={message => browser.runtime.sendMessage(message)} onBusyChange={setBusy} onChanged={settings => { setVault(settings.vault); setProfiles(settings.profiles); setHasApiKey(settings.profiles[provider]?.hasApiKey === true); setApiKey(''); setRemoveKey(false); setError(''); setNotice(''); }} />}
      <form onSubmit={save}><fieldset disabled={busy || freeSetup.enabling || freeSetup.testing || !ready}>
        <div className="field"><label htmlFor="translationEngine">翻译方式</label><select id="translationEngine" value={translationEngine} onChange={event => { setTranslationEngine(event.target.value as TranslationEngine); setError(''); setNotice('点击保存设置后切换翻译方式。'); }}>
          <option value="deepl-web">DeepL 免费翻译（实验性，无需登录或 Key）</option><option value="model">大模型 API</option>
        </select></div>
        <div className="language-pair" role="group" aria-label="翻译语言">
          <div className="field"><label htmlFor="sourceLanguage">源语言</label><select id="sourceLanguage" value={sourceLanguage} onChange={event => setSourceLanguage(event.target.value as SourceLanguage)}>
            <option value="auto">自动识别</option>{LANGUAGES.map(language => <option key={language.code} value={language.code}>{language.label}</option>)}
          </select></div>
          <span className="language-direction" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12h16m-6-6 6 6-6 6"/></svg></span>
          <div className="field"><label htmlFor="targetLanguage">目标语言</label><select id="targetLanguage" value={targetLanguage} onChange={event => setTargetLanguage(event.target.value as TargetLanguage)}>
            {LANGUAGES.map(language => <option key={language.code} value={language.code}>{language.label}</option>)}
          </select></div>
        </div>
        <p className="muted language-pair-note">网页、阅读模式与 PDF 共用已保存的语言设置。更改语言后需点击“保存设置”。{sourceLanguage === targetLanguage && '源语言与目标语言相同，将跳过同语言正文。'}</p>
        {usesDeepL ? <div className="notice"><p>无需登录或 API Key。保存时仅授权 DeepL 翻译服务域名；点击翻译后，选中的文字或网页正文会发送到该服务。</p><p>支持整页、划词和 PDF 选文翻译；当前译为{languageLabel(targetLanguage)}。免费服务可能限流或调整，遇到限流会停止，请稍后手动重试。词典解释和长难句拆解请使用大模型 API。</p><details className="connection-details" open><summary>可选连接加速</summary><p>启用后，新打开的前台网页会提前联系 DeepL，只准备连接，不发送正文、网页地址或登录凭证；扩展各标签共享至少 30 秒的准备调度间隔。已有网络规则权限时会显示为已启用，可随时关闭。</p><button type="button" disabled={busy || !ready} onClick={() => void changeNetworkPreparation()}>{networkPreparationAccess ? '关闭连接加速' : '启用连接加速（可选）'}</button></details></div> : <>
        <div className="field"><label htmlFor="provider">API 服务商</label><select id="provider" value={provider} onChange={event => selectProvider(event.target.value as ProviderId)}>{PROVIDERS.map(value => <option key={value.id} value={value.id}>{value.label}</option>)}</select>
          <div className="muted">每个服务分别记忆模型、地址与 Key。支持 OpenAI Chat Completions 兼容接口；Claude 可通过 OpenRouter 或兼容网关使用。</div></div>
        <div className="field"><label htmlFor="baseUrl">API Base URL</label><input id="baseUrl" type="url" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} required maxLength={2048} placeholder="https://your-api.example/v1" />
          <div className="muted">填写服务提供的 API 基址（保留 /v1 等路径），也可粘贴完整 /chat/completions 地址。保存时授权此 API 域名；更换地址后请重新填写 Key。本机服务支持 HTTP。</div></div>
        <div className="field"><label htmlFor="apiKey">{preset.label} API Key</label><input id="apiKey" type="password" autoComplete="off" disabled={vaultUnavailable} value={apiKey} onChange={event => { setApiKey(event.target.value); setRemoveKey(false); }} placeholder={vaultUnavailable ? vault?.configured ? '先在上方解锁密钥库' : '先在上方设置密钥库口令' : keepsKey ? '已加密保存；留空保留现有 Key' : preset.requiresApiKey ? '填写此服务的 API Key' : '可留空（无鉴权的本地或自建服务）'} />
          <div className="muted">Key 使用口令加密后保存在本机，不同步；口令不会发送给服务商。翻译内容及鉴权 Key 发送到上方配置的 API 地址，按服务商规则计费。{preset.docsUrl && <a href={preset.docsUrl} target="_blank" rel="noreferrer">查看服务文档</a>}</div>
          {profileHasSavedKey && <button type="button" disabled={vaultUnavailable} onClick={() => { setRemoveKey(true); setApiKey(''); setNotice('点击保存后将删除已有 Key。'); }}>删除已保存的 Key</button>}
        </div>
        <div className="field"><label htmlFor="model">模型名</label><input id="model" type="text" value={model} onChange={event => setModel(event.target.value)} required maxLength={200} placeholder="填写你有权访问的模型 ID" /><div className="muted">按服务文档填写完整模型 ID；聚合服务可能包含厂商前缀，本地模型须已下载。DeepSeek 默认 deepseek-flash，关闭思考。</div></div>
        <label className="check"><input type="checkbox" checked={jsonMode} onChange={event => setJsonMode(event.target.checked)} />JSON 模式</label>
        <p className="muted">仅对词典和长难句拆解请求启用 JSON 输出约束。服务不支持 response_format 时请关闭；关闭后仍会校验结果格式。</p>
        </>}
        <div className="preference-group"><h3>阅读偏好</h3>
        <label className="check"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />启用翻译</label>
        {!usesDeepL && <>
        <label className="check"><input type="checkbox" checked={includeContext} onChange={event => setIncludeContext(event.target.checked)} />附带所在句或附近一句上下文，提高词义判断准确度</label>
        <label className="check"><input type="checkbox" checked={sentenceAnalysisEnabled} onChange={event => setSentenceAnalysisEnabled(event.target.checked)} />长难句拆解</label>
        <p className="muted">选中单个英文长句翻译后，展示句子主干、分块阅读和阅读顺序，并用不同颜色标出主语、谓语、宾语和从句，在卡片原句中高亮对照。关闭此项会同时关闭拆解和所有彩色标注。译文先显示，拆解随后补充，会额外调用一次当前模型；彩色对照不增加请求。单词和整页翻译不触发，多句内容请分句选择。</p>
        </>}
        <p className="muted">整页翻译按所选语言逐段处理正文，代码块、图片与输入区域会跳过。仅点击翻译后发送正文。{!usesDeepL && '划词额外上下文最多 600 字符。'}</p>
        </div>
        <div className="actions form-footer"><button className="primary" disabled={busy || !ready} type="submit">{busy ? '正在保存…' : '保存设置'}</button><span className="muted key-state">{usesDeepL ? '无需登录或 Key' : vaultUnavailable && profileHasSavedKey ? vault?.migrationRequired ? '已有 Key · 需加密迁移' : '已加密保存 · 待解锁' : keepsKey ? '✓ 已配置 Key' : preset.requiresApiKey ? '尚未配置 Key' : '支持无 Key 连接'}</span></div>
      </fieldset>
      </form>
      <div role="status" className="status success">{notice}</div>{error && <div role="alert" className="status notice error">{error}</div>}
    </section>
    <aside className="settings-side" aria-label="网页与 PDF 使用入口">
    <section className="panel support-panel" aria-labelledby="web-heading"><div className="section-heading"><span className="section-step" aria-hidden="true">02</span><h2 id="web-heading">网页访问权限</h2></div><p className="muted">免费入门按钮会同时申请此权限。使用大模型时，也可在这里单独启用整页、阅读正文和划词翻译。</p><button type="button" className={webAccess ? 'access-granted' : 'primary'} onClick={() => void grantAccess()} disabled={webAccess || busy || freeSetup.enabling || freeSetup.testing}>{webAccess ? '✓ 网页权限已启用' : '启用网页划词'}</button><p className="muted support-note">此权限用于网页翻译；本地阅读无需启用。代码块与图片保持原样，不做图片 OCR。</p></section>
    <section className="panel support-panel" aria-labelledby="pdf-heading"><div className="section-heading"><span className="section-step" aria-hidden="true">03</span><h2 id="pdf-heading">翻译 PDF</h2></div><p className="muted">在线 PDF：点击扩展图标，选择「用阅读器打开当前 PDF」。本地文档可在阅读器中选择文件。</p><p className="muted support-note">支持可选择文字的 PDF 文档。</p><button type="button" onClick={() => void browser.tabs.create({ url: browser.runtime.getURL('/reader.html') })}>打开 PDF 阅读器 <span aria-hidden="true">↗</span></button></section>
    </aside>
    </div>
  </main>;
}

createRoot(document.getElementById('root')!).render(<Options />);
