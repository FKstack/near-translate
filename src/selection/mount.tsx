import { createRoot } from 'react-dom/client';
import { browser } from 'wxt/browser';
import { DEFAULT_MODEL, type PublicSettings, type TranslationServerMessage } from '../shared/contracts';
import { Translator, translatorStyles, type TranslatorView } from '../ui/translator/Translator';
import { TranslationClient } from '../platform/translation-client';
import { canAnalyzeSentence } from '../core/sentence-analysis';
import { selectionError } from './helpers';
import { takeSelectionSnapshot, type SelectionSnapshot } from './snapshot';
import { readLanguagePair, supportsSentenceAnalysis } from '../shared/languages';
import { beforeUserAction, type BeforeUse } from '../shared/before-use';

export interface MountSelectionOptions {
  source: 'web' | 'pdf';
  root?: HTMLElement | Document;
  /** Composition root may move this owned overlay into an active reading dialog. */
  onHost?: (host: HTMLElement, close: () => void) => void;
  beforeUse?: BeforeUse;
}
/** Shared composition root for ordinary page content and the extension's PDF text layer. */
export function mountSelectionTranslator(options: MountSelectionOptions): () => void {
  const scope = options.root ?? document;
  const host = document.createElement('near-translate');
  host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none';
  host.setAttribute('data-near-translate', '');
  const shadow = host.attachShadow({ mode: 'open' });
  document.documentElement.appendChild(host);
  let style: HTMLStyleElement | undefined;
  let container: HTMLDivElement | undefined;
  let react: ReturnType<typeof createRoot> | undefined;
  let settings: PublicSettings = { enabled: true, includeContext: true, sentenceAnalysisEnabled: true, model: DEFAULT_MODEL, hasApiKey: false, webAccess: false };
  let settingsReady = false;
  let view: TranslatorView = { mode: 'hidden' };
  let activeRequest: string | undefined;
  let activeAnalysis: string | undefined;
  let disposed = false;
  let captureTimer: ReturnType<typeof setTimeout> | undefined;
  let selectionPath: EventTarget[] = [];
  const isAvailable = () => settingsReady && settings.enabled && (options.source === 'pdf' || settings.webAccess);

  const releaseRoot = () => {
    const mounted = react;
    const previousContainer = container;
    react = undefined;
    container = undefined;
    mounted?.unmount();
    // React delegates events to its container. Drop that container with the root.
    previousContainer?.remove();
    style?.remove();
    style = undefined;
  };
  const render = () => {
    if (disposed) return;
    if (view.mode === 'hidden') { releaseRoot(); return; }
    if (!react) {
      style = document.createElement('style');
      style.textContent = translatorStyles;
      shadow.appendChild(style);
      container = document.createElement('div');
      shadow.appendChild(container);
      react = createRoot(container);
    }
    react.render(<Translator view={view} source={options.source} onTranslate={userTranslate} onClose={close} onRetry={userTranslate} onRetryAnalysis={() => beforeUserAction(options.beforeUse, () => startAnalysis(true))}
      onSettings={() => { void browser.runtime.sendMessage({ type: 'open-options' }).catch(() => undefined); }} />);
  };
  const client = new TranslationClient((event: TranslationServerMessage) => {
    if (event.requestId !== activeRequest || view.mode !== 'card' || disposed) return;
    if (event.type === 'progress') view = { ...view, responding: true };
    else if (event.type === 'word-preview' && view.selection.input.kind === 'word') {
      view = { ...view, responding: true, wordPreview: { ...view.wordPreview, ...event.preview } };
    } else if (event.type === 'delta') view = { ...view, responding: true, streamed: view.streamed + event.text };
    else if (event.type === 'result') {
      view = { ...view, status: 'done', result: event.result, wordPreview: undefined };
      activeRequest = undefined;
      startAnalysis();
    } else if (event.type === 'error') {
      view = { ...view, status: 'error', error: event.error };
      activeRequest = undefined;
    }
    render();
  });
  const analysisClient = new TranslationClient((event: TranslationServerMessage) => {
    if (event.requestId !== activeAnalysis || view.mode !== 'card' || disposed || !settings.sentenceAnalysisEnabled) return;
    if (event.type === 'analysis') {
      view = { ...view, analysis: { status: 'done', result: event.analysis } };
      activeAnalysis = undefined;
    } else if (event.type === 'error') {
      view = { ...view, analysis: { status: 'error', error: event.error } };
      activeAnalysis = undefined;
    } else if (event.type === 'result') {
      view = { ...view, analysis: { status: 'error', error: {
        code: 'INVALID_RESPONSE', message: '拆解响应格式不正确；若扩展刚更新，请刷新网页后重试。', retryable: true,
      } } };
      activeAnalysis = undefined;
    }
    render();
  });

  function cancelAnalysis(): void {
    analysisClient.cancel();
    activeAnalysis = undefined;
    if (view.mode === 'card' && view.analysis) view = { ...view, analysis: undefined };
  }

  function startAnalysis(retry = false): void {
    if (disposed || !isAvailable() || settings.translationEngine === 'deepl-web' || !settings.sentenceAnalysisEnabled || !supportsSentenceAnalysis(settings) || view.mode !== 'card'
      || view.status !== 'done' || view.result?.kind !== 'text' || view.selection.input.kind !== 'text' || !supportsSentenceAnalysis(view.selection.input)
      || view.selection.input.sourceLanguage !== 'en'
      || !canAnalyzeSentence(view.selection.input.text) || (!retry && view.analysis)) return;
    analysisClient.cancel();
    activeAnalysis = undefined;
    const input = view.selection.input;
    view = { ...view, analysis: { status: 'loading' } };
    activeAnalysis = analysisClient.start({ text: input.text, kind: 'text', task: 'sentence-analysis', sourceLanguage: 'en',
      ...(input.targetLanguage ? { targetLanguage: input.targetLanguage } : {}),
      ...(settings.includeContext && input.context ? { context: input.context } : {}) });
    render();
  }

  function close(): void {
    if (disposed) return;
    clearTimeout(captureTimer);
    captureTimer = undefined;
    selectionPath = [];
    client.cancel();
    cancelAnalysis();
    activeRequest = undefined;
    view = { mode: 'hidden' };
    render();
  }

  function translate(): void {
    if (view.mode === 'hidden' || disposed || !isAvailable()) return;
    const selection = view.selection;
    const effectiveInput = { ...selection.input, context: settings.includeContext ? selection.input.context : undefined };
    client.cancel();
    cancelAnalysis();
    activeRequest = undefined;
    const invalid = selectionError(selection.input.text);
    const error = invalid
      ? { code: 'INVALID_INPUT' as const, message: invalid, retryable: false }
      : !settings.hasApiKey && settings.requiresApiKey !== false ? { code: 'CONFIG' as const, message: '请在设置中选择 DeepL 免费翻译，或填写 API Key，再重新选择文字翻译。', retryable: false }
      : settings.apiAccess === false ? { code: 'CONFIG' as const, message: '请在翻译设置中保存并授权当前翻译服务。', retryable: false } : undefined;
    view = { mode: 'card', selection: { ...selection, input: effectiveInput }, status: error ? 'error' : 'loading', streamed: '', error };
    if (!error) activeRequest = client.start(effectiveInput);
    render();
  }

  function userTranslate(): void { beforeUserAction(options.beforeUse, translate); }

  const isOwnEvent = (event: Event): boolean => event.composedPath().includes(host);
  const sameSelection = (a: SelectionSnapshot, b: SelectionSnapshot): boolean => a.signature === b.signature &&
    (!a.range || !b.range || (a.range.startContainer === b.range.startContainer && a.range.endContainer === b.range.endContainer));
  const capture = (event: MouseEvent | KeyboardEvent) => {
    if (disposed || !isAvailable() || isOwnEvent(event)) return;
    const path = event.composedPath();
    selectionPath = path;
    const pointer = event instanceof MouseEvent ? { x: event.clientX, y: event.clientY } : undefined;
    clearTimeout(captureTimer);
    captureTimer = setTimeout(() => {
      if (disposed || !isAvailable()) return;
      const selection = takeSelectionSnapshot({ root: scope, includeContext: settings.includeContext, languages: readLanguagePair(settings),
        useDocumentLanguageHint: options.source !== 'pdf', path, pointer });
      if (!selection) { close(); return; }
      if (view.mode !== 'hidden' && sameSelection(view.selection, selection)) return;
      client.cancel();
      cancelAnalysis();
      activeRequest = undefined;
      view = { mode: 'button', selection };
      render();
    }, 0);
  };

  const onKeyboard = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && view.mode !== 'hidden') { close(); return; }
    if (event.shiftKey || ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key) ||
      (event.key.toLowerCase() === 'a' && (event.ctrlKey || event.metaKey))) capture(event);
  };
  const onSelectionChange = () => {
    if (disposed || view.mode === 'hidden') return;
    // Selections made inside the card (including the copy fallback) are independent of page selection.
    const shadowSelection = (shadow as ShadowRoot & { getSelection?: () => Selection | null }).getSelection?.();
    const documentSelection = document.getSelection();
    if ((shadowSelection?.anchorNode && shadow.contains(shadowSelection.anchorNode)) ||
      (documentSelection?.anchorNode && shadow.contains(documentSelection.anchorNode))) return;
    const current = takeSelectionSnapshot({ root: scope, includeContext: false, languages: readLanguagePair(settings),
      useDocumentLanguageHint: options.source !== 'pdf', path: selectionPath });
    if (!current || !sameSelection(view.selection, current)) close();
  };
  const onPointerDown = (event: PointerEvent) => {
    if (isOwnEvent(event) || view.mode === 'hidden') return;
    // Pressing elsewhere starts a new selection and immediately ends any active request.
    close();
  };
  const onScroll = (event: Event) => {
    if (!isOwnEvent(event) && view.mode === 'button') close();
  };
  const onSettings = (message: unknown) => {
    const update = message as { type?: string; settings?: PublicSettings };
    if (update.type !== 'settings-changed' || !update.settings || disposed) return;
    const connectionChanged = settings.connectionRevision !== update.settings.connectionRevision
      || settings.provider !== update.settings.provider || settings.model !== update.settings.model
      || settings.translationEngine !== update.settings.translationEngine;
    settings = { ...update.settings, sentenceAnalysisEnabled: update.settings.sentenceAnalysisEnabled && supportsSentenceAnalysis(update.settings) };
    settingsReady = true;
    if (!isAvailable() || connectionChanged || settings.apiAccess === false) close();
    else if (!settings.sentenceAnalysisEnabled) { cancelAnalysis(); render(); }
    else startAnalysis();
  };

  document.addEventListener('mouseup', capture, true);
  document.addEventListener('dblclick', capture, true);
  document.addEventListener('keyup', onKeyboard, true);
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('selectionchange', onSelectionChange);
  document.addEventListener('scroll', onScroll, true);
  window.addEventListener('pagehide', close);
  window.addEventListener('popstate', close);
  window.addEventListener('hashchange', close);
  browser.runtime.onMessage.addListener(onSettings);
  void browser.runtime.sendMessage({ type: 'get-settings' }).then((value: PublicSettings) => {
    // A settings broadcast received after this request began is already newer than its response.
    if (disposed || settingsReady) return;
    settings = { ...value, sentenceAnalysisEnabled: value.sentenceAnalysisEnabled && supportsSentenceAnalysis(value) };
    settingsReady = true;
    if (!isAvailable()) close();
  }).catch(() => { /* The first request will present a meaningful connection error. */ });
  options.onHost?.(host, close);
  render();

  return () => {
    if (disposed) return;
    clearTimeout(captureTimer);
    client.dispose();
    analysisClient.dispose();
    activeRequest = undefined;
    activeAnalysis = undefined;
    disposed = true;
    view = { mode: 'hidden' };
    selectionPath = [];
    captureTimer = undefined;
    document.removeEventListener('mouseup', capture, true);
    document.removeEventListener('dblclick', capture, true);
    document.removeEventListener('keyup', onKeyboard, true);
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('selectionchange', onSelectionChange);
    document.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('pagehide', close);
    window.removeEventListener('popstate', close);
    window.removeEventListener('hashchange', close);
    browser.runtime.onMessage.removeListener(onSettings);
    releaseRoot();
    host.remove();
  };
}
