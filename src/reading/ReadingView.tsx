import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type RefCallback } from 'react';
import type { ReadingPreferences } from '../shared/reading';
import { readingAppearanceVariables } from '../shared/reading-appearance';
import { ReadingSettings, type PreferencesStatus } from './ReadingSettings';
import type { ReadingArticle } from './types';
import type { TranslationError, TranslationServiceStatus } from '../shared/contracts';
import { RecoveryAction, useTranslationRecovery } from '../ui/translation/RecoveryAction';

export type { ReadingPreferences } from '../shared/reading';

export interface ReadingTranslationState {
  status: 'idle' | 'running' | 'done' | 'stopped';
  total: number;
  completed: number;
  failed: number;
  pending?: number;
  skipped?: number;
  limitReached?: boolean;
  error?: TranslationError;
}

export interface ReadingViewProps {
  article: ReadingArticle;
  preferences: ReadingPreferences;
  translation: ReadingTranslationState;
  notice?: string;
  serviceStatus?: TranslationServiceStatus;
  /** A fraction from zero to one, measured by the reading controller. */
  progress: number;
  activeHeading?: string;
  articleRef: RefCallback<HTMLDivElement>;
  scrollRef?: RefCallback<HTMLDivElement>;
  onPreferences: (preferences: ReadingPreferences) => void;
  preferencesStatus?: PreferencesStatus;
  onRetryPreferences?: () => void;
  onResetPreferences?: () => void;
  onUndoPreferences?: () => void;
  canUndoPreferences?: boolean;
  onLayoutCommit?: () => void;
  onClose: () => void;
  onTranslate: () => void;
  onStop: () => void;
  onRetry: () => void;
  onSettings?: () => void;
  onHeading: (id: string) => void;
  onReturnToSource?: (sourceId?: string) => void;
}

type IconName = 'book' | 'settings' | 'close' | 'source' | 'globe' | 'translate' | 'check' | 'stop' | 'info' | 'clock';

