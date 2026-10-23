import { useEffect, useId, useRef, useState } from 'react';
import { applyReadingStyle, DEFAULT_READING_PREFERENCES, READING_PRESETS, readingStyle, type ReadingPreferences, type ReadingStyle } from '../shared/reading';
import { bestTextColor, contrastRatio } from '../shared/reading-appearance';
import { MAX_READING_STYLE_FILE_BYTES, parseReadingStyleFile, serializeReadingStyle } from '../shared/reading-style-file';

export type PreferencesStatus = 'idle' | 'saving' | 'saved' | 'error';

export interface ReadingSettingsProps {
  preferences: ReadingPreferences;
  preferencesStatus?: PreferencesStatus;
  canUndoPreferences?: boolean;
  onPreferences: (preferences: ReadingPreferences) => void;
  onRetryPreferences?: () => void;
  onResetPreferences?: () => void;
  onUndoPreferences?: () => void;
}

function WidthMark({ width }: { width: 'narrow' | 'comfortable' | 'wide' }) {
  const inset = width === 'narrow' ? 7 : width === 'comfortable' ? 4 : 1;
  return <svg viewBox="0 0 26 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
    <path d={`M${inset} 4h${26 - inset * 2}M${inset} 10h${26 - inset * 2}M${inset} 16h${26 - inset * 2}`}/>
  </svg>;
}

function RangeSetting({ label, name, value, min, max, step, display, onChange }: {
  label: string; name: string; value: number; min: number; max: number; step: number;
  display: string; onChange: (value: number) => void;
}) {
  const id = useId();
  return <div className="nr-setting nr-range-setting">
    <label className="nr-setting-label" htmlFor={id}>{label}<output>{display}</output></label>
    <input id={id} type="range" min={min} max={max} step={step} aria-label={name} aria-valuetext={display}
      value={value} onChange={event => onChange(Number(event.currentTarget.value))}/>
  </div>;
}

function sameStyle(first: ReadingStyle, second: ReadingStyle): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

