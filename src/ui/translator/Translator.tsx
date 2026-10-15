import { useLayoutEffect, useRef, useState } from 'react';
import type { TranslationError, TranslationResult, WordResult } from '../../shared/contracts';
import { placeOverlay, type Point } from '../../selection/helpers';
import type { SelectionSnapshot } from '../../selection/snapshot';
import { formatTranslationForCopy, groupWordSenses, MISSING_CONTEXT_NOTE } from './word-result';

export type TranslatorView =
  | { mode: 'hidden' }
  | { mode: 'button'; selection: SelectionSnapshot }
  | {
      mode: 'card'; selection: SelectionSnapshot; status: 'loading' | 'done' | 'error';
      streamed: string; result?: TranslationResult; error?: TranslationError;
    };

export const translatorStyles = `
:host { all: initial; color-scheme: light; }
*,*::before,*::after { box-sizing: border-box; }
button { font: inherit; cursor: pointer; }
button:focus-visible { outline: 3px solid #79a79d; outline-offset: 3px; }
button:disabled { opacity: .5; cursor: default; }
.nt-floating { position: fixed; pointer-events: auto; font-family: -apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif; font-size: 14px; line-height: 1.55; color: #213c37; text-align: left; letter-spacing: normal; }
.nt-trigger { display: grid; place-items: center; width: 36px; height: 36px; border: 1px solid #d0e2dc; border-radius: 12px; color: #fff; background: #186551; box-shadow: 0 3px 16px #10292335; font-size: 17px; font-weight: 700; padding: 0; }
.nt-trigger:hover { background: #114e3e; transform: translateY(-1px); }
.nt-card { width: min(420px, calc(100vw - 20px)); max-height: calc(100vh - 20px); display: flex; flex-direction: column; overflow: hidden; border: 1px solid #d5e3dd; border-radius: 16px; background: #fbfdfb; box-shadow: 0 12px 42px #1029232e; }
.nt-card-word { width: min(460px, calc(100vw - 20px)); }
.nt-header { display: flex; justify-content: space-between; align-items: center; padding: 13px 16px; border-bottom: 1px solid #e4ece7; background: #f1f7f2; flex-shrink: 0; }
.nt-brand { font-size: 15px; font-weight: 700; display: flex; align-items: center; gap: 8px; }
.nt-mark { display: inline-grid; place-items: center; background: #186551; color: white; border-radius: 7px; width: 25px; height: 25px; font-size: 14px; }
.nt-meta { font-size: 11px; color: #6b8178; font-weight: 400; }
.nt-close { border: 0; background: transparent; color: #5e766c; border-radius: 6px; width: 28px; height: 28px; line-height: 1; font-size: 23px; padding: 0; }
.nt-close:hover { background: #e2ece5; }
.nt-body { overflow: auto; padding: 16px; scrollbar-width: thin; min-height: 0; }
.nt-source { margin: 0 0 13px; color: #7b887e; font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; border-left: 2px solid #d0ded2; padding-left: 10px; max-height: 75px; overflow: auto; }
.nt-word { font-size: 23px; line-height: 1.35; font-weight: 650; margin: 0; color: #154e3d; white-space: pre-wrap; overflow-wrap: anywhere; }
.nt-pos { display: inline-block; font-size: 12px; color: #5d7668; background: #eef4ec; border-radius: 5px; padding: 2px 7px; margin: 9px 0 0; }
.nt-explanation { border-top: 1px solid #e4ece7; padding-top: 12px; margin: 13px 0 0; font-size: 13px; color: #566e62; white-space: pre-wrap; overflow-wrap: anywhere; }
.nt-section-title { margin: 0 0 10px; color: #536e60; font-size: 12px; font-weight: 700; letter-spacing: .03em; }
.nt-context-note { margin: 0 0 12px; font-size: 12px; color: #7a7866; line-height: 1.65; }
.nt-context { margin-top: 12px; padding: 8px 10px; border: 1px solid #e0e9df; border-radius: 8px; background: #f5f8f2; color: #6b7b6b; font-size: 12px; }
.nt-context summary { cursor: pointer; }
.nt-context summary:focus-visible { outline: 3px solid #79a79d; outline-offset: 3px; }
.nt-context-text { margin: 8px 0 0; max-height: 140px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.7; }
.nt-senses { margin-top: 18px; padding-top: 15px; border-top: 1px solid #dfe8de; }
.nt-senses > .nt-section-title { color: #284d38; font-size: 13px; }
.nt-sense-group + .nt-sense-group { margin-top: 13px; }
.nt-sense-pos { margin: 0 0 6px; color: #60795e; font-size: 12px; font-weight: 600; }
.nt-sense-list { margin: 0; padding-left: 23px; list-style: decimal outside; }
.nt-sense-meaning { padding-left: 3px; color: #34503c; font-size: 14px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
.nt-sense-meaning + .nt-sense-meaning { margin-top: 5px; }
.nt-text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; color: #263f33; font-size: 15px; line-height: 1.85; }
.nt-loading { display: flex; align-items: center; gap: 8px; color: #647c6e; font-size: 13px; margin: 0 0 8px; }
.nt-dot { width: 7px; height: 7px; border-radius: 50%; background: #378570; animation: nt-pulse 1.2s ease-in-out infinite; }
@keyframes nt-pulse { 50% { opacity: .35; } }
@media (prefers-reduced-motion: reduce) { .nt-dot { animation: none; } }
.nt-error { border: 1px solid #efddce; border-radius: 9px; padding: 12px; background: #fff8f1; color: #8b542f; font-size: 13px; margin: 0; }
.nt-footer { padding: 10px 16px; border-top: 1px solid #e4ece7; display: flex; gap: 8px; align-items: center; justify-content: space-between; flex-shrink: 0; }
.nt-hint { color: #819185; font-size: 11px; }
.nt-actions { display: flex; gap: 7px; }
.nt-action { background: #f0f6ef; color: #315d48; border: 1px solid #d7e4d8; border-radius: 7px; padding: 5px 10px; font-size: 12px; }
.nt-action:hover { background: #e6efe5; }
.nt-primary { color: #fff; background: #186551; border-color: #186551; }
.nt-primary:hover { background: #114e3e; }
`;