function Icon({ name }: { name: IconName }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {name === 'book' && <><path d="M12 6C9 4 6 4 3 5v14c3-1 6-1 9 1 3-2 6-2 9-1V5c-3-1-6-1-9 1Z"/><path d="M12 6v14M6 9h3m6 0h3M6 13h3m6 0h3"/></>}
    {name === 'settings' && <><path d="M4 7h6m4 0h6M4 17h10m4 0h2"/><circle cx="12" cy="7" r="2"/><circle cx="16" cy="17" r="2"/></>}
    {name === 'close' && <path d="m6 6 12 12M6 18 18 6"/>}
    {name === 'source' && <><path d="M9 5H5v14h14v-4M13 5h6v6M19 5l-9 9"/></>}
    {name === 'globe' && <><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 4 6 4 9s-1 6-4 9c-3-3-4-6-4-9s1-6 4-9Z"/></>}
    {name === 'translate' && <><path d="M3 5h12M9 3v2M5 5c.6 5 3.5 8.5 8 10M13 5c-.6 4.8-3.5 8.5-8 11M13 21l4-10 4 10M14.4 18h5.2"/></>}
    {name === 'check' && <path d="m5 12 4 4L19 6"/>}
    {name === 'stop' && <rect x="6" y="6" width="12" height="12" rx="2"/>}
    {name === 'info' && <><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/></>}
    {name === 'clock' && <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>}
  </svg>;
}

function LeafMark() {
  return <svg viewBox="0 0 32 32" fill="none" aria-hidden="true" focusable="false">
    <path d="M5 24C4 12 10 7 25 5c0 13-6 21-17 19" fill="currentColor" opacity=".16"/>
    <path d="M5 26c4-8 8-13 16-17M8 20C5 10 12 6 26 5c0 13-6 21-16 18" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>;
}

function hostName(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

/** Presentation only. Content insertion, scroll tracking and translation belong to the controller. */
export function ReadingView(props: ReadingViewProps) {
  const { article, preferences, translation } = props;
  const [settingsOpen, setSettingsOpen] = useState(true);
  const [mobilePanel, setMobilePanel] = useState<'settings' | 'outline' | null>(null);
  const [settingsDrawer, setSettingsDrawer] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.('(max-width:1180px)').matches);
  const [outlineDrawer, setOutlineDrawer] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.('(max-width:860px)').matches);
  const activePanel = mobilePanel === 'settings' && settingsDrawer ? 'settings' : mobilePanel === 'outline' && outlineDrawer ? 'outline' : null;
  const header = useRef<HTMLDivElement>(null);
  const previousLayout = useRef<{ preferences: ReadingPreferences; settingsOpen: boolean; activePanel: typeof activePanel;
    headerHeight: number; commit?: () => void } | undefined>(undefined);
  useEffect(() => {
    if (!window.matchMedia) return;
    const settingsQuery = window.matchMedia('(max-width:1180px)');
    const outlineQuery = window.matchMedia('(max-width:860px)');
    const sync = () => {
      setSettingsDrawer(settingsQuery.matches); setOutlineDrawer(outlineQuery.matches);
      setMobilePanel(current => current === 'settings' && !settingsQuery.matches || current === 'outline' && !outlineQuery.matches ? null : current);
    };
    sync(); settingsQuery.addEventListener('change', sync); outlineQuery.addEventListener('change', sync);
    return () => { settingsQuery.removeEventListener('change', sync); outlineQuery.removeEventListener('change', sync); };
  }, []);
  const settingsTrigger = useRef<HTMLButtonElement>(null);
  const outlineTrigger = useRef<HTMLButtonElement>(null);
  const settingsPanel = useRef<HTMLElement>(null);
  const outlinePanel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (activePanel) (activePanel === 'settings' ? settingsPanel : outlinePanel).current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, [activePanel]);
  const viewId = useId();
  const titleId = `${viewId}-title`;
  const settingsId = `${viewId}-settings`;
  const outlineId = `${viewId}-outline`;
  const helpId = `${viewId}-help`;
  const sourceHost = hostName(article.sourceUrl);
  const sourceName = article.siteName || sourceHost;
  const fraction = Number.isFinite(props.progress) ? Math.min(1, Math.max(0, props.progress)) : 0;
  const percent = Math.round(fraction * 100);
  const minutes = Math.max(1, article.readingMinutes);
  const remaining = Math.max(1, Math.ceil(minutes * (1 - fraction)));
  const running = translation.status === 'running';
  const recovery = useTranslationRecovery(translation.error, props.serviceStatus);
  const done = translation.status === 'done';
  const stopped = translation.status === 'stopped';
  const translatedFraction = translation.total ? Math.min(1, translation.completed / translation.total) : 0;
  const primaryLabel = running ? '停止翻译' : done ? translation.failed ? '本次翻译结束' : '翻译完成' : stopped ? '继续翻译' : '翻译正文';
  const translationLabel = recovery.blocked ? [props.notice, recovery.message].filter(Boolean).join(' ') : props.notice || recovery.message || (running
    ? `正在翻译 ${translation.completed} / ${translation.total} 段，可继续阅读。`
    : done ? `已翻译 ${translation.completed} / ${translation.total} 段${translation.failed ? `，${translation.failed} 段未完成。` : '。'}`
    : stopped ? `翻译已停止，保留已完成的 ${translation.completed} 段译文。`
    : '本地阅读，无需登录。翻译仅在你点击时开始。');
  const waitingForTranslation = preferences.mode === 'translation' && translation.completed === 0;
  const showTranslationStatus = Boolean(running || stopped || recovery.blocked || translation.error || props.notice || translation.failed
    || translation.limitReached || translation.skipped || waitingForTranslation);
  useLayoutEffect(() => {
    const headerHeight = header.current?.getBoundingClientRect().height ?? 0;
    const previous = previousLayout.current;
    previousLayout.current = { preferences, settingsOpen, activePanel, headerHeight, commit: props.onLayoutCommit };
    // Status text can wrap without changing status visibility. Correct only actual
    // layout changes, so ordinary reading/translation progress never steals the scroll.
    if (!previous || previous.preferences !== preferences || previous.settingsOpen !== settingsOpen
      || previous.activePanel !== activePanel || previous.headerHeight !== headerHeight || previous.commit !== props.onLayoutCommit) {
      props.onLayoutCommit?.();
    }
  });
  const minimumHeadingLevel = article.outline.length ? Math.min(...article.outline.map(item => item.level)) : 2;
  const update = (patch: Partial<ReadingPreferences>) => props.onPreferences({ ...preferences, ...patch });
  const closePanel = () => {
    const trigger = activePanel === 'settings' ? settingsTrigger : outlineTrigger;
    setMobilePanel(null);
    trigger.current?.focus();
  };
  const customStyle = readingAppearanceVariables(preferences) as CSSProperties;

  return <section className="nr-reader" role="document" aria-label="文章阅读内容" aria-describedby={helpId} tabIndex={-1}
    onKeyDown={event => { if (event.key === 'Escape' && activePanel) { event.preventDefault(); event.stopPropagation(); closePanel(); } }}
    data-theme={preferences.theme} data-font={preferences.fontFamily} data-width={preferences.width} data-mode={preferences.mode}
    data-focus={preferences.focus} data-code-wrap={preferences.codeWrap} data-translation-style={preferences.translationStyle} data-settings-open={settingsOpen} data-status={translation.status} style={customStyle}>
    <p className="nr-sr-only" id={helpId}>阅读模式。按 Escape 退出并回到原网页。</p>
    <div className="nr-header" ref={header}>
    <header className="nr-topbar">
      <div className="nr-brand"><LeafMark/>近译<span>阅读</span></div>
      <div className="nr-source" title={article.sourceUrl}><Icon name="globe"/><span>{sourceHost || sourceName}</span></div>
      <div className="nr-reading-tools" role="group" aria-label="阅读翻译工具">
        <div className="nr-segmented" role="group" aria-label="正文显示模式">
          {(['original', 'bilingual', 'translation'] as const).map((mode, index) => <button type="button" key={mode} aria-pressed={preferences.mode === mode}
            onClick={() => update({ mode })}>{['原文', '双语', '仅译文'][index]}</button>)}
        </div>
        <div className="nr-translate-controls">
          <button type="button" className="nr-translate-button" aria-label={primaryLabel} title="点击后翻译正文；显示模式切换不会自动请求翻译"
            disabled={done || (!running && (recovery.blocked || recovery.action === 'settings'))}
            onClick={running ? props.onStop : stopped ? props.onRetry : props.onTranslate}>
            <Icon name={running ? 'stop' : done ? 'check' : 'translate'}/>{stopped && !translation.failed && (translation.pending ?? 0) > 0 ? '继续未完成部分' : primaryLabel}
          </button>
        </div>
      </div>
      <div className="nr-top-actions">
        <button type="button" className="nr-icon-button nr-toc-trigger" aria-label="阅读目录" title="阅读目录" aria-controls={outlineId}
          aria-expanded={activePanel === 'outline'} ref={outlineTrigger} onClick={() => setMobilePanel(mobilePanel === 'outline' ? null : 'outline')}><Icon name="book"/></button>
        <button type="button" className="nr-icon-button nr-large-screen" aria-label="显示设置" title="显示设置" aria-controls={settingsId}
          aria-expanded={settingsOpen} onClick={() => setSettingsOpen(!settingsOpen)}><Icon name="settings"/></button>
        <button type="button" className="nr-icon-button nr-small-screen" aria-label="显示设置" title="显示设置" aria-controls={settingsId}
          aria-expanded={activePanel === 'settings'} ref={settingsTrigger} onClick={() => setMobilePanel(mobilePanel === 'settings' ? null : 'settings')}><Icon name="settings"/></button>
        {props.onReturnToSource && <button type="button" className="nr-icon-button" aria-label="返回原网页当前位置" title="返回原网页当前位置" onClick={() => props.onReturnToSource?.()}><Icon name="source"/></button>}
        <button type="button" className="nr-exit" aria-label="退出阅读模式" title="退出阅读模式（Esc）" onClick={props.onClose}><Icon name="close"/><span>退出</span><kbd aria-hidden="true">Esc</kbd></button>
      </div>
    </header>
    {showTranslationStatus && <div className="nr-translation-note nr-header-status" role="status" aria-live="polite" data-tone={translation.error ? 'error' : undefined}>
      <Icon name="info"/><span>{waitingForTranslation && !running && !stopped && !translation.error && !recovery.blocked && !props.notice
        ? '尚无译文，暂时显示原文。点击“翻译正文”后，完成的段落会显示译文。' : translationLabel}
        {translation.limitReached && ' 本次正文较多，已达到翻译上限。'}
        {!!translation.skipped && !running && ` 已跳过 ${translation.skipped} 个无法翻译的段落。`}
      </span>
      {translation.failed > 0 && !running && (!translation.error || recovery.action === 'retry') && <RecoveryAction
        recovery={recovery} className="nr-retry" onRetry={props.onRetry} retryLabel="重试失败段落"/>}
      {!running && <RecoveryAction recovery={recovery} className="nr-retry" onSettings={props.onSettings}/>}
      {running && <div className="nr-translation-meter" role="progressbar" aria-label="正文翻译进度" aria-valuemin={0} aria-valuemax={translation.total || 1} aria-valuenow={translation.completed}><span style={{ width: `${translatedFraction * 100}%` }}/></div>}
    </div>}
    <div className="nr-top-progress" style={{ width: `${percent}%` }} aria-hidden="true"/>
    </div>

    <div className="nr-layout">
      <aside className="nr-outline" ref={outlinePanel} id={outlineId} aria-label="阅读目录" data-mobile-open={activePanel === 'outline'} inert={activePanel === 'settings'}>
        <div className="nr-panel-heading"><h2>文章目录</h2><button type="button" className="nr-icon-button nr-panel-close" aria-label="关闭目录" onClick={closePanel}><Icon name="close"/></button></div>
        {article.outline.length ? <nav aria-label="文章章节"><ol>{article.outline.map(item => <li key={item.id}>
          <button type="button" className="nr-outline-item" data-depth={Math.max(0, Math.min(2, item.level - minimumHeadingLevel))}
            aria-current={props.activeHeading === item.id ? 'location' : undefined} title={item.text}
            onClick={() => { props.onHeading(item.id); setMobilePanel(null); }}>{item.text}</button>
        </li>)}</ol></nav> : <p className="nr-no-outline">这篇文章没有章节标题。<br/>放慢一点，专注于正文。</p>}
        <div className="nr-reading-progress">
          <div className="nr-progress-label"><span>阅读进度</span><strong>{percent}<span style={{ fontSize: 11 }}>%</span></strong></div>
          <div className="nr-progress-track" role="progressbar" aria-label="阅读进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><span style={{ width: `${percent}%` }}/></div>
          <p>{percent >= 100 ? '已读至文末' : `约剩 ${remaining} 分钟`}</p>
          <small>跟随你的阅读位置</small>
        </div>
      </aside>

      <div className="nr-scroll" ref={props.scrollRef} inert={activePanel !== null}>
        <main className="nr-paper" aria-labelledby={titleId}>
          <header className="nr-article-heading">
            <p className="nr-eyebrow">{sourceName || 'READING MODE'}</p>
            <h1 id={titleId}>{article.title}</h1>
            <div className="nr-byline">
              {article.byline && <><strong>{article.byline}</strong><i aria-hidden="true"/></>}
              {sourceName && <><span>{sourceName}</span><i aria-hidden="true"/></>}
              <span>约 {minutes} 分钟</span>
              {article.wordCount > 0 && <><i aria-hidden="true"/><span>{article.wordCount.toLocaleString('zh-CN')} 字词</span></>}
            </div>
          </header>
          <div className="nr-content" ref={props.articleRef} data-mode={preferences.mode} data-focus={preferences.focus} lang={article.lang || undefined}/>
          <footer className="nr-article-footer">
            <p><LeafMark/>读到这里，留一点时间思考。</p>
            {props.onReturnToSource ? <button type="button" className="nr-text-button" aria-label="返回原网页当前位置" onClick={() => props.onReturnToSource?.()}>返回原网页<Icon name="source"/></button>
              : <button type="button" className="nr-text-button" onClick={props.onClose}>退出阅读<Icon name="source"/></button>}
          </footer>
        </main>
      </div>

      <aside className="nr-settings" ref={settingsPanel} id={settingsId} aria-label="显示设置" data-mobile-open={activePanel === 'settings'} inert={activePanel === 'outline'}>
        <div className="nr-panel-heading"><h2>让阅读更合眼</h2><button type="button" className="nr-icon-button nr-panel-close" aria-label="关闭显示设置" onClick={() => { setSettingsOpen(false); closePanel(); }}><Icon name="close"/></button></div>
        <ReadingSettings preferences={preferences} onPreferences={props.onPreferences} preferencesStatus={props.preferencesStatus}
          canUndoPreferences={props.canUndoPreferences} onUndoPreferences={props.onUndoPreferences} onResetPreferences={props.onResetPreferences}
          onRetryPreferences={props.onRetryPreferences}/>
      </aside>
      <button type="button" className="nr-scrim" data-panel={activePanel || undefined} aria-label="关闭阅读面板" onClick={closePanel} tabIndex={activePanel ? 0 : -1}/>
    </div>
  </section>;
}
