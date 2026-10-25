import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import type { PageSessionState } from './session';
import type { TranslationServiceStatus } from '../shared/contracts';
import { RecoveryAction, useTranslationRecovery } from '../ui/translation/RecoveryAction';

const barSize = 40;
const edge = 8;
const viewportSize = () => typeof window === 'undefined' ? { width: 1024, height: 768 } : { width: document.documentElement.clientWidth || window.innerWidth, height: document.documentElement.clientHeight || window.innerHeight };
const bounded = (value: number, maximum: number) => Math.max(edge, Math.min(value, maximum - barSize - edge));

const settingsIcon = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M4 7h6m4 0h6M4 17h10m4 0h2"/><circle cx="12" cy="7" r="2"/><circle cx="16" cy="17" r="2"/></svg>;
const readingIcon = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 6C9.2 4.2 5.7 3.8 2.5 4.7v14c3.2-.9 6.7-.5 9.5 1.3 2.8-1.8 6.3-2.2 9.5-1.3v-14c-3.2-.9-6.7-.5-9.5 1.3ZM12 6v14M6 10h3m6 0h3"/></svg>;
const restoreOriginalIcon = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 9V4a1 1 0 0 1 1-1h7l4 4v13a1 1 0 0 1-1 1H9M16 3v5h4M11 11h5"/><path d="m6 11-4 4 4 4M2 15h9a3 3 0 0 0 3-3"/></svg>;
const leafMark = <svg viewBox="0 0 128 128" fill="none" aria-hidden="true"><path fill="#087F83" d="M14 90C21 82 22 78 19 72C9 53 16 34 34 26C54 17 74 25 94 17C99 44 84 62 60 68C45 72 39 77 31 85C26 90 19 93 14 93C12 93 12 92 14 90Z"/><path fill="#66CC9E" d="M44 82C55 72 76 73 92 59C99 53 103 47 106 40C118 55 119 75 111 90C108 95 103 98 102 100C102 103 106 107 108 109C109 111 103 110 99 108L93 105C81 111 58 112 46 104C37 98 37 89 44 82Z"/></svg>;

export interface PageBarProps {
  state: PageSessionState;
  notice?: string;
  hasTranslations: boolean;
  onTranslate: () => void;
  onStop: () => void;
  onRestore: () => void;
  onRetry: () => void;
  onContinue?: () => void;
  onSettings: () => void;
  onRead?: () => void;
  serviceStatus?: TranslationServiceStatus;
}

