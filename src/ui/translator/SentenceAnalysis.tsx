import type { GrammarCategory, SentenceAnalysis, TranslationError } from '../../shared/contracts';
import { normalizeGrammarCategory } from '../../core/sentence-analysis';
import { GRAMMAR_LABELS, type SentenceHighlight } from './sentence-highlights';

export interface SentenceAnalysisView {
  status: 'loading' | 'done' | 'error';
  result?: SentenceAnalysis;
  error?: TranslationError;
}

/** Sentence structure is supplemental: the translation above remains readable and copyable. */
export function SentenceAnalysisPanel({ view, onRetry, highlights, activeChunk, onSelectChunk }: {
  view: SentenceAnalysisView;
  onRetry: () => void;
  highlights?: SentenceHighlight[];
  activeChunk?: number;
  onSelectChunk: (index: number) => void;
}) {
  const result = view.status === 'done' ? view.result : undefined;
  const categories: GrammarCategory[] = ['subject', 'predicate', 'object', 'clause', 'modifier', 'other'];
  return <details className="nt-analysis" open>
    <summary>
      <span className="nt-analysis-title">长难句拆解</span>
      <span className="nt-analysis-badge">句法参考</span>
    </summary>
    <div className="nt-analysis-content" aria-busy={view.status === 'loading'}>
      {view.status === 'loading' && <p className="nt-analysis-loading"><span className="nt-dot" />正在拆解句子…</p>}
      {view.status === 'error' && <div className="nt-analysis-failure">
        <p className="nt-analysis-failure-title">拆解暂未完成</p>
        <p className="nt-analysis-note">{view.error?.message ?? '稍后可重试拆解，当前译文仍可阅读。'}</p>
        {view.error?.retryable && <button type="button" className="nt-action" onClick={onRetry}>重试拆解</button>}
      </div>}
      {result && <>
        <div className="nt-analysis-legend" aria-label="语法颜色图例">
          {categories.map(category => <span key={category} className="nt-analysis-legend-item nt-grammar-category"
            data-category={category}>{GRAMMAR_LABELS[category]}</span>)}
        </div>
        {Boolean(highlights?.length) && <p className="nt-analysis-link-hint">点击原句或分块，对照相应成分。</p>}
        <section className="nt-analysis-main" aria-label="句子主干">
          <h2 className="nt-analysis-heading">句子主干</h2>
          <p className="nt-analysis-english" lang="en">{result.mainClause.text}</p>
          <p className="nt-analysis-meaning">{result.mainClause.translation}</p>
          <p className="nt-analysis-note">{result.mainClause.explanation}</p>
        </section>
        <section className="nt-analysis-chunks" aria-label="分块阅读">
          <h2 className="nt-analysis-heading">分块阅读</h2>
          <ol className="nt-analysis-list">{result.chunks.map((chunk, index) => {
            const highlight = highlights?.find(item => item.index === index);
            const category = highlight?.category ?? normalizeGrammarCategory(chunk.role, chunk.category);
            const active = activeChunk === index && Boolean(highlight);
            const content = <>
              <span className="nt-analysis-chunk-header">
                <span className="nt-analysis-number" aria-hidden="true">{index + 1}</span>
                <span className="nt-analysis-role">{chunk.role}</span>
              </span>
              <span className="nt-analysis-english" lang="en">{chunk.text}</span>
              <span className="nt-analysis-note">{chunk.explanation}</span>
            </>;
            return <li className="nt-analysis-chunk nt-grammar-category" key={index}
              data-analysis-chunk={index} data-category={category} data-active={active ? 'true' : 'false'}>
              {highlight ? <button type="button" className="nt-analysis-chunk-target" data-analysis-chunk={index}
                aria-label={`定位原句分块 ${index + 1}：${chunk.role}`} aria-pressed={active}
                onPointerDown={event => event.preventDefault()} onClick={() => onSelectChunk(index)}>{content}</button>
                : <div className="nt-analysis-chunk-target">{content}</div>}
            </li>;
          })}</ol>
        </section>
        <section className="nt-analysis-guide" aria-label="阅读顺序">
          <h2 className="nt-analysis-heading">阅读顺序</h2>
          <p className="nt-analysis-note">{result.readingGuide}</p>
        </section>
      </>}
    </div>
  </details>;
}

