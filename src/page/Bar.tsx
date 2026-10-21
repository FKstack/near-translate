import type { PageSessionState } from './session';

const gear = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m9 3-.7 2.3-2.2 1L4 5.8 2.5 8.5 4 10.3v3.4l-1.5 1.8L4 18.2l2.1-.5 2.2 1L9 21h6l.7-2.3 2.2-1 2.1.5 1.5-2.7-1.5-1.8v-3.4l1.5-1.8L20 5.8l-2.1.5-2.2-1L15 3Z"/><circle cx="12" cy="12" r="3.2"/></svg>;
const documentIcon = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6M8 13h8M8 17h6"/></svg>;

export interface PageBarProps {
  state: PageSessionState;
  notice?: string;
  hasTranslations: boolean;
  onTranslate: () => void;
  onStop: () => void;
  onRestore: () => void;
  onRetry: () => void;
  onSettings: () => void;
}

export function PageBar(props: PageBarProps) {
  const { state } = props;
  const running = state.status === 'running';
  const restoreOriginal = !running && state.completed > 0;
  const primaryLabel = running ? '停止翻译' : restoreOriginal ? '恢复原文' : '翻译整个页面';
  const primaryAction = running ? props.onStop : restoreOriginal ? props.onRestore : props.onTranslate;
  const label = props.notice || state.error?.message || (running
    ? `正在翻译 ${state.completed} / ${state.total}`
    : state.status === 'done' ? `翻译完成 · ${state.completed} / ${state.total}`
    : state.status === 'stopped' ? `已停止 · 已翻译 ${state.completed} / ${state.total}` : '点击翻译页面');
  return <aside className="np-bar" aria-label="近译整页翻译">
    <div className="np-tools">
      <button type="button" aria-label="翻译设置" title="翻译设置" onClick={props.onSettings}>{gear}</button>
      <button type="button" aria-label="显示原文" title="显示原文" disabled={!props.hasTranslations && !running} onClick={props.onRestore}>{documentIcon}</button>
    </div>
    <button type="button" className={`np-primary${running ? ' np-running' : ''}`} aria-label={primaryLabel} title={primaryLabel} aria-pressed={state.completed > 0} onClick={primaryAction}>
      {running ? <span className="np-stop"/> : <span aria-hidden="true" className="np-symbol">文<span>A</span></span>}
    </button>
    <div className={`np-info${state.status === 'idle' && !props.notice ? ' np-idle' : ''}`}>
      <div role="status" aria-live="polite">{label}</div>
      {state.failed > 0 && !running && <button type="button" className="np-retry" onClick={props.onRetry}>重试失败段落</button>}
      {state.limitReached && <small>页面内容较多，已达到本次翻译上限。</small>}
      {state.skipped > 0 && !running && <small>已跳过 {state.skipped} 个发生变化的段落。</small>}
    </div>
  </aside>;
}

export const pageBarStyles = `
:host{all:initial!important;color-scheme:light!important}
*{box-sizing:border-box}
.np-bar{position:fixed;right:0;top:50%;transform:translateY(-50%);display:flex;flex-direction:column;align-items:flex-end;gap:9px;font:13px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;pointer-events:auto;color:#16373c;isolation:isolate}
.np-tools{display:flex;flex-direction:column;gap:1px;background:#fff;border:1px solid #d9e8e9;border-right:0;border-radius:22px 0 0 22px;padding:9px 8px;box-shadow:0 3px 16px #001e2922}
button{appearance:none;cursor:pointer;font:inherit;border:0;display:grid;place-items:center;-webkit-tap-highlight-color:transparent}
.np-tools button{width:29px;height:30px;background:transparent;color:#16373c;border-radius:8px}
.np-tools button:hover{background:#e6f7f7;color:#007d87}.np-tools button:disabled{opacity:.35;cursor:default}.np-tools svg{width:20px;height:20px}
button:focus-visible{outline:3px solid #097bff;outline-offset:3px}
.np-primary{width:53px;height:47px;border-radius:26px 0 0 26px;background:#00b9c6;color:#fff;box-shadow:0 3px 14px #00283326;transition:width .15s,background .15s}
.np-primary:hover{width:59px;background:#009eab}.np-symbol{font-size:21px;font-weight:700;line-height:1;letter-spacing:-3px}.np-symbol span{font-size:21px;position:relative;top:6px;left:-1px}.np-stop{height:14px;width:14px;background:currentColor;border-radius:3px}
.np-info{position:absolute;right:65px;bottom:0;min-width:145px;max-width:min(280px,calc(100vw - 90px));background:#18363deb;color:#fff;border:1px solid #ffffff25;border-radius:11px;padding:10px 13px;box-shadow:0 3px 16px #001e2922;text-align:left;backdrop-filter:blur(8px)}
.np-info.np-idle{opacity:0;transform:translateX(5px);pointer-events:none;transition:opacity .15s,transform .15s}.np-bar:hover .np-idle,.np-bar:focus-within .np-idle{opacity:1;transform:none}
.np-info small{display:block;opacity:.75;margin-top:4px;font-size:11px}.np-retry{display:block;background:transparent;color:#6ee9ee;padding:5px 0 0;text-align:left;text-decoration:underline}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}
@media print{:host{display:none!important}}
`;