function viewportSize(): { width: number; height: number } {
  return { width: window.innerWidth, height: window.innerHeight };
}

function WordTranslation({ result, context }: { result: WordResult; context?: string }) {
  const reference = context?.trim();
  const heading = reference ? '本句含义' : '参考释义';
  const groups = groupWordSenses(result.senses);
  return <div>
    <section className="nt-current-sense" aria-label={heading}>
      <h2 className="nt-section-title">{heading}</h2>
      {!reference && <p className="nt-context-note">{MISSING_CONTEXT_NOTE}</p>}
      <p className="nt-word">{result.translation}</p>
      <span className="nt-pos">{result.partOfSpeech}</span>
      <p className="nt-explanation">{result.explanation}</p>
      {reference && <details className="nt-context">
        <summary>参考原句</summary>
        <p className="nt-context-text">{reference}</p>
      </details>}
    </section>
    <section className="nt-senses" aria-label="常见义项">
      <h2 className="nt-section-title">常见义项</h2>
      {groups.map((group) => <div className="nt-sense-group" key={group.partOfSpeech}>
        <h3 className="nt-sense-pos">{group.partOfSpeech}</h3>
        <ol className="nt-sense-list">{group.meanings.map((meaning, index) =>
          <li className="nt-sense-meaning" key={index}>{meaning}</li>)}</ol>
      </div>)}
    </section>
  </div>;
}