/** Appearance controls only. The controller owns undo history, saving and article layout. */
export function ReadingSettings(props: ReadingSettingsProps) {
  const { preferences } = props;
  const fontSizeId = useId();
  const currentStyle = readingStyle(preferences);
  const preset = READING_PRESETS.find(item => sameStyle(currentStyle, item.style));
  const saved = preferences.savedStyle;
  const matchesSaved = saved !== null && sameStyle(currentStyle, saved);
  const update = (patch: Partial<ReadingStyle>) => props.onPreferences(applyReadingStyle(preferences, patch));
  const ratio = contrastRatio(preferences.colors.text, preferences.colors.background);
  const lowContrast = ratio < 4.5;
  const status = props.preferencesStatus ?? 'idle';

  const fileInput = useRef<HTMLInputElement>(null);
  const latestPreferences = useRef(preferences);
  latestPreferences.current = preferences;
  const latestOnPreferences = useRef(props.onPreferences);
  latestOnPreferences.current = props.onPreferences;
  const importRevision = useRef(0);
  const downloads = useRef(new Map<string, number>());
  const [fileFeedback, setFileFeedback] = useState<{ kind: 'success' | 'error' | 'info'; message: string } | null>(null);
  useEffect(() => () => {
    importRevision.current++;
    for (const [url, timer] of downloads.current) { window.clearTimeout(timer); URL.revokeObjectURL(url); }
    downloads.current.clear();
  }, []);

  const importStyle = async (input: HTMLInputElement) => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const revision = ++importRevision.current;
    if (file.size > MAX_READING_STYLE_FILE_BYTES) {
      setFileFeedback({ kind: 'error', message: '版式文件过大，请选择 16 KB 以内的近译版式 JSON。当前设置未更改。' });
      return;
    }
    setFileFeedback({ kind: 'info', message: '正在读取版式文件…' });
    try {
      const style = parseReadingStyleFile(await file.text());
      if (revision !== importRevision.current) return;
      latestOnPreferences.current(applyReadingStyle(latestPreferences.current, style));
      setFileFeedback({ kind: 'success', message: '已应用导入版式。当前阅读模式和我的样式均已保留。' });
    } catch (error) {
      if (revision !== importRevision.current) return;
      const message = error instanceof Error ? error.message : '无法读取版式文件。';
      setFileFeedback({ kind: 'error', message: message.includes('当前设置未更改') ? message : message + ' 当前设置未更改。' });
    }
  };

  const exportStyle = () => {
    try {
      const url = URL.createObjectURL(new Blob([serializeReadingStyle(latestPreferences.current)], { type: 'application/json' }));
      const timer = window.setTimeout(() => { URL.revokeObjectURL(url); downloads.current.delete(url); }, 0);
      downloads.current.set(url, timer);
      const link = document.createElement('a');
      link.href = url; link.download = '近译-阅读版式.json';
      document.body.append(link);
      try { link.click(); } finally { link.remove(); }
      setFileFeedback({ kind: 'success', message: '已开始导出版式，仅包含显示偏好。' });
    } catch {
      setFileFeedback({ kind: 'error', message: '版式导出未能开始，请重试。当前设置未更改。' });
    }
  };


  return <div className="nr-settings-content">
    <fieldset className="nr-setting nr-presets-setting">
      <legend>从一个阅读场景开始<span className="nr-setting-tag">{preset ? '已选方案' : matchesSaved ? '我的样式' : '自定义'}</span></legend>
      <div className="nr-presets">
        {READING_PRESETS.map(item => <button type="button" key={item.id} className="nr-preset" data-preset={item.id}
          aria-label={item.label} aria-pressed={preset?.id === item.id} onClick={() => update(item.style)}>
          <span className="nr-preset-art" aria-hidden="true"><i/><i/><i/></span>
          <span className="nr-preset-copy"><strong>{item.label}</strong><span>{item.description}</span></span>
          <span className="nr-preset-check" aria-hidden="true">{preset?.id === item.id ? '✓' : ''}</span>
        </button>)}
      </div>
      <p className="nr-setting-hint">方案只是起点，可继续微调。保留当前原文或双语模式。</p>
    </fieldset>

    <fieldset className="nr-setting">
      <legend>阅读主题</legend>
      <div className="nr-themes">
        {([
          ['system', '跟随系统'], ['paper', '纸白'], ['sepia', '暖纸'], ['dark', '深色'], ['contrast', '高对比'], ['custom', '自定义'],
        ] as const).map(([theme, label]) => <button type="button" className="nr-theme" key={theme} aria-label={`${label}主题`}
          aria-pressed={preferences.theme === theme} onClick={() => update({ theme })}>
          <span className="nr-theme-swatch" data-theme={theme} aria-hidden="true"
            style={theme === 'custom' ? { background: preferences.colors.background, color: preferences.colors.text } : undefined}>{theme === 'system' ? '◐' : 'Aa'}</span>
          <span>{label}</span>
        </button>)}
      </div>
    </fieldset>

    <details className="nr-custom-colors nr-settings-details" open={preferences.theme === 'custom'}>
      <summary>自定义配色<span>背景 · 文字 · 强调色</span></summary>
      <div className="nr-details-body">
        <p className="nr-setting-hint">选择颜色后，直接在当前文章预览。</p>
        <div className="nr-color-fields">
          {([['background', '背景颜色'], ['text', '文字颜色'], ['accent', '强调颜色']] as const).map(([key, label]) => <label className="nr-color-field" key={key}>
            <span>{label}</span><span className="nr-color-value"><input type="color" aria-label={`自定义${label}`} value={preferences.colors[key]}
              onChange={event => update({ theme: 'custom', colors: { ...preferences.colors, [key]: event.currentTarget.value } })}/>
              <code>{preferences.colors[key].toUpperCase()}</code></span>
          </label>)}
        </div>
        <p className="nr-contrast-note" data-warning={lowContrast} role={preferences.theme === 'custom' && lowContrast ? 'status' : undefined}>
          <strong>正文对比度 {ratio.toFixed(2)} : 1</strong>
          <span>{lowContrast ? '文字与背景较接近，建议达到 4.5 : 1。' : '文字与背景有清晰的区分。'}</span>
        </p>
        {lowContrast && <button type="button" className="nr-secondary-button nr-contrast-fix" onClick={() => update({
          theme: 'custom', colors: { ...preferences.colors, text: bestTextColor(preferences.colors.background) },
        })}>提高文字对比度</button>}
      </div>
    </details>

    <fieldset className="nr-setting">
      <legend>正文字体</legend>
      <div className="nr-font-options">
        <button type="button" className="nr-font-option" data-font="serif" aria-label="衬线字体" aria-pressed={preferences.fontFamily === 'serif'}
          onClick={() => update({ fontFamily: 'serif' })}><strong aria-hidden="true">阅 Aa</strong><span>书卷衬线</span></button>
        <button type="button" className="nr-font-option" data-font="sans" aria-label="无衬线字体" aria-pressed={preferences.fontFamily === 'sans'}
          onClick={() => update({ fontFamily: 'sans' })}><strong aria-hidden="true">阅 Aa</strong><span>简洁无衬线</span></button>
      </div>
    </fieldset>

    <div className="nr-setting">
      <label className="nr-setting-label" htmlFor={fontSizeId}>字号<output>{preferences.fontSize} px</output></label>
      <div className="nr-font-stepper">
        <button type="button" className="nr-step" aria-label="减小字号" disabled={preferences.fontSize <= 14}
          onClick={() => update({ fontSize: Math.max(14, preferences.fontSize - 1) })}>A−</button>
        <input id={fontSizeId} type="range" min={14} max={36} step={1} aria-label="阅读字号" aria-valuetext={`${preferences.fontSize} 像素`}
          value={preferences.fontSize} onChange={event => update({ fontSize: Number(event.currentTarget.value) })}/>
        <button type="button" className="nr-step" aria-label="增大字号" disabled={preferences.fontSize >= 36}
          onClick={() => update({ fontSize: Math.min(36, preferences.fontSize + 1) })}>A+</button>
      </div>
    </div>
    <RangeSetting label="行间距" name="阅读行间距" value={preferences.lineHeight} min={1.4} max={2.4} step={0.05}
      display={`${preferences.lineHeight.toFixed(2).replace(/0$/, '')} 倍`} onChange={lineHeight => update({ lineHeight })}/>

    <fieldset className="nr-setting">
      <legend>正文栏宽{preferences.width === 'custom' && <span className="nr-setting-tag">自定义 {preferences.columnWidth} px</span>}</legend>
      <div className="nr-widths">
        {(['narrow', 'comfortable', 'wide'] as const).map((width, index) => <button type="button" className="nr-width" key={width}
          aria-label={`${['紧凑', '舒适', '宽阔'][index]}栏宽`} aria-pressed={preferences.width === width}
          onClick={() => update({ width })}><WidthMark width={width}/><span>{['紧凑', '舒适', '宽阔'][index]}</span></button>)}
      </div>
    </fieldset>

    <details className="nr-settings-details nr-advanced-settings">
      <summary>精细排版<span>间距 · 代码 · 双语</span></summary>
      <div className="nr-details-body">
        <RangeSetting label="自定义栏宽" name="阅读自定义栏宽" value={preferences.columnWidth} min={480} max={1080} step={20}
          display={`${preferences.columnWidth} px`} onChange={columnWidth => update({ columnWidth, width: 'custom' })}/>
        <RangeSetting label="字间距" name="阅读字间距" value={preferences.letterSpacing} min={0} max={0.12} step={0.01}
          display={`${preferences.letterSpacing.toFixed(2)} em`} onChange={letterSpacing => update({ letterSpacing })}/>
        <RangeSetting label="词间距" name="阅读词间距" value={preferences.wordSpacing} min={0} max={0.2} step={0.02}
          display={`${preferences.wordSpacing.toFixed(2)} em`} onChange={wordSpacing => update({ wordSpacing })}/>
        <RangeSetting label="段落间距" name="阅读段落间距" value={preferences.paragraphSpacing} min={0.6} max={2} step={0.05}
          display={`${preferences.paragraphSpacing.toFixed(2).replace(/0$/, '')} 倍字号`} onChange={paragraphSpacing => update({ paragraphSpacing })}/>
        <fieldset className="nr-setting">
          <legend>正文对齐</legend><div className="nr-choice-row">
            <button type="button" aria-label="左侧对齐" aria-pressed={preferences.textAlign === 'start'} onClick={() => update({ textAlign: 'start' })}>自然对齐</button>
            <button type="button" aria-label="两端对齐" aria-pressed={preferences.textAlign === 'justify'} onClick={() => update({ textAlign: 'justify' })}>两端对齐</button>
          </div>
        </fieldset>
        <div className="nr-toggle-setting"><div><strong>代码自动换行</strong><small>长代码在当前栏宽内折行。</small></div>
          <button type="button" className="nr-switch" role="switch" aria-label="代码自动换行" aria-checked={preferences.codeWrap}
            onClick={() => update({ codeWrap: !preferences.codeWrap })}><span aria-hidden="true"/></button>
        </div>
        <div className="nr-settings-divider"/>
        <fieldset className="nr-setting">
          <legend>双语译文样式</legend><div className="nr-choice-row nr-translation-choices">
            {([['line', '边线对照'], ['card', '卡片对照'], ['plain', '简洁对照']] as const).map(([translationStyle, label]) => <button type="button" key={translationStyle}
              aria-label={label} aria-pressed={preferences.translationStyle === translationStyle}
              onClick={() => update({ translationStyle })}><span className="nr-translation-sample" data-style={translationStyle} aria-hidden="true"/>{label}</button>)}
          </div>
        </fieldset>
        <RangeSetting label="译文字号" name="阅读译文字号比例" value={preferences.translationScale} min={0.8} max={1.2} step={0.05}
          display={`${Math.round(preferences.translationScale * 100)}%`} onChange={translationScale => update({ translationScale })}/>
        <p className="nr-setting-hint">按核对需要调整译文大小。只改变显示，不会重新请求翻译。</p>
      </div>
    </details>

    <div className="nr-focus-setting">
      <div><strong>段落专注</strong><small>突出当前段落，跟随阅读。</small></div>
      <button type="button" className="nr-switch" role="switch" aria-label="段落专注" aria-checked={preferences.focus}
        onClick={() => update({ focus: !preferences.focus })}><span aria-hidden="true"/></button>
    </div>

    <section className="nr-personal-style" aria-label="我的样式">
      <div className="nr-personal-heading"><strong>我的样式</strong><span>{matchesSaved ? '与当前一致' : saved ? '已保存一套样式' : '留住最适合你的设置'}</span></div>
      <div className="nr-personal-actions">
        <button type="button" className="nr-secondary-button" onClick={() => props.onPreferences({ ...preferences, savedStyle: readingStyle(preferences) })}>保存为我的样式</button>
        <button type="button" className="nr-secondary-button" disabled={!saved} onClick={() => { if (saved) update(saved); }}>应用我的样式</button>
      </div>
      <p className="nr-setting-hint">仅保存外观，不包含文章和翻译内容。</p>
      <div className="nr-style-files">
        <button type="button" className="nr-text-button" onClick={exportStyle}>导出版式</button>
        <span aria-hidden="true">·</span>
        <button type="button" className="nr-text-button" onClick={() => fileInput.current?.click()}>导入版式</button>
        <input ref={fileInput} type="file" accept=".json,application/json" aria-label="导入阅读版式文件" hidden
          onChange={event => { void importStyle(event.currentTarget); }}/>
      </div>
      {fileFeedback && <p className="nr-file-feedback" data-tone={fileFeedback.kind} role="status">{fileFeedback.message}</p>}

    </section>

    <div className="nr-settings-actions">
      <button type="button" className="nr-text-button" onClick={() => props.onResetPreferences ? props.onResetPreferences()
        : update(readingStyle({ ...DEFAULT_READING_PREFERENCES }))}>恢复默认</button>
      <button type="button" className="nr-text-button" disabled={!props.canUndoPreferences} onClick={props.onUndoPreferences}>撤销上次调整</button>
    </div>
    <div className="nr-save-status" data-status={status}>
      <p role="status" aria-live="polite"><span className="nr-save-dot" aria-hidden="true"/>
        {status === 'saving' ? '正在保存显示偏好…' : status === 'saved' ? '显示偏好已自动保存' : status === 'error' ? '显示偏好保存失败' : '显示偏好会自动保存'}</p>
      {status === 'error' ? <><span>当前预览仍保留，重试后下次阅读也能使用。</span>
        <button type="button" className="nr-secondary-button" onClick={props.onRetryPreferences}>重试保存显示偏好</button></> : <span>下次阅读，依旧合眼。</span>}
    </div>
  </div>;
}
