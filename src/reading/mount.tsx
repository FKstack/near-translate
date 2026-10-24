import { createRoot, type Root } from 'react-dom/client';
import { browser } from 'wxt/browser';
import type { PublicSettings, TranslationServiceStatus, TranslationStatusSource } from '../shared/contracts';
import { applyReadingStyle, DEFAULT_READING_PREFERENCES, normalizeReadingPreferences, readingStyle, type ReadingPreferences, type ReadingStyle } from '../shared/reading';
import { pageExecutionPolicy } from '../shared/translation-policy';
import { extractReadingArticle } from './extract';
import { ReadingView } from './ReadingView';
import { readingStyles } from './styles';
import { ReadingTranslation } from './translation';
import type { ReadingArticle } from './types';
import { readLanguagePair, languageFromTag } from '../shared/languages';
import { beforeUserAction, type BeforeUse } from '../shared/before-use';

export interface ReadingModeController {
  open(translations?: ReadonlyMap<string, string>): void;
  close(): void;
  dispose(): void;
}

interface ReadingLayoutAnchor {
  element: HTMLElement;
  /** Preserve a reading point inside a long paragraph when its lines reflow. */
  fraction: number;
  screenY: number;
  /** Clearing translations preserves the source block's top even when it begins above the viewport. */
  sourceTop?: true;
  generation: number;
}

interface ReadingAppearanceSnapshot { style: ReadingStyle; savedStyle: ReadingStyle | null }

