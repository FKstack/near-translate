import { JSDOM } from 'jsdom';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicSettings, TranslationInput, TranslationServerMessage } from '../../src/shared/contracts';
import type { SelectionSnapshot } from '../../src/selection/snapshot';
import type { TranslatorView } from '../../src/ui/translator/Translator';

const fixtures = vi.hoisted(() => ({
  render: vi.fn<(element: { props: { view: TranslatorView; onTranslate: () => void; onClose: () => void; onRetryAnalysis: () => void } }) => void>(),
  createRoot: vi.fn<(container: HTMLElement) => void>(),
  unmount: vi.fn<() => void>(),
  sendMessage: vi.fn<(message: unknown) => Promise<PublicSettings>>(),
  addListener: vi.fn(), removeListener: vi.fn(),
  snapshot: vi.fn<(options: unknown) => SelectionSnapshot | undefined>(),
  start: vi.fn<(input: TranslationInput) => string>(),
  cancel: vi.fn<() => void>(), dispose: vi.fn<() => void>(),
  receivers: [] as Array<(message: TranslationServerMessage) => void>,
}));
vi.mock('react-dom/client', () => ({ createRoot: (container: HTMLElement) => {
  fixtures.createRoot(container);
  return { render: fixtures.render, unmount: fixtures.unmount };
} }));
vi.mock('wxt/browser', () => ({ browser: { runtime: { sendMessage: fixtures.sendMessage,
  onMessage: { addListener: fixtures.addListener, removeListener: fixtures.removeListener } } } }));
vi.mock('../../src/selection/snapshot', () => ({ takeSelectionSnapshot: fixtures.snapshot }));
vi.mock('../../src/ui/translator/Translator', () => ({ Translator: () => null, translatorStyles: '' }));
vi.mock('../../src/platform/translation-client', () => ({ TranslationClient: class {
  constructor(receive: (message: TranslationServerMessage) => void) { fixtures.receivers.push(receive); }
  start(input: TranslationInput) { return fixtures.start(input); }
  cancel() { fixtures.cancel(); }
  dispose() { fixtures.dispose(); }
} }));
import { mountSelectionTranslator } from '../../src/selection/mount';

let dom: JSDOM;
let dispose: (() => void) | undefined;
const latestMode = () => fixtures.render.mock.calls.at(-1)![0].props.view.mode;
const latestView = () => fixtures.render.mock.calls.at(-1)![0].props.view;

async function renderedCard(): Promise<string> {
  const { Translator } = await vi.importActual<typeof import('../../src/ui/translator/Translator')>('../../src/ui/translator/Translator');
  return renderToStaticMarkup(createElement(Translator, { view: latestView(), source: 'web', onTranslate: vi.fn(), onClose: vi.fn(),
    onRetry: vi.fn(), onSettings: vi.fn(), onRetryAnalysis: vi.fn() }));
}

beforeEach(() => {
  vi.clearAllMocks();
  fixtures.receivers.length = 0;
  fixtures.start.mockReturnValue('selection-request');
  dom = new JSDOM('<!doctype html><html><head></head><body><p id="source">An English source selection.</p></body></html>',
    { url: 'https://example.test/article' });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('MouseEvent', dom.window.MouseEvent);
  vi.stubGlobal('KeyboardEvent', dom.window.KeyboardEvent);
  vi.stubGlobal('Element', dom.window.Element);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  vi.stubGlobal('Node', dom.window.Node);
  vi.stubGlobal('ShadowRoot', dom.window.ShadowRoot);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  fixtures.sendMessage.mockResolvedValue({ enabled: true, webAccess: true, hasApiKey: true, apiAccess: true,
    includeContext: true, sentenceAnalysisEnabled: false, model: 'fixture-model' });
  fixtures.snapshot.mockReturnValue({ input: { text: 'An English source selection.', kind: 'text' },
    signature: 'selected-source-text', anchor: { x: 80, y: 120 } });
});

afterEach(() => {
  dispose?.(); dispose = undefined;
  dom.window.close();
  vi.useRealTimers(); vi.unstubAllGlobals();
});

async function ready(onHost?: (host: HTMLElement, close: () => void) => void) {
  dispose = mountSelectionTranslator({ source: 'web', onHost });
  await Promise.resolve(); await Promise.resolve();
}

function mouseup(element = document.querySelector('#source')!) {
  element.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true, composed: true, clientX: 80, clientY: 120 }));
}