export function PageBar(props: PageBarProps) {
  const [viewport, setViewport] = useState(viewportSize);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [quiet, setQuiet] = useState(false);
  const primary = useRef<HTMLButtonElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number; moved: boolean } | null>(null);
  const ignoreClick = useRef(false);
  const left = bounded(position?.left ?? viewport.width - barSize - edge, viewport.width);
  const top = bounded(position?.top ?? (viewport.height - barSize) / 2, viewport.height);
  const opensRight = left + barSize / 2 < viewport.width / 2;
  const opensUp = viewport.height - top - barSize - edge < 104 && top > (viewport.height - barSize) / 2;
  const tipUp = top + barSize / 2 > viewport.height / 2;
  const style = {
    left: position ? `clamp(${edge}px, ${left}px, calc(100% - ${barSize + edge}px))` : 'auto',
    right: position ? 'auto' : edge,
    top,
    '--np-info-width': `${Math.max(48, opensRight ? viewport.width - left - barSize - 6 - edge : left - 6 - edge)}px`,
    '--np-info-height': `${Math.max(40, tipUp ? top + barSize - edge : viewport.height - top - edge)}px`,
    '--np-tools-height': `${Math.max(32, opensUp ? top - edge : viewport.height - top - barSize - edge)}px`,
  } as CSSProperties;

  useEffect(() => {
    const resize = () => setViewport(viewportSize());
    window.addEventListener('resize', resize);
    const button = primary.current;
    return () => {
      window.removeEventListener('resize', resize);
      const current = drag.current;
      drag.current = null;
      if (current && button?.hasPointerCapture(current.id)) button.releasePointerCapture(current.id);
    };
  }, []);

  function startDrag(event: PointerEvent<HTMLButtonElement>) {
    if (!event.isPrimary || event.button !== 0) return;
    ignoreClick.current = false;
    const bounds = event.currentTarget.parentElement!.getBoundingClientRect();
    setViewport(viewportSize());
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: bounds.left, top: bounds.top, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function moveDrag(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    const dx = event.clientX - current.x, dy = event.clientY - current.y;
    if (!current.moved && Math.hypot(dx, dy) < 6) return;
    current.moved = true;
    setDragging(true);
    setPosition({ left: bounded(current.left + dx, viewport.width), top: bounded(current.top + dy, viewport.height) });
  }
  function finishDrag(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    drag.current = null;
    ignoreClick.current = current.moved;
    setDragging(false);
    setQuiet(current.moved);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function moveWithKeyboard(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') {
      setQuiet(true);
      primary.current?.focus();
      return;
    }
    if (!event.altKey || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? 40 : 12;
    setPosition({
      left: bounded(left + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0), viewport.width),
      top: bounded(top + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0), viewport.height),
    });
  }
  const { state } = props;
  const recovery = useTranslationRecovery(state.error, props.serviceStatus);
  const running = state.status === 'running';
  const continuing = state.status === 'stopped' && !state.error && state.failed === 0 && state.pending > 0;
  const retry = !running && (state.failed > 0 || continuing || Boolean(state.error && recovery.action === 'retry'))
    && (!state.error || recovery.action === 'retry');
  const restoreOriginal = !running && state.completed > 0;
  const primaryLabel = running ? '停止翻译' : restoreOriginal ? '恢复原文' : '翻译整个页面';
  const primaryAction = running ? props.onStop : restoreOriginal ? props.onRestore : props.onTranslate;
  const label = recovery.blocked ? [props.notice, recovery.message].filter(Boolean).join(' ') : props.notice || recovery.message || (running
    ? `正在翻译 ${state.completed} / ${state.total}`
    : state.status === 'done' ? `翻译完成 · ${state.completed} / ${state.total}`
    : state.status === 'stopped' ? `已停止 · 已翻译 ${state.completed} / ${state.total}` : '点击翻译页面');
  return <aside className="np-bar" aria-label="近译整页翻译" style={style}
    data-side={opensRight ? 'right' : 'left'} data-tools-up={opensUp} data-tip-up={tipUp}
    data-dragging={dragging} data-quiet={quiet} data-attention={Boolean(props.notice || state.error || state.failed > 0 || recovery.blocked)}
    onPointerEnter={() => { if (!drag.current) setQuiet(false); }}
    onPointerLeave={() => { if (!drag.current) setQuiet(false); }}
    onFocusCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setQuiet(false); }}
    onKeyDown={moveWithKeyboard}
    data-status={state.status} data-total={state.total} data-completed={state.completed}
    data-failed={state.failed} data-pending={state.pending} data-error-code={state.error?.code}>
    <button ref={primary} type="button" className={`np-primary${running ? ' np-running' : ''}`} aria-label={primaryLabel} aria-description="拖动调整位置；按住 Alt 并使用方向键微调。" aria-pressed={state.completed > 0}
      disabled={!running && !restoreOriginal && recovery.blocked}
      onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={finishDrag} onPointerCancel={finishDrag} onLostPointerCapture={finishDrag}
      onClick={event => { if (ignoreClick.current && event.detail !== 0) { ignoreClick.current = false; return; } primaryAction(); }}>
      {running ? <span className="np-stop" aria-hidden="true"/> : restoreOriginal ? restoreOriginalIcon : leafMark}
    </button>
    <div className="np-tools">
      {props.onRead && <button type="button" aria-label="阅读模式" title="阅读模式" onClick={props.onRead}>{readingIcon}</button>}
      <button type="button" aria-label="显示原文" title="显示原文" disabled={!props.hasTranslations && !running} onClick={props.onRestore}>{restoreOriginalIcon}</button>
      <button type="button" aria-label="翻译设置" title="翻译设置" onClick={props.onSettings}>{settingsIcon}</button>
    </div>
    <div className="np-info">
      <div role="status" aria-live="polite">{label}</div>
      {!running && <RecoveryAction recovery={recovery} className="np-retry" onSettings={props.onSettings}
        onRetry={retry ? continuing ? props.onContinue ?? props.onRetry : props.onRetry : undefined}
        retryLabel={continuing ? '继续未完成部分' : state.error && state.pending > 0 ? '重试未完成部分' : '重试失败段落'}/>}
      {state.limitReached && <small>页面内容较多，已达到本次翻译上限。</small>}
      {state.skipped > 0 && !running && <small>已跳过 {state.skipped} 个发生变化的段落。</small>}
    </div>
  </aside>;
}

