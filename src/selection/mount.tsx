import { createRoot } from 'react-dom/client';
import { browser } from 'wxt/browser';
import { DEFAULT_MODEL, type PublicSettings, type TranslationServerMessage } from '../shared/contracts';
import { Translator, translatorStyles, type TranslatorView } from '../ui/translator/Translator';
import { TranslationClient } from './client';
import { selectionError } from './helpers';
import { takeSelectionSnapshot, type SelectionSnapshot } from './snapshot';

export interface MountSelectionOptions {
  source: 'web' | 'pdf';
  root?: HTMLElement | Document;
}

/** Shared composition root for ordinary page content and the extension's PDF text layer. */
export function mountSelectionTranslator(options: MountSelectionOptions): () => void {
  const scope = options.root ?? document;
  const host = document.createElement('near-translate');
  host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none';
  host.setAttribute('data-near-translate', '');
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = translatorStyles;
  shadow.appendChild(style);
  const container = document.createElement('div');
  shadow.appendChild(container);
  document.documentElement.appendChild(host);
  const react = createRoot(container);
  let settings: PublicSettings = { enabled: true, includeContext: true, model: DEFAULT_MODEL, hasApiKey: false, webAccess: false };
  let settingsReady = false;
  let view: TranslatorView = { mode: 'hidden' };
  let activeRequest: string | undefined;
  let disposed = false;
  let captureTimer: ReturnType<typeof setTimeout> | undefined;
  let selectionPath: EventTarget[] = [];
  const isAvailable = () => settingsReady && settings.enabled && (options.source === 'pdf' || settings.webAccess);

  const render = () => {
    if (disposed) return;
    react.render(<Translator view={view} source={options.source} onTranslate={translate} onClose={close} onRetry={translate}
      onSettings={() => { void browser.runtime.sendMessage({ type: 'open-options' }).catch(() => undefined); }} />);
  };
  const client = new TranslationClient((event: TranslationServerMessage) => {
    if (event.requestId !== activeRequest || view.mode !== 'card' || disposed) return;
    if (event.type === 'delta') view = { ...view, streamed: view.streamed + event.text };
    else if (event.type === 'result') {
      view = { ...view, status: 'done', result: event.result };
      activeRequest = undefined;
    } else if (event.type === 'error') {
      view = { ...view, status: 'error', error: event.error };
      activeRequest = undefined;
    }
    render();
  });

  function close(): void {
    client.cancel();
    activeRequest = undefined;
    view = { mode: 'hidden' };
    render();
  }

  function translate(): void {
    if (view.mode === 'hidden' || disposed || !isAvailable()) return;
    const selection = view.selection;
    const effectiveInput = { ...selection.input, context: settings.includeContext ? selection.input.context : undefined };
    client.cancel();
    activeRequest = undefined;
    const invalid = selectionError(selection.input.text);
    const error = invalid
      ? { code: 'INVALID_INPUT' as const, message: invalid, retryable: false }
      : !settings.hasApiKey ? { code: 'CONFIG' as const, message: '请先在扩展设置中填写 DeepSeek API Key，再重新选择英文翻译。', retryable: false } : undefined;
    view = { mode: 'card', selection: { ...selection, input: effectiveInput }, status: error ? 'error' : 'loading', streamed: '', error };
    if (!error) activeRequest = client.start(effectiveInput);
    render();
  }

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
      const selection = takeSelectionSnapshot({ root: scope, includeContext: settings.includeContext, path, pointer });
      if (!selection) { close(); return; }
      if (view.mode !== 'hidden' && sameSelection(view.selection, selection)) return;
      client.cancel();
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
    const current = takeSelectionSnapshot({ root: scope, includeContext: false, path: selectionPath });
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
    settings = update.settings;
    settingsReady = true;
    if (!isAvailable()) close();
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
    settings = value;
    settingsReady = true;
    if (!isAvailable()) close();
  }).catch(() => { /* The first request will present a meaningful connection error. */ });
  render();

  return () => {
    if (disposed) return;
    clearTimeout(captureTimer);
    client.dispose();
    activeRequest = undefined;
    disposed = true;
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
    react.unmount();
    host.remove();
  };
}