export function Translator({ view, source, onTranslate, onClose, onRetry, onSettings }: {
  view: TranslatorView;
  source: 'web' | 'pdf';
  onTranslate: () => void;
  onClose: () => void;
  onRetry: () => void;
  onSettings: () => void;
}) {
  const floating = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<Point>({ x: 10, y: 10 });
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const selection = view.mode === 'hidden' ? undefined : view.selection;

  useLayoutEffect(() => {
    if (!selection || !floating.current) return;
    const element = floating.current;
    const update = () => {
      const { width, height } = element.getBoundingClientRect();
      setPosition(placeOverlay(selection.anchor, width, height, viewportSize()));
    };
    update();
    const resize = new ResizeObserver(update);
    resize.observe(element);
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    return () => {
      resize.disconnect();
      window.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
    };
  }, [selection, view.mode]);

  useLayoutEffect(() => { setCopyStatus('idle'); }, [selection]);

  if (view.mode === 'hidden') return null;
  const copy = async () => {
    if (view.mode !== 'card' || !view.result) return;
    const text = formatTranslationForCopy(view.result, Boolean(view.selection.input.context?.trim()));
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
      await navigator.clipboard.writeText(text);
      setCopyStatus('copied');
    } catch {
      // Non-secure HTTP pages may lack Clipboard API; a focused plain-text field works there.
      const field = document.createElement('textarea');
      field.value = text;
      field.style.cssText = 'position:fixed;left:-10000px;top:0;opacity:0';
      const shadow = floating.current?.getRootNode();
      const parent = shadow instanceof ShadowRoot ? shadow : document.body;
      parent.appendChild(field);
      field.focus({ preventScroll: true });
      field.select();
      let copied = false;
      try { copied = document.execCommand('copy'); } catch { /* Display manual-copy guidance. */ }
      field.remove();
      setCopyStatus(copied ? 'copied' : 'failed');
    }
  };
  return <div ref={floating} className="nt-floating" style={{ left: position.x, top: position.y }}>
    {view.mode === 'button' ? <button className="nt-trigger" aria-label="翻译选中的英文" title="翻译选中的英文"
      onPointerDown={(event) => event.preventDefault()} onClick={onTranslate}>译</button> :
      <section className={`nt-card${view.selection.input.kind === 'word' ? ' nt-card-word' : ''}`} role="dialog" aria-label="英文翻译结果">
        <header className="nt-header">
          <span className="nt-brand"><span className="nt-mark">译</span>近译<span className="nt-meta">{source === 'pdf' ? 'PDF' : '网页'} · 简体中文</span></span>
          <button className="nt-close" aria-label="关闭翻译" title="关闭 · Esc" onClick={onClose}>×</button>
        </header>
        <div className="nt-body">
          <p className="nt-source" title={view.selection.input.text}>{view.selection.input.text}</p>
          {view.status === 'loading' && <p className="nt-loading" role="status"><span className="nt-dot" />{view.streamed ? '正在翻译…' : '正在连接 DeepSeek…'}</p>}
          {view.status === 'error' && <p className="nt-error" role="alert">{view.error?.message ?? '翻译失败，请重试。'}</p>}
          {view.result?.kind === 'word' && <WordTranslation result={view.result} context={view.selection.input.context} />}
          {(view.result?.kind === 'text' || view.streamed) && <p className="nt-text">{view.result?.kind === 'text' ? view.result.translation : view.streamed}</p>}
        </div>
        <footer className="nt-footer">
          <span className="nt-hint" role="status">{copyStatus === 'copied' ? '已复制译文' : copyStatus === 'failed' ? '复制失败，请手动选中译文' : 'DeepSeek · Esc 关闭'}</span>
          <div className="nt-actions">
            {view.status === 'error' && view.error?.code === 'CONFIG' && <button className="nt-action" onClick={onSettings}>打开设置</button>}
            {view.status === 'error' && view.error?.retryable && <button className="nt-action nt-primary" onClick={onRetry}>重试</button>}
            {view.status === 'done' && <button className="nt-action" onClick={() => void copy()}>复制</button>}
          </div>
        </footer>
      </section>}
  </div>;
}
