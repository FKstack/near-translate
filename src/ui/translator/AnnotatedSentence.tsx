import type { ReactNode } from 'react';
import type { SentenceHighlight } from './sentence-highlights';

/** Render only slices of the original selection, retaining its exact whitespace and punctuation. */
export function AnnotatedSentence({ source, highlights, activeChunk, onSelectChunk }: {
  source: string;
  highlights?: SentenceHighlight[];
  activeChunk?: number;
  onSelectChunk: (index: number) => void;
}) {
  const pieces: ReactNode[] = [];
  let cursor = 0;
  for (const highlight of highlights ?? []) {
    if (highlight.start > cursor) pieces.push(source.slice(cursor, highlight.start));
    pieces.push(<mark key={highlight.index} className="nt-source-mark nt-grammar-category"
      data-analysis-chunk={highlight.index} data-category={highlight.category}
      data-active={activeChunk === highlight.index ? 'true' : 'false'}
      role="button" tabIndex={0} aria-pressed={activeChunk === highlight.index}
      aria-label={`定位分块 ${highlight.index + 1}，${highlight.label}：${highlight.text}`}
      title={`${highlight.label} · 点击定位分块 ${highlight.index + 1}`}
      onPointerDown={event => event.preventDefault()}
      onClick={() => onSelectChunk(highlight.index)}
      onKeyDown={event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onSelectChunk(highlight.index);
      }}>{source.slice(highlight.start, highlight.end)}</mark>);
    cursor = highlight.end;
  }
  if (cursor < source.length) pieces.push(source.slice(cursor));
  return <p className={`nt-source${highlights?.length ? ' nt-source-analyzed' : ''}`} title={source} dir="auto">
    {highlights?.length ? pieces : source}
  </p>;
}

export const annotatedSentenceStyles = `
.nt-grammar-category { --nt-grammar-color: #59656d; --nt-grammar-bg: #edf0f2; }
.nt-grammar-category[data-category="subject"] { --nt-grammar-color: #2357a5; --nt-grammar-bg: #e8f0ff; }
.nt-grammar-category[data-category="predicate"] { --nt-grammar-color: #b43837; --nt-grammar-bg: #fdeceb; }
.nt-grammar-category[data-category="object"] { --nt-grammar-color: #8a500a; --nt-grammar-bg: #fff0d9; }
.nt-grammar-category[data-category="clause"] { --nt-grammar-color: #7040a4; --nt-grammar-bg: #f2eaff; }
.nt-grammar-category[data-category="modifier"] { --nt-grammar-color: #176c61; --nt-grammar-bg: #e5f4ef; }
.nt-source-analyzed { position: sticky; top: 0; z-index: 1; max-height: min(160px, 30vh); margin-bottom: 13px; padding: 10px; border: 1px solid #dae6dc; border-radius: 8px; background: #fbfdfb; font-size: 12px; line-height: 1.95; color: #75847a; box-shadow: 0 3px 9px #fbfdfbe6; }
.nt-source-mark { display: inline; background: var(--nt-grammar-bg); color: var(--nt-grammar-color); border-radius: 3px; padding: 1px 0; cursor: pointer; -webkit-box-decoration-break: clone; box-decoration-break: clone; }
.nt-source-mark:hover { box-shadow: 0 0 0 1px var(--nt-grammar-color); }
.nt-source-mark[data-active="true"], .nt-source-mark:focus-visible { outline: 2px solid var(--nt-grammar-color); outline-offset: 1px; }
`;