export const sentenceAnalysisStyles = `
.nt-analysis { margin-top: 18px; padding-top: 15px; border-top: 1px solid #dfe8de; color: #345247; }
.nt-analysis > summary { display: flex; align-items: center; gap: 7px; cursor: pointer; list-style: none; border-radius: 5px; }
.nt-analysis > summary::-webkit-details-marker { display: none; }
.nt-analysis > summary::before { content: ''; width: 6px; height: 6px; border-right: 1.5px solid #527467; border-bottom: 1.5px solid #527467; transform: rotate(-45deg); flex-shrink: 0; margin-right: 3px; }
.nt-analysis[open] > summary::before { transform: rotate(45deg); margin-top: -3px; }
.nt-analysis > summary:focus-visible { outline: 3px solid #79a79d; outline-offset: 4px; }
.nt-analysis-title { font-size: 13px; font-weight: 700; color: #244f3f; }
.nt-analysis-badge { font-size: 10px; color: #6d8577; margin-left: auto; white-space: nowrap; font-weight: 400; }
.nt-analysis-content { margin-top: 13px; min-width: 0; }
.nt-analysis-legend { display: flex; flex-wrap: wrap; gap: 5px; margin: 0 0 9px; }
.nt-analysis-legend-item { display: inline-block; color: var(--nt-grammar-color); background: var(--nt-grammar-bg); border-radius: 5px; padding: 2px 6px; font-size: 10px; line-height: 1.6; }
.nt-analysis-link-hint { margin: 0 0 12px; color: #748677; font-size: 11px; line-height: 1.6; }
.nt-analysis-loading { display: flex; align-items: center; gap: 8px; margin: 0; color: #647c6e; font-size: 12px; }
.nt-analysis-heading { margin: 0 0 8px; font-size: 12px; line-height: 1.5; color: #486c5b; font-weight: 650; }
.nt-analysis-main { border: 1px solid #dce8de; border-radius: 9px; background: #f0f6ee; padding: 11px 12px; }
.nt-analysis-english { margin: 0; color: #244d3e; font-size: 13px; font-weight: 550; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
.nt-analysis-meaning { margin: 6px 0 0; color: #345545; font-size: 13px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
.nt-analysis-note { margin: 6px 0 0; color: #687f71; font-size: 12px; line-height: 1.75; white-space: pre-wrap; overflow-wrap: anywhere; }
.nt-analysis-chunks { margin-top: 16px; }
.nt-analysis-list { margin: 0; padding: 0; list-style: none; }
.nt-analysis-chunk { margin: 0; padding: 10px 0 11px; border-bottom: 1px solid #e7ede5; min-width: 0; }
.nt-analysis-chunk:first-child { padding-top: 1px; }
.nt-analysis-chunk:last-child { border-bottom: 0; padding-bottom: 0; }
.nt-analysis-chunk[data-active="true"] { outline: 2px solid var(--nt-grammar-color); outline-offset: 2px; border-radius: 7px; }
.nt-analysis-chunk-target { display: block; width: 100%; padding: 3px 5px; border: 0; border-radius: 6px; background: transparent; color: inherit; text-align: left; min-width: 0; }
button.nt-analysis-chunk-target:hover { background: #f1f6ef; }
button.nt-analysis-chunk-target:focus-visible { outline: 2px solid var(--nt-grammar-color); outline-offset: 2px; }
.nt-analysis-chunk-header { display: flex; align-items: flex-start; gap: 7px; margin-bottom: 6px; }
.nt-analysis-number { display: inline-grid; place-items: center; flex-shrink: 0; width: 18px; height: 18px; border-radius: 5px; color: var(--nt-grammar-color); background: var(--nt-grammar-bg); font-size: 10px; line-height: 1; }
.nt-analysis-role { font-size: 11px; line-height: 18px; color: var(--nt-grammar-color); background: var(--nt-grammar-bg); padding: 0 5px; border-radius: 4px; font-weight: 600; white-space: pre-wrap; overflow-wrap: anywhere; min-width: 0; }
.nt-analysis-chunk .nt-analysis-english, .nt-analysis-chunk .nt-analysis-note { display: block; margin-left: 25px; }
.nt-analysis-chunk .nt-analysis-english { color: var(--nt-grammar-color); background: var(--nt-grammar-bg); border-radius: 4px; padding: 3px 5px; }
.nt-analysis-guide { margin-top: 15px; padding-top: 12px; border-top: 1px solid #dfe8de; }
.nt-analysis-guide > .nt-analysis-note { margin-top: 0; }
.nt-analysis-failure { padding: 10px 12px; border: 1px solid #eadfce; border-radius: 9px; background: #fbf8f0; }
.nt-analysis-failure-title { margin: 0; color: #806143; font-size: 12px; font-weight: 600; }
.nt-analysis-failure > .nt-action { margin-top: 9px; }
`;