export const pageBarStyles = `
:host{all:initial!important;color-scheme:light!important}
*{box-sizing:border-box}
.np-bar{position:fixed;display:grid;place-items:center;width:40px;height:40px;padding:2px;background:#fcfdf9;border:1px solid #dce7df;border-radius:13px;box-shadow:0 2px 10px #214a3610;font:11px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;pointer-events:auto;color:#315c50;isolation:isolate}
.np-bar::before{content:'';position:absolute;right:100%;top:0;width:6px;height:100%;pointer-events:none}
.np-bar[data-side=right]::before{right:auto;left:100%}
.np-tools{position:absolute;left:-1px;top:calc(100% - 1px);display:flex;flex-direction:column;gap:2px;width:40px;padding:4px;max-height:var(--np-tools-height);overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;background:#fcfdf9;border:1px solid #dce7df;border-radius:0 0 12px 12px;opacity:0;visibility:hidden;pointer-events:none;transition:opacity .12s,visibility .12s}
.np-bar[data-tools-up=true] .np-tools{top:auto;bottom:calc(100% - 1px);border-radius:12px 12px 0 0}
button{appearance:none;cursor:pointer;font:inherit;border:0;display:grid;place-items:center;-webkit-tap-highlight-color:transparent}
.np-tools button{width:30px;height:28px;flex-shrink:0;background:transparent;color:#527465;border-radius:7px}
.np-tools button:hover:not(:disabled){background:#edf4eb;color:#087f83}.np-tools button:disabled{opacity:.35;cursor:default}.np-tools svg{width:17px;height:17px}
button:focus-visible{outline:2px solid #087f83;outline-offset:1px}
.np-primary{position:relative;width:34px;height:34px;border-radius:10px;background:#edf5ec;color:#087f83;cursor:grab;touch-action:none;user-select:none;transition:background .12s}
.np-primary:hover{background:#e0efdf}.np-primary:disabled{opacity:.5;cursor:default}.np-primary svg{width:30px;height:30px;pointer-events:none}.np-primary[aria-pressed=true]:not(.np-running) svg{width:20px;height:20px}
.np-bar[data-dragging=true] .np-primary{cursor:grabbing}
.np-bar[data-attention=true] .np-primary::after{content:'';position:absolute;right:2px;bottom:2px;width:5px;height:5px;border-radius:50%;background:#b58436;box-shadow:0 0 0 1px #fcfdf9}
.np-running{background:#e3f1e8}.np-stop{height:11px;width:11px;background:currentColor;border-radius:2px;outline:1px solid #b2d9c6;outline-offset:5px;pointer-events:none}
.np-info{position:absolute;right:calc(100% + 6px);top:0;width:max-content;max-width:min(176px,var(--np-info-width));max-height:var(--np-info-height);overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;background:#fcfdf9;color:#315c50;border:1px solid #dce7df;border-radius:8px;padding:6px 8px;box-shadow:0 2px 10px #214a3610;text-align:left;overflow-wrap:anywhere;opacity:0;pointer-events:none;transition:opacity .12s}
.np-bar[data-side=right] .np-info{right:auto;left:calc(100% + 6px)}
.np-bar[data-tip-up=true] .np-info{top:auto;bottom:0}
.np-bar:not([data-dragging=true]):not([data-quiet=true]):is(:hover,:has(:focus-visible)) .np-tools{opacity:1;visibility:visible;pointer-events:auto}
.np-bar:not([data-dragging=true]):not([data-quiet=true]):is(:hover,:has(:focus-visible)) .np-info{opacity:1;pointer-events:auto}
.np-bar:not([data-dragging=true]):not([data-quiet=true]):is(:hover,:has(:focus-visible))::before{pointer-events:auto}
.np-info small{display:block;color:#637b6d;margin-top:4px;font-size:10px}.np-retry{display:block;background:transparent;color:#087f83;padding:5px 0 0;text-align:left;text-decoration:underline;text-underline-offset:3px}
.np-retry:disabled{opacity:.55;cursor:default;text-decoration:none}
@media(max-height:240px){.np-bar .np-tools{top:-1px;bottom:auto;left:auto;right:calc(100% - 1px);width:max-content;max-height:none;flex-direction:row;border-radius:12px}.np-tools button{width:28px}.np-bar[data-side=right] .np-tools{right:auto;left:calc(100% - 1px)}.np-bar .np-info{right:0;left:auto;top:calc(100% + 6px);bottom:auto;max-height:max(16px,calc(var(--np-info-height) - 46px))}.np-bar[data-side=right] .np-info{left:0;right:auto}.np-bar[data-tip-up=true] .np-info{top:auto;bottom:calc(100% + 6px)}.np-bar::before,.np-bar[data-side=right]::before{left:0;right:auto;top:100%;width:100%;height:6px}.np-bar[data-tip-up=true]::before{top:auto;bottom:100%}}
@media(hover:none){.np-bar:not([data-dragging=true]):not([data-quiet=true]):focus-within .np-tools{opacity:1;visibility:visible;pointer-events:auto}.np-bar:not([data-dragging=true]):not([data-quiet=true]):focus-within .np-info{opacity:1;pointer-events:auto}}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}
@media print{:host{display:none!important}}
`;
