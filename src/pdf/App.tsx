import { useEffect, useRef, useState, type FormEvent } from 'react';
import { browser } from 'wxt/browser';
import { mountSelectionTranslator } from '@/selection/mount';
import { INITIAL_READER_STATE, PdfReaderController, type ReaderState } from './controller';

const initialUrl = () => new URLSearchParams(window.location.search).get('url') || '';
const scaleOptions = ['page-width', 'page-fit', '0.5', '0.75', '1', '1.25', '1.5', '2'];

export function PdfReaderApp() {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<PdfReaderController | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<ReaderState>(INITIAL_READER_STATE);
  const [url, setUrl] = useState(initialUrl);
  const [query, setQuery] = useState('');
  const [pageInput, setPageInput] = useState('1');
  const [password, setPassword] = useState('');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;
    let stopTranslation: (() => void) | undefined;
    let controller: PdfReaderController | undefined;
    const resetTranslation = () => {
      stopTranslation?.();
      if (active) stopTranslation = mountSelectionTranslator({ source: 'pdf', root: containerRef.current! });
    };
    void PdfReaderController.create(containerRef.current!, viewerRef.current!, (next) => {
      if (active) setState(next);
    }, resetTranslation).then(async (created) => {
      controller = created;
      if (!active) { await created.destroy(); return; }
      controllerRef.current = created;
      stopTranslation = mountSelectionTranslator({ source: 'pdf', root: containerRef.current! });
      setReady(true);
      const source = initialUrl();
      if (source) await created.openRemote(source, false);
    }).catch((error: unknown) => {
      if (active) setState((current) => ({ ...current, error: `阅读器初始化失败：${error instanceof Error ? error.message : String(error)}` }));
    });
    const stop = () => {
      stopTranslation?.();
      void controller?.destroy();
    };
    window.addEventListener('pagehide', stop);
    return () => {
      active = false;
      window.removeEventListener('pagehide', stop);
      stop();
      controllerRef.current = null;
    };
  }, []);

  useEffect(() => { setPageInput(String(state.page)); }, [state.page]);
  useEffect(() => { setPassword(''); }, [state.password]);

  const openRemote = (event: FormEvent) => {
    event.preventDefault();
    setQuery('');
    void controllerRef.current?.openRemote(url, true);
  };
  const goToPage = (event: FormEvent) => {
    event.preventDefault();
    controllerRef.current?.goToPage(Number(pageInput));
    setPageInput(String(state.page));
  };
  const search = (event: FormEvent) => {
    event.preventDefault();
    controllerRef.current?.find(query, false, true);
  };
  const submitPassword = (event: FormEvent) => {
    event.preventDefault();
    controllerRef.current?.submitPassword(password);
    setPassword('');
  };
  const scaleIsPreset = scaleOptions.includes(state.scale);
  const currentScaleLabel = `${Math.round(Number(state.scale) * 100)}%`;

  return (
    <main className="reader-app">
      <header className="reader-toolbar">
        <div className="reader-topline">
          <div className="reader-brand"><span className="reader-brand-icon">译</span><div><strong>近译</strong><span>PDF 阅读器</span></div></div>
          <div className="reader-file-name" title={state.filename}>{state.filename || '阅读文档，从选中开始'}</div>
          <button type="button" className="reader-settings" onClick={() => void browser.tabs.create({ url: browser.runtime.getURL('/convert.html') })}>文档转换</button>
          <button type="button" className="reader-settings" onClick={() => void browser.runtime.openOptionsPage()}>翻译设置</button>
        </div>
        <div className="reader-open-row">
          <input ref={fileRef} type="file" accept="application/pdf,.pdf" hidden aria-label="选择本地 PDF 文件"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) { setQuery(''); void controllerRef.current?.openLocal(file); }
              event.target.value = '';
            }} />
          <button type="button" className="reader-primary" disabled={!ready} onClick={() => fileRef.current?.click()}>打开本地 PDF</button>
          <form className="reader-url-form" onSubmit={openRemote}>
            <label className="reader-sr-only" htmlFor="pdf-url">在线 PDF 地址</label>
            <input id="pdf-url" type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="粘贴在线 PDF 地址（https://…）" required />
            <button type="submit" disabled={!ready || !url.trim()}>打开在线 PDF</button>
          </form>
        </div>
        <div className="reader-control-row">
          <form className="reader-page-controls" onSubmit={goToPage}>
            <button type="button" aria-label="上一页" disabled={!state.pages || state.page <= 1} onClick={() => controllerRef.current?.goToPage(state.page - 1)}>‹</button>
            <label className="reader-sr-only" htmlFor="pdf-page">页码</label>
            <input id="pdf-page" type="number" min="1" max={state.pages || 1} value={pageInput} disabled={!state.pages} onChange={(event) => setPageInput(event.target.value)} onBlur={() => { controllerRef.current?.goToPage(Number(pageInput)); }} />
            <span>/ {state.pages || '—'}</span>
            <button type="button" aria-label="下一页" disabled={!state.pages || state.page >= state.pages} onClick={() => controllerRef.current?.goToPage(state.page + 1)}>›</button>
          </form>
          <label className="reader-zoom-label">缩放
            <select aria-label="PDF 缩放" value={state.scale} disabled={!state.pages} onChange={(event) => controllerRef.current?.setScale(event.target.value)}>
              <option value="page-width">适合宽度</option><option value="page-fit">适合页面</option>
              {scaleOptions.slice(2).map((scale) => <option key={scale} value={scale}>{Math.round(Number(scale) * 100)}%</option>)}
              {!scaleIsPreset && <option value={state.scale}>{currentScaleLabel}</option>}
            </select>
          </label>
          <form className="reader-search" onSubmit={search}>
            <label className="reader-sr-only" htmlFor="pdf-search">搜索文档</label>
            <input id="pdf-search" type="search" value={query} disabled={!state.pages} placeholder="搜索文档文字" onChange={(event) => {
              setQuery(event.target.value);
              controllerRef.current?.find(event.target.value);
            }} />
            <button type="button" aria-label="上一个匹配" disabled={!state.pages || !query} onClick={() => controllerRef.current?.find(query, true, true)}>↑</button>
            <button type="submit" aria-label="下一个匹配" disabled={!state.pages || !query}>↓</button>
            <span className="reader-match-count" aria-live="polite">{query ? state.searchState === 'searching' ? '搜索中…' : state.searchState === 'not-found' ? '无匹配' : `${state.matches.current} / ${state.matches.total}` : ''}</span>
          </form>
        </div>
      </header>

      <section className="reader-stage" aria-label="PDF 文档">
        <div ref={containerRef} id="viewerContainer" className="reader-viewer-container" tabIndex={0}>
          <div ref={viewerRef} id="viewer" className="pdfViewer" />
        </div>
        {!state.pages && !state.loading && !state.error && <div className="reader-welcome">
          <span className="reader-welcome-mark">PDF</span>
          <h1>把文档，读得更明白</h1>
          <p>打开 PDF，双击单词或拖选句段。<br />点击选区旁的“译”，查看译文。</p>
          <button type="button" className="reader-primary" disabled={!ready} onClick={() => fileRef.current?.click()}>选择本地 PDF</button>
          <small>文件在本地解析；点击翻译后才发送所选文字。</small>
        </div>}
        {state.loading && <div className="reader-notice reader-loading" role="status">
          <span className="reader-spinner" />正在加载 PDF{state.progress !== null ? ` · ${state.progress}%` : '…'}
          <button type="button" onClick={() => void controllerRef.current?.cancel()}>取消</button>
        </div>}
        {state.error && <div className={`reader-notice reader-error${state.needsPermission ? ' reader-permission' : ''}`} role="alert">
          <span>{state.error}</span>
          <button type="button" onClick={() => fileRef.current?.click()}>打开本地 PDF</button>
        </div>}
        {state.pages > 0 && state.noText && <div className="reader-notice reader-no-text" role="status">当前页没有可选文字，暂不支持 OCR。可切换到含文字的页面后划词翻译。</div>}
      </section>
      <footer className="reader-footer">双击单词 / 拖选句段 → 点击“译”<span>翻译语言沿用设置</span></footer>

      {state.password && <div className="reader-modal-backdrop">
        <form className="reader-password-dialog" role="dialog" aria-modal="true" aria-labelledby="password-title" onSubmit={submitPassword}>
          <h2 id="password-title">解锁 PDF</h2>
          <p>{state.password === 'incorrect' ? '密码不正确，请再试一次。' : '这个 PDF 受密码保护，请输入打开密码。'}</p>
          <label htmlFor="pdf-password">PDF 密码</label>
          <input id="pdf-password" type="password" value={password} autoFocus autoComplete="off" onChange={(event) => setPassword(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') void controllerRef.current?.cancel(); }} />
          <div className="reader-dialog-actions"><button type="button" onClick={() => void controllerRef.current?.cancel()}>取消</button><button type="submit" className="reader-primary">解锁</button></div>
        </form>
      </div>}
    </main>
  );
}