describe('shared selection overlay lifecycle', () => {
  it('keeps an idle page free of React roots, including hidden settings updates', async () => {
    await ready();
    const host = document.querySelector('near-translate')!;
    const shadow = host.shadowRoot!;
    expect(shadow.children).toHaveLength(0);
    expect(fixtures.createRoot).not.toHaveBeenCalled();
    expect(fixtures.render).not.toHaveBeenCalled();
    const settingsChanged = fixtures.addListener.mock.calls[0]![0] as (message: unknown) => void;
    settingsChanged({ type: 'settings-changed', settings: { enabled: true, webAccess: true, hasApiKey: true, apiAccess: true,
      includeContext: true, sentenceAnalysisEnabled: false, model: 'fixture-model' } });
    expect(fixtures.createRoot).not.toHaveBeenCalled();
    expect(fixtures.render).not.toHaveBeenCalled();
    expect(shadow.children).toHaveLength(0);
  });

  it('releases the root and its delegated-event container on close and recreates them for a fresh selection', async () => {
    let host: HTMLElement | undefined;
    await ready(value => { host = value; });
    mouseup(); await vi.advanceTimersByTimeAsync(0);
    const firstStyle = host!.shadowRoot!.querySelector('style')!;
    expect(fixtures.createRoot).toHaveBeenCalledOnce();
    const firstContainer = fixtures.createRoot.mock.calls[0]![0];
    expect(firstContainer.parentNode).toBe(host!.shadowRoot);
    expect([...host!.shadowRoot!.children]).toEqual([firstStyle, firstContainer]);
    fixtures.render.mock.calls.at(-1)![0].props.onTranslate();
    expect(fixtures.createRoot).toHaveBeenCalledOnce();
    fixtures.render.mock.calls.at(-1)![0].props.onClose();
    expect(fixtures.unmount).toHaveBeenCalledOnce();
    expect(firstContainer.parentNode).toBe(null);
    expect(host!.shadowRoot!.children).toHaveLength(0);
    expect(firstStyle.parentNode).toBe(null);
    const renderCount = fixtures.render.mock.calls.length;
    fixtures.receivers[0]!({ type: 'progress', requestId: 'selection-request' });
    fixtures.receivers[0]!({ type: 'result', requestId: 'selection-request', result: { kind: 'text', translation: '迟到译文。' } });
    expect(fixtures.render).toHaveBeenCalledTimes(renderCount);
    expect(fixtures.createRoot).toHaveBeenCalledOnce();

    mouseup(); await vi.advanceTimersByTimeAsync(0);
    expect(fixtures.createRoot).toHaveBeenCalledTimes(2);
    const secondContainer = fixtures.createRoot.mock.calls[1]![0];
    const secondStyle = host!.shadowRoot!.querySelector('style')!;
    expect(secondContainer).not.toBe(firstContainer);
    expect(secondStyle).not.toBe(firstStyle);
    expect(secondContainer.parentNode).toBe(host!.shadowRoot);
    expect([...host!.shadowRoot!.children]).toEqual([secondStyle, secondContainer]);
    expect(document.querySelector('near-translate')).toBe(host);
    document.dispatchEvent(new dom.window.KeyboardEvent('keyup', { key: 'Escape', bubbles: true }));
    expect(fixtures.unmount).toHaveBeenCalledTimes(2);
    expect(secondContainer.parentNode).toBe(null);
    expect(host!.shadowRoot!.children).toHaveLength(0);
    expect(secondStyle.parentNode).toBe(null);
  });

  it('disposes before first use without creating a root when settings arrive late', async () => {
    let resolveSettings: ((settings: PublicSettings) => void) | undefined;
    fixtures.sendMessage.mockReturnValue(new Promise(resolve => { resolveSettings = resolve; }));
    dispose = mountSelectionTranslator({ source: 'web' });
    const settingsChanged = fixtures.addListener.mock.calls[0]![0] as (message: unknown) => void;
    dispose(); dispose = undefined;
    resolveSettings!({ enabled: true, webAccess: true, hasApiKey: true, apiAccess: true,
      includeContext: true, sentenceAnalysisEnabled: false, model: 'fixture-model' });
    await Promise.resolve(); await Promise.resolve();
    settingsChanged({ type: 'settings-changed', settings: { enabled: true, webAccess: true, hasApiKey: true, apiAccess: true,
      includeContext: true, sentenceAnalysisEnabled: false, model: 'fixture-model' } });
    mouseup(); await vi.advanceTimersByTimeAsync(0);
    expect(fixtures.createRoot).not.toHaveBeenCalled();
    expect(fixtures.render).not.toHaveBeenCalled();
    expect(fixtures.unmount).not.toHaveBeenCalled();
    expect(document.querySelector('near-translate')).toBe(null);
  });

  it('shows service progress and contextual word previews before validated dictionary completion', async () => {
    fixtures.snapshot.mockReturnValue({ input: { text: 'scalable', kind: 'word', sourceLanguage: 'en', targetLanguage: 'zh-Hans',
      context: 'Go is efficient, scalable, and productive.' }, signature: 'word-source', anchor: { x: 80, y: 120 } });
    await ready(); mouseup(); await vi.advanceTimersByTimeAsync(0);
    fixtures.render.mock.calls.at(-1)![0].props.onTranslate();
    expect(await renderedCard()).toContain('正在连接翻译服务…');
    fixtures.receivers[0]!({ type: 'started', requestId: 'selection-request' });
    expect(await renderedCard()).toContain('正在连接翻译服务…');

    fixtures.receivers[0]!({ type: 'progress', requestId: 'selection-request' });
    let html = await renderedCard();
    expect(html).toContain('正在生成释义…');
    expect(html).not.toContain('正在连接翻译服务…');
    fixtures.receivers[0]!({ type: 'word-preview', requestId: 'selection-request', preview: { translation: '可扩展的' } });
    html = await renderedCard();
    expect(html).toContain('本句含义');
    expect(html).toContain('可扩展的');
    expect(html).toContain('参考原句');
    expect(html).not.toContain('常见义项');
    expect(html).not.toContain('>复制</button>');
    expect(latestView()).toMatchObject({ status: 'loading', wordPreview: { translation: '可扩展的' } });

    fixtures.receivers[0]!({ type: 'word-preview', requestId: 'selection-request',
      preview: { partOfSpeech: '形容词', explanation: '本句描述语言可随规模增长而扩展。' } });
    html = await renderedCard();
    expect(html).toContain('可扩展的');
    expect(html).toContain('形容词');
    expect(html).toContain('本句描述语言可随规模增长而扩展。');
    expect(html).toContain('正在生成释义…');

    fixtures.receivers[0]!({ type: 'result', requestId: 'selection-request', result: { kind: 'word', translation: '可伸缩的',
      partOfSpeech: '形容词', explanation: '最终校验后的解释。', senses: [{ partOfSpeech: '形容词', meaning: '可扩展；可伸缩' }] } });
    html = await renderedCard();
    expect(html).toContain('可伸缩的');
    expect(html).toContain('最终校验后的解释。');
    expect(html).not.toContain('本句描述语言可随规模增长而扩展。');
    expect(html).toContain('常见义项');
    expect(html).toContain('>复制</button>');
    expect(html).not.toContain('正在生成释义…');
    expect(latestView()).toMatchObject({ status: 'done', wordPreview: undefined });
    const renderCount = fixtures.render.mock.calls.length;
    fixtures.receivers[0]!({ type: 'word-preview', requestId: 'selection-request', preview: { translation: '迟到结果' } });
    expect(fixtures.render).toHaveBeenCalledTimes(renderCount);
  });

  it('retains a partial word on failure and clears it on retry while ignoring the superseded request', async () => {
    fixtures.start.mockReturnValueOnce('first-request').mockReturnValueOnce('retry-request');
    fixtures.snapshot.mockReturnValue({ input: { text: 'bank', kind: 'word', sourceLanguage: 'en', targetLanguage: 'zh-Hans' },
      signature: 'word-source', anchor: { x: 80, y: 120 } });
    await ready(); mouseup(); await vi.advanceTimersByTimeAsync(0);
    fixtures.render.mock.calls.at(-1)![0].props.onTranslate();
    fixtures.receivers[0]!({ type: 'word-preview', requestId: 'first-request', preview: { translation: '银行' } });
    fixtures.receivers[0]!({ type: 'error', requestId: 'first-request', error: { code: 'INVALID_RESPONSE', message: '义项不完整。', retryable: true } });
    let html = await renderedCard();
    expect(html).toContain('银行');
    expect(html).toContain('义项不完整。');
    expect(html).not.toContain('>复制</button>');
    expect(latestView()).toMatchObject({ status: 'error' });

    fixtures.render.mock.calls.at(-1)![0].props.onTranslate();
    html = await renderedCard();
    expect(html).toContain('正在连接翻译服务…');
    expect(html).not.toContain('银行');
    expect(latestView()).toMatchObject({ status: 'loading', streamed: '' });
    const renderCount = fixtures.render.mock.calls.length;
    fixtures.receivers[0]!({ type: 'progress', requestId: 'first-request' });
    fixtures.receivers[0]!({ type: 'word-preview', requestId: 'first-request', preview: { translation: '旧释义' } });
    expect(fixtures.render).toHaveBeenCalledTimes(renderCount);
    fixtures.receivers[0]!({ type: 'word-preview', requestId: 'retry-request', preview: { translation: '河岸' } });
    expect(await renderedCard()).toContain('河岸');
  });

  it('clears word previews on a new selection and configuration change and ignores cancelled events', async () => {
    fixtures.start.mockReturnValueOnce('first-request').mockReturnValueOnce('second-request');
    fixtures.snapshot.mockReturnValue({ input: { text: 'bank', kind: 'word' }, signature: 'first-word', anchor: { x: 80, y: 120 } });
    await ready(); mouseup(); await vi.advanceTimersByTimeAsync(0);
    fixtures.render.mock.calls.at(-1)![0].props.onTranslate();
    fixtures.receivers[0]!({ type: 'word-preview', requestId: 'first-request', preview: { translation: '银行' } });

    fixtures.snapshot.mockReturnValue({ input: { text: 'light', kind: 'word' }, signature: 'second-word', anchor: { x: 80, y: 120 } });
    mouseup(); await vi.advanceTimersByTimeAsync(0);
    expect(latestView()).toMatchObject({ mode: 'button', selection: { input: { text: 'light' } } });
    fixtures.render.mock.calls.at(-1)![0].props.onTranslate();
    expect(await renderedCard()).not.toContain('银行');
    fixtures.receivers[0]!({ type: 'word-preview', requestId: 'first-request', preview: { translation: '旧释义' } });
    expect(latestView()).not.toHaveProperty('wordPreview');
    fixtures.receivers[0]!({ type: 'word-preview', requestId: 'second-request', preview: { translation: '轻的' } });
    const settingsChanged = fixtures.addListener.mock.calls[0]![0] as (message: unknown) => void;
    settingsChanged({ type: 'settings-changed', settings: { enabled: true, webAccess: true, hasApiKey: true, apiAccess: true,
      includeContext: true, sentenceAnalysisEnabled: false, model: 'changed-model', connectionRevision: 1 } });
    expect(fixtures.unmount).toHaveBeenCalledOnce();
    expect(document.querySelector('near-translate')!.shadowRoot!.children).toHaveLength(0);
    const renderCount = fixtures.render.mock.calls.length;
    fixtures.receivers[0]!({ type: 'progress', requestId: 'second-request' });
    fixtures.receivers[0]!({ type: 'word-preview', requestId: 'second-request', preview: { translation: '迟到释义' } });
    expect(fixtures.render).toHaveBeenCalledTimes(renderCount);
  });

  it('distinguishes text generation from connection waiting before its first visible text', async () => {
    await ready(); mouseup(); await vi.advanceTimersByTimeAsync(0);
    fixtures.render.mock.calls.at(-1)![0].props.onTranslate();
    fixtures.receivers[0]!({ type: 'progress', requestId: 'selection-request' });
    const html = await renderedCard();
    expect(html).toContain('正在翻译…');
    expect(html).not.toContain('正在连接翻译服务…');
    expect(html).not.toContain('正在生成释义…');
  });

  it.each(['web', 'pdf'] as const)('sets the host language policy for %s captures and selection-change checks', async source => {
    document.documentElement.lang = 'zh-CN';
    dispose = mountSelectionTranslator({ source });
    await Promise.resolve(); await Promise.resolve();
    mouseup(); await vi.advanceTimersByTimeAsync(0);
    expect(fixtures.snapshot).toHaveBeenLastCalledWith(expect.objectContaining({ useDocumentLanguageHint: source !== 'pdf' }));
    document.dispatchEvent(new dom.window.Event('selectionchange'));
    expect(fixtures.snapshot).toHaveBeenCalledTimes(2);
    expect(fixtures.snapshot).toHaveBeenLastCalledWith(expect.objectContaining({ useDocumentLanguageHint: source !== 'pdf' }));
  });

  it('does not request English syntax analysis for unknown-language automatic French text, including a manual retry', async () => {
    fixtures.sendMessage.mockResolvedValue({ enabled: true, webAccess: true, hasApiKey: true, apiAccess: true,
      includeContext: true, sentenceAnalysisEnabled: true, model: 'fixture-model', sourceLanguage: 'auto', targetLanguage: 'zh-Hans' });
    fixtures.snapshot.mockReturnValue({ input: { text: 'Ce systeme traduit les textes dans plusieurs langues.', kind: 'text',
      sourceLanguage: 'auto', targetLanguage: 'zh-Hans' }, signature: 'unknown-language-source', anchor: { x: 80, y: 120 } });
    await ready(); mouseup(); await vi.advanceTimersByTimeAsync(0);
    fixtures.render.mock.calls.at(-1)![0].props.onTranslate();
    fixtures.receivers[0]!({ type: 'result', requestId: 'selection-request', result: { kind: 'text', translation: '这家图书馆为读者提供有趣的书籍。' } });
    fixtures.render.mock.calls.at(-1)![0].props.onRetryAnalysis();
    expect(fixtures.start).toHaveBeenCalledTimes(1);
    expect(fixtures.start.mock.calls[0]![0]).toMatchObject({ kind: 'text', sourceLanguage: 'auto' });
  });

  it.each(['auto', 'en'] as const)('allows English analysis when source %s resolves to an explicit or reliable English content hint', async sourceLanguage => {
    fixtures.sendMessage.mockResolvedValue({ enabled: true, webAccess: true, hasApiKey: true, apiAccess: true,
      includeContext: true, sentenceAnalysisEnabled: true, model: 'fixture-model', sourceLanguage, targetLanguage: 'zh-Hans' });
    fixtures.snapshot.mockReturnValue({ input: { text: 'The library provides useful books for every reader in the neighborhood.', kind: 'text',
      sourceLanguage: 'en', targetLanguage: 'zh-Hans' }, signature: 'known-english-source', anchor: { x: 80, y: 120 } });
    await ready(); mouseup(); await vi.advanceTimersByTimeAsync(0);
    fixtures.render.mock.calls.at(-1)![0].props.onTranslate();
    fixtures.receivers[0]!({ type: 'result', requestId: 'selection-request', result: { kind: 'text', translation: '图书馆为附近每位读者提供有用的书籍。' } });
    expect(fixtures.start).toHaveBeenCalledTimes(2);
    expect(fixtures.start.mock.calls[1]![0]).toMatchObject({ task: 'sentence-analysis', sourceLanguage: 'en', targetLanguage: 'zh-Hans' });
  });

  it('does not resurrect an old selection capture after the composition root closes and moves the overlay', async () => {
    let closeSelection: (() => void) | undefined;
    let selectionHost: HTMLElement | undefined;
    await ready((host, close) => { selectionHost = host; closeSelection = close; });

    // A positive control proves settings and real document events enable capture.
    mouseup(); await vi.advanceTimersByTimeAsync(0);
    expect(fixtures.snapshot).toHaveBeenCalledTimes(1);
    expect(latestMode()).toBe('button');
    closeSelection!();
    expect(selectionHost!.shadowRoot!.children).toHaveLength(0);

    fixtures.snapshot.mockClear();
    mouseup();
    expect(fixtures.snapshot).not.toHaveBeenCalled();
    // Entering the reader closes the old overlay before moving its shared host.
    closeSelection!();
    const readerHost = document.createElement('near-reading-mode');
    const shadow = readerHost.attachShadow({ mode: 'open' });
    const dialog = document.createElement('dialog');
    const readerParagraph = document.createElement('p');
    readerParagraph.textContent = 'A new selection inside the reading surface.';
    dialog.append(readerParagraph, selectionHost!); shadow.append(dialog); document.body.append(readerHost);
    const renderCount = fixtures.render.mock.calls.length;
    await vi.advanceTimersByTimeAsync(0);
    expect(fixtures.snapshot).not.toHaveBeenCalled();
    expect(fixtures.render).toHaveBeenCalledTimes(renderCount);
    expect(selectionHost!.shadowRoot!.children).toHaveLength(0);
    expect(fixtures.start).not.toHaveBeenCalled();

    // The same live controller still handles a fresh event through nested shadow DOM.
    mouseup(readerParagraph); await vi.advanceTimersByTimeAsync(0);
    expect(fixtures.snapshot).toHaveBeenCalledTimes(1);
    expect(latestMode()).toBe('button');
  });

  it('disposes a queued capture without reading the old selection or rendering again', async () => {
    await ready();
    mouseup();
    expect(fixtures.snapshot).not.toHaveBeenCalled();
    const renderCount = fixtures.render.mock.calls.length;
    dispose!(); dispose = undefined;
    await vi.advanceTimersByTimeAsync(0);
    mouseup(); await vi.advanceTimersByTimeAsync(0);
    expect(fixtures.snapshot).not.toHaveBeenCalled();
    expect(fixtures.render).toHaveBeenCalledTimes(renderCount);
    expect(fixtures.unmount).not.toHaveBeenCalled();
    expect(fixtures.createRoot).not.toHaveBeenCalled();
    expect(document.querySelector('near-translate')).toBe(null);
    expect(fixtures.dispose).toHaveBeenCalledTimes(2);
    expect(fixtures.start).not.toHaveBeenCalled();
  });
});