/** One document owns a reversible reading surface, source references and all reader requests. */
export function createReadingMode(options: { onSelectionPortal?: (portal?: HTMLElement) => void; serviceStatus?: TranslationStatusSource; beforeUse?: BeforeUse } = {}): ReadingModeController {
  let disposed = false;
  let host: HTMLElement | undefined;
  let dialog: HTMLDialogElement | undefined;
  let react: Root | undefined;
  let article: ReadingArticle | undefined;
  let translation: ReadingTranslation | undefined;
  let articleMount: HTMLDivElement | undefined;
  let scroll: HTMLDivElement | undefined;
  let preferences: ReadingPreferences = { ...DEFAULT_READING_PREFERENCES };
  let preferencesChanged = false;
  let preferencesStatus: 'idle' | 'saving' | 'saved' | 'error' = 'idle';
  let preferencesRevision = 0;
  let pendingPreferences: { revision: number; preferences: ReadingPreferences } | undefined;
  let previousAppearance: ReadingAppearanceSnapshot | undefined;
  let lastAdjustment = '';
  let pendingLayoutAnchor: ReadingLayoutAnchor | undefined;
  let measuredLayoutAnchor: ReadingLayoutAnchor | undefined;
  let publicSettings: PublicSettings | undefined;
  let serviceStatus: TranslationServiceStatus | undefined;
  let initialSeed = new Map<string, string>();
  let openedUrl = '';
  let progress = 0;
  let activeHeading = '';
  let currentSource = '';
  let position = { url: '', source: '', ratio: 0 };
  let retained = new Map<string, string>();
  let notice = '';
  let extractionError = '';
  let generation = 0;
  let frame: number | undefined;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let navigationTimer: ReturnType<typeof setInterval> | undefined;
  let previousFocus: HTMLElement | undefined;
  let originalScroll = { x: 0, y: 0 };
  let layoutState = '';
  let printStyle: HTMLStyleElement | undefined;
  let sourceBlocks: HTMLElement[] = [];
  let headingElements: Array<{ id: string; element: HTMLElement }> = [];
  let focusedBlock: HTMLElement | undefined;
  let openedAt = 0;
  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function render(): void {
    if (!react || disposed) return;
    if (!article) {
      react.render(<section className="nr-failure" role="alert"><span className="nr-failure-brand">近译 · 阅读</span>
        <h1>这页暂时无法进入阅读模式</h1><p>{extractionError}</p><p>请打开文章详情页，或等待正文加载完成后重试。</p>
        <button type="button" onClick={() => close()}>返回原网页</button><button type="button" onClick={() => beforeUserAction(options.beforeUse, () => { close(); open(); })}>重新提取正文</button></section>);
      return;
    }
    react.render(<ReadingView article={article} preferences={preferences}
      translation={translation?.state ?? { status: 'idle', total: 0, completed: 0, failed: 0, pending: 0 }}
      notice={notice} progress={progress} activeHeading={activeHeading}
      articleRef={attachArticle} scrollRef={attachScroll} onPreferences={updatePreferences}
      preferencesStatus={preferencesStatus} onRetryPreferences={retryPreferences} onResetPreferences={resetPreferences}
      onUndoPreferences={undoPreferences} canUndoPreferences={!!previousAppearance} onLayoutCommit={onLayoutCommit}
      onClose={() => close()} onTranslate={() => beforeUserAction(options.beforeUse, startTranslation)} onStop={() => translation?.stop()}
      onRetry={() => beforeUserAction(options.beforeUse, () => { if (disposed || !dialog) return; notice = ''; translation?.retry(); render(); })}
      serviceStatus={serviceStatus} onSettings={() => { void browser.runtime.sendMessage({ type: 'open-options' }).catch(() => {}); }}
      onHeading={goToHeading} onReturnToSource={returnToSource} />);
  }

  function attachArticle(node: HTMLDivElement | null): void {
    if (!node || articleMount === node || !article) return;
    articleMount = node;
    article.content.lang = article.lang;
    article.content.dir = languageFromTag(article.lang) === 'ar' ? 'rtl' : 'auto';
    node.append(article.content);
    for (const image of article.content.querySelectorAll<HTMLImageElement>('img[data-near-reader-image-src]')) {
      image.src = image.dataset.nearReaderImageSrc!;
      image.removeAttribute('data-near-reader-image-src');
    }
    sourceBlocks = [...article.content.querySelectorAll<HTMLElement>('[data-near-reader-source]')];
    headingElements = [...article.content.querySelectorAll<HTMLElement>('h2[id],h3[id],h4[id],h5[id],h6[id]')]
      .map(element => ({ id: element.id, element }));
    const seed = new Map(retained);
    for (const block of sourceBlocks) {
        const id = block.dataset.nearReaderSource!;
        if (!article.sourceMap.get(id)?.isConnected) continue;
        if (!block.matches('p,h2,h3,h4,h5,h6,pre,blockquote,figcaption')) continue;
        if (/^H[2-6]$/.test(block.tagName)) {
          const clean = (block.textContent ?? '').replace(/\s+/g, ' ').trim();
          block.setAttribute('aria-label', clean);
          // A removed heading permalink is presentation, not a reason to pay for the same heading again.
          const original = (article.sourceMap.get(id)?.textContent ?? '').replace(/\s+/g, ' ').trim();
          const glyph = original.slice(-1);
          const cached = retained.get(original);
          if (cached !== undefined && /^[¶§#]$/.test(glyph) && original.slice(0, -1).trim() === clean) {
            seed.set(clean, !clean.endsWith(glyph) && cached.endsWith(glyph) ? cached.slice(0, -1).trim() : cached);
          }
        }
        const button = document.createElement('button');
        button.type = 'button'; button.setAttribute('data-near-reader-source-action', id);
        button.setAttribute('aria-label', '回到原文位置'); button.title = '回到原文位置';
        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        icon.setAttribute('viewBox', '0 0 20 20'); icon.setAttribute('width', '14'); icon.setAttribute('height', '14');
        icon.setAttribute('aria-hidden', 'true');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M5 15 15 5M6 5h9v9'); path.setAttribute('fill', 'none');
        path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '1.4');
        icon.append(path); button.append(icon);
        block.append(button);
    }
    initialSeed = seed;
    initializeTranslation();
    if (host) host.dataset.readyMs = (performance.now() - openedAt).toFixed(1);
    render();
    const owner = generation;
    requestAnimationFrame(() => {
      if (!dialog || generation !== owner || !scroll || !article) return;
      if (host) host.dataset.readyFrameMs = (performance.now() - openedAt).toFixed(1);
      scroll.focus({ preventScroll: true });
      if (position.url === openedUrl && position.source) {
        const target = article.content.querySelector<HTMLElement>(`[data-near-reader-source="${position.source}"]`);
        if (target) target.scrollIntoView({ block: 'start', behavior: 'instant' });
        else scroll.scrollTo({ top: position.ratio * Math.max(0, scroll.scrollHeight - scroll.clientHeight), behavior: 'instant' });
      } else if (originalScroll.y > 80) {
        // Resume from the paragraph the user was reading before entering the surface.
        let closest: { id: string; distance: number } | undefined;
        for (const [id, source] of article.sourceMap) {
          const box = source.getBoundingClientRect();
          if (!box.height || !source.matches('p,h2,h3,h4,h5,h6,pre')) continue;
          const distance = Math.abs(box.top - 100);
          if (!closest || distance < closest.distance) closest = { id, distance };
        }
        article.content.querySelector<HTMLElement>(`[data-near-reader-source="${closest?.id ?? ''}"]`)?.scrollIntoView({ block: 'start', behavior: 'instant' });
      }
      scheduleMeasure();
    });
  }

  function initializeTranslation(): void {
    if (!article || !articleMount || !publicSettings || translation || disposed) return;
    translation = new ReadingTranslation(article.content, initialSeed, state => {
      if (state.error?.code === 'RATE_LIMIT') options.serviceStatus?.refresh();
      render();
      const nextLayout = `${state.completed}:${state.failed}`;
      if (nextLayout !== layoutState) { layoutState = nextLayout; scheduleMeasure(); }
    }, readLanguagePair(publicSettings));
    initialSeed.clear();
  }

  function attachScroll(node: HTMLDivElement | null): void {
    if (scroll === node) return;
    scroll?.removeEventListener('scroll', scheduleMeasure);
    scroll = node ?? undefined;
    if (scroll) { scroll.tabIndex = 0; scroll.setAttribute('aria-label', '文章正文阅读区'); }
    scroll?.addEventListener('scroll', scheduleMeasure, { passive: true });
  }

  function measure(): void {
    frame = undefined;
    if (!dialog || !scroll || !article || disposed) return;
    if (location.href !== openedUrl) { close(true); return; }
    const extent = scroll.scrollHeight - scroll.clientHeight;
    const previousPercent = Math.round(progress * 100);
    const previousHeading = activeHeading;
    progress = extent > 0 ? Math.min(1, Math.max(0, scroll.scrollTop / extent)) : 1;
    const top = scroll.getBoundingClientRect().top + 150;
    let active: HTMLElement | undefined;
    for (const block of sourceBlocks) {
      const box = block.getBoundingClientRect();
      if (!box.height || block.matches('article,main,section,div,table,figure')) continue;
      if (!active || box.top <= top) active = block;
      if (box.top > top) break;
    }
    currentSource = active?.dataset.nearReaderSource ?? currentSource;
    if (focusedBlock !== active) {
      focusedBlock?.removeAttribute('data-near-reader-focused');
      if (active) active.dataset.nearReaderFocused = 'true';
      focusedBlock = active;
    }
    activeHeading = '';
    for (const heading of headingElements) {
      if (heading.element.getBoundingClientRect().top <= top) activeHeading = heading.id;
      else break;
    }
    translation?.refreshViewport();
    measuredLayoutAnchor = captureLayoutAnchor();
    if (previousPercent !== Math.round(progress * 100) || previousHeading !== activeHeading) render();
  }

  function scheduleMeasure(): void {
    if (frame === undefined && dialog && !disposed) frame = requestAnimationFrame(measure);
  }

  function captureLayoutAnchor(): ReadingLayoutAnchor | undefined {
    if (!scroll || !article || !dialog) return;
    const viewport = scroll.getBoundingClientRect();
    const readingLine = viewport.top + Math.min(150, Math.max(0, viewport.height / 4));
    let candidate: HTMLElement | undefined;
    for (const block of sourceBlocks) {
      if (block.matches('article,main,section,div,table,figure')) continue;
      const box = block.getBoundingClientRect();
      if (!box.height) continue;
      candidate = block;
      if (box.bottom >= readingLine) break;
    }
    if (!candidate) return;
    const box = candidate.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (readingLine - box.top) / box.height));
    return { element: candidate, fraction, screenY: box.top + box.height * fraction, generation };
  }

  function captureSourceTopAnchor(): ReadingLayoutAnchor | undefined {
    if (!scroll || !article || !dialog) return;
    const candidate = focusedBlock && article.content.contains(focusedBlock) ? focusedBlock
      : sourceBlocks.find(block => block.dataset.nearReaderSource === currentSource);
    if (!candidate) return captureLayoutAnchor();
    const box = candidate.getBoundingClientRect();
    if (!box.height) return captureLayoutAnchor();
    return { element: candidate, fraction: 0, screenY: box.top, sourceTop: true, generation };
  }

  function restoreLayoutAnchor(anchor: ReadingLayoutAnchor | undefined): void {
    if (!anchor || anchor.generation !== generation || !scroll || !article?.content.contains(anchor.element) || !anchor.element.isConnected) return;
    const box = anchor.element.getBoundingClientRect();
    if (!box.height) return;
    const viewport = scroll.getBoundingClientRect();
    const screenY = anchor.sourceTop ? anchor.screenY : Math.min(viewport.bottom, Math.max(viewport.top, anchor.screenY));
    const top = scroll.scrollTop + box.top + box.height * anchor.fraction - screenY;
    // Typography correction must finish before measuring, even when chapter navigation is smooth.
    scroll.scrollTo({ top, behavior: 'instant' });
  }

  /** Called by the view after React has applied typography and visibility changes. */
  function onLayoutCommit(): void {
    if (disposed || !dialog) return;
    const anchor = pendingLayoutAnchor ?? measuredLayoutAnchor;
    pendingLayoutAnchor = undefined;
    restoreLayoutAnchor(anchor);
    measuredLayoutAnchor = captureLayoutAnchor();
    scheduleMeasure();
  }

  function onResize(): void {
    if (disposed || !dialog) return;
    // Resize fires after the browser has laid out the new width; use the last reading point.
    restoreLayoutAnchor(pendingLayoutAnchor ?? measuredLayoutAnchor);
    measuredLayoutAnchor = captureLayoutAnchor();
    scheduleMeasure();
  }

  function appearanceSnapshot(value: ReadingPreferences): ReadingAppearanceSnapshot {
    const normalized = normalizeReadingPreferences(value);
    return { style: readingStyle(normalized), savedStyle: normalized.savedStyle };
  }

  function updatePreferences(next: ReadingPreferences, recordUndo = true, coalesce = true): void {
    if (disposed) return;
    const normalized = normalizeReadingPreferences(next);
    if (JSON.stringify(normalized) === JSON.stringify(preferences)) return;
    const before = appearanceSnapshot(preferences);
    const after = appearanceSnapshot(normalized);
    const changedKeys = Object.keys(after.style).filter(key => {
      const field = key as keyof ReadingStyle;
      return JSON.stringify(before.style[field]) !== JSON.stringify(after.style[field]);
    });
    if (JSON.stringify(before.savedStyle) !== JSON.stringify(after.savedStyle)) changedKeys.push('savedStyle');
    const adjustment = changedKeys.join(',');
    if (recordUndo && adjustment && (!coalesce || !saveTimer || lastAdjustment !== adjustment)) previousAppearance = before;
    lastAdjustment = adjustment;
    pendingLayoutAnchor ??= captureLayoutAnchor();
    preferences = normalized; preferencesChanged = true;
    preferencesStatus = 'saving';
    pendingPreferences = { revision: ++preferencesRevision, preferences: normalizeReadingPreferences(preferences) };
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushPreferences, 180);
    render();
  }

  function flushPreferences(): void {
    clearTimeout(saveTimer); saveTimer = undefined;
    const snapshot = pendingPreferences;
    if (!snapshot) return;
    pendingPreferences = undefined;
    const settled = (ok: boolean) => {
      if (disposed || snapshot.revision !== preferencesRevision) return;
      preferencesStatus = ok ? 'saved' : 'error';
      render();
    };
    try {
      void browser.runtime.sendMessage({ type: 'save-reading-preferences', preferences: snapshot.preferences })
        .then((response: { ok?: boolean } | undefined) => settled(response?.ok === true), () => settled(false));
    } catch { settled(false); }
  }

  function retryPreferences(): void {
    if (disposed || preferencesStatus !== 'error') return;
    preferencesStatus = 'saving';
    pendingPreferences = { revision: ++preferencesRevision, preferences: normalizeReadingPreferences(preferences) };
    render(); flushPreferences();
  }

  function resetPreferences(): void {
    updatePreferences(applyReadingStyle(preferences, readingStyle(DEFAULT_READING_PREFERENCES)), true, false);
    lastAdjustment = '';
  }

  function undoPreferences(): void {
    if (disposed || !previousAppearance) return;
    const target = previousAppearance;
    previousAppearance = appearanceSnapshot(preferences);
    updatePreferences({ ...applyReadingStyle(preferences, target.style), savedStyle: target.savedStyle }, false);
    lastAdjustment = '';
  }

  function startTranslation(): void {
    initializeTranslation();
    if (!article || !translation || disposed) return;
    if (!publicSettings) { notice = '正在读取翻译设置，请稍后再试。'; render(); return; }
    if (!publicSettings?.enabled || (!publicSettings.hasApiKey && publicSettings.requiresApiKey !== false) || publicSettings.apiAccess === false || !publicSettings.webAccess) {
      notice = '可以直接阅读原文；如需翻译，请在近译设置中启用网页及翻译服务。'; render(); return;
    }
    notice = '';
    if (!translation.state.total) { notice = '没有需要翻译的正文，请检查源语言与目标语言，或继续阅读原文。'; render(); return; }
    if (preferences.mode === 'original') updatePreferences({ ...preferences, mode: 'bilingual' });
    translation.start(pageExecutionPolicy(publicSettings.translationEngine));
    render();
  }

  function goToHeading(id: string): void {
    if (!article?.outline.some(item => item.id === id)) return;
    // Closing the mobile outline commits layout after navigation; discard its old reading point.
    pendingLayoutAnchor = undefined; measuredLayoutAnchor = undefined;
    article.content.querySelector<HTMLElement>(`#${id}`)?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
    activeHeading = id; render(); scheduleMeasure();
  }

  function returnToSource(id = currentSource): void {
    const source = article?.sourceMap.get(id);
    close();
    if (!source?.isConnected) return;
    source.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
    if (!reducedMotion()) source.animate?.([{ backgroundColor: '#c4e0b5aa' }, { backgroundColor: 'transparent' }], { duration: 1300 });
  }

  function onContentClick(event: MouseEvent): void {
    const fragment = (value: string) => { try { return decodeURIComponent(value); } catch { return value; } };
    const element = event.composedPath().find(node => node instanceof Element) as Element | undefined;
    const source = element?.closest<HTMLElement>('[data-near-reader-source-action]');
    if (source) { event.preventDefault(); returnToSource(source.dataset.nearReaderSourceAction); return; }
    const link = element?.closest<HTMLAnchorElement>('a[href]');
    if (!link || !article?.content.contains(link)) return;
    const href = link.getAttribute('href') ?? '';
    if (href.startsWith('#')) {
      event.preventDefault();
      article.content.querySelector<HTMLElement>(`#${CSS.escape(fragment(href.slice(1)))}`)
        ?.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
      return;
    }
    const url = new URL(link.href);
    const original = new URL(openedUrl);
    if (url.origin === original.origin && url.pathname === original.pathname && url.search === original.search && url.hash) {
      const target = article.content.querySelector<HTMLElement>(`#${CSS.escape(fragment(url.hash.slice(1)))}`);
      if (target) { event.preventDefault(); target.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' }); }
    }
  }

  function open(seed: ReadonlyMap<string, string> = new Map()): void {
    if (disposed) return;
    if (dialog) { (scroll ?? dialog).focus({ preventScroll: true }); return; }
    if (!/^https?:$/.test(location.protocol)) return;
    generation++;
    openedAt = performance.now();
    if (openedUrl !== location.href) { retained.clear(); position = { url: '', source: '', ratio: 0 }; }
    openedUrl = location.href;
    originalScroll = { x: window.scrollX, y: window.scrollY };
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    // Inputs come only from a local page session, already bounded and independent of service credentials.
    for (const [text, translated] of seed) retained.set(text, translated);
    while (retained.size > 1500) retained.delete(retained.keys().next().value!);
    host = document.createElement('near-reading-mode');
    host.style.cssText = 'all:initial!important;position:fixed!important;left:0!important;top:0!important;width:0!important;height:0!important;z-index:2147483647!important;';
    host.setAttribute('data-near-page-ui', ''); host.setAttribute('translate', 'no');
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = readingStyles + '\ndialog{position:fixed;inset:0;margin:0;padding:0;border:0;width:100vw;height:100vh;max-width:none;max-height:none;overflow:hidden;background:#f7f3e9}dialog::backdrop{background:#18241e80}.nr-failure{padding:10vh max(24px,calc((100vw - 700px)/2));font:17px/1.8 system-ui;color:#294c39}.nr-failure h1{font:600 32px/1.4 Georgia,serif}.nr-failure-brand{font-size:13px;color:#57745b}.nr-failure button{padding:10px 18px;margin:16px 10px 0 0;border:1px solid #aec4b0;border-radius:8px;background:#edf4e8;color:#294c39;cursor:pointer}';
    style.textContent += '\n@media print{dialog{position:static!important;inset:auto!important;height:auto!important;max-height:none!important;overflow:visible!important}:host{position:static!important;width:auto!important;height:auto!important}}';
    dialog = document.createElement('dialog'); dialog.setAttribute('aria-label', '近译阅读模式'); dialog.lang = 'zh-CN';
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('click', onContentClick);
    const container = document.createElement('div'); dialog.append(container); shadow.append(style, dialog);
    document.documentElement.append(host); react = createRoot(container);
    printStyle = document.createElement('style'); printStyle.media = 'print';
    printStyle.setAttribute('data-near-page-ui', '');
    printStyle.textContent = 'body,near-page-translate,near-translate{display:none!important}';
    document.head.append(printStyle);
    try { article = extractReadingArticle(document, openedUrl); extractionError = ''; }
    catch (error) { extractionError = error instanceof Error ? error.message : '没有找到可阅读的文章正文。'; article = undefined; }
    progress = 0; activeHeading = ''; currentSource = ''; notice = ''; layoutState = '';
    dialog.showModal();
    options.onSelectionPortal?.(dialog);
    render();
    window.addEventListener('resize', onResize, { passive: true });
    navigationTimer = setInterval(() => { if (openedUrl !== location.href) close(true); }, 800);
  }

  function close(clear = false): void {
    flushPreferences();
    if (!dialog) return;
    generation++;
    if (article) position = { url: openedUrl, source: currentSource, ratio: progress };
    if (translation) retained = new Map(translation.snapshot);
    translation?.dispose(); translation = undefined;
    if (clear) { retained.clear(); position = { url: '', source: '', ratio: 0 }; }
    clearInterval(navigationTimer); navigationTimer = undefined;
    if (frame !== undefined) cancelAnimationFrame(frame); frame = undefined;
    window.removeEventListener('resize', onResize);
    scroll?.removeEventListener('scroll', scheduleMeasure); scroll = undefined;
    options.onSelectionPortal?.();
    dialog.close(); dialog.removeEventListener('click', onContentClick);
    react?.unmount(); react = undefined;
    host?.remove(); host = undefined; dialog = undefined; article = undefined; articleMount = undefined;
    initialSeed.clear();
    sourceBlocks = []; headingElements = []; focusedBlock = undefined;
    pendingLayoutAnchor = undefined; measuredLayoutAnchor = undefined;
    printStyle?.remove(); printStyle = undefined;
    if (!clear) {
      window.scrollTo(originalScroll.x, originalScroll.y);
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    }
    previousFocus = undefined;
  }

  function onNavigation(): void { flushPreferences(); close(true); retained.clear(); }
  function onSettings(message: unknown): void {
    const update = message as { type?: string; settings?: PublicSettings };
    if (update.type !== 'settings-changed' || !update.settings || disposed) return;
    const previous = publicSettings;
    publicSettings = update.settings;
    options.serviceStatus?.refresh();
    if (previous && (previous.connectionRevision !== publicSettings.connectionRevision || previous.translationEngine !== publicSettings.translationEngine
      || previous.model !== publicSettings.model || previous.provider !== publicSettings.provider
      || previous.sourceLanguage !== publicSettings.sourceLanguage || previous.targetLanguage !== publicSettings.targetLanguage
      || !publicSettings.enabled || !publicSettings.webAccess || publicSettings.apiAccess === false)) {
      pendingLayoutAnchor = captureSourceTopAnchor() ?? pendingLayoutAnchor;
      translation?.dispose(); translation = undefined;
      retained.clear(); initialSeed.clear();
      initializeTranslation();
      notice = '翻译设置已更新；阅读位置已保留，点击翻译后使用新设置。';
      render();
    }
    initializeTranslation(); render();
  }

  window.addEventListener('pagehide', onNavigation); window.addEventListener('popstate', onNavigation);
  window.addEventListener('hashchange', onNavigation);
  browser.runtime.onMessage.addListener(onSettings);
  const stopServiceStatus = options.serviceStatus?.subscribe(next => { serviceStatus = next; render(); });
  void browser.runtime.sendMessage({ type: 'get-settings' }).then((value: PublicSettings) => {
    if (!disposed && !publicSettings) { publicSettings = value; initializeTranslation(); render(); }
  }).catch(() => {});
  void browser.runtime.sendMessage({ type: 'get-reading-preferences' }).then((value: { ok?: boolean; preferences?: unknown }) => {
    if (!disposed && !preferencesChanged && value?.ok) {
      pendingLayoutAnchor ??= captureLayoutAnchor();
      preferences = normalizeReadingPreferences(value.preferences); render();
    }
  }).catch(() => {});

  return { open, close: () => close(), dispose() {
    if (disposed) return;
    close(true); disposed = true;
    stopServiceStatus?.();
    clearTimeout(saveTimer);
    retained.clear();
    window.removeEventListener('pagehide', onNavigation); window.removeEventListener('popstate', onNavigation);
    window.removeEventListener('hashchange', onNavigation); browser.runtime.onMessage.removeListener(onSettings);
  } };
}
