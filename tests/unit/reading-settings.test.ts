import { JSDOM } from 'jsdom';
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReadingSettings, type ReadingSettingsProps } from '../../src/reading/ReadingSettings';
import { ReadingView, type ReadingViewProps } from '../../src/reading/ReadingView';
import { DEFAULT_READING_PREFERENCES, readingStyle, type ReadingPreferences } from '../../src/shared/reading';
import { contrastRatio } from '../../src/shared/reading-appearance';
import { MAX_READING_STYLE_FILE_BYTES, serializeReadingStyle } from '../../src/shared/reading-style-file';

let dom: JSDOM;
let root: Root | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined; dom?.window.close();
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

function setup() {
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://example.test/article' });
  vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  root = createRoot(dom.window.document.getElementById('root')!);
}

async function settings(preferences: ReadingPreferences, props: Partial<ReadingSettingsProps> = {}) {
  setup();
  const changed = vi.fn();
  let current = preferences;
  function Harness() {
    const [value, setValue] = useState(preferences);
    current = value;
    return createElement(ReadingSettings, { ...props, preferences: value,
      onPreferences: next => { changed(next); setValue(next); } });
  }
  await act(async () => root!.render(createElement(Harness)));
  return { changed, current: () => current };
}

function button(name: string): HTMLButtonElement {
  const found = [...dom.window.document.querySelectorAll('button')].find(item => (item.getAttribute('aria-label') || item.textContent) === name);
  if (!found) throw new Error('Missing button: ' + name);
  return found;
}

async function click(name: string) { await act(async () => button(name).click()); }

async function importFile(file: { size: number; text: () => Promise<string> }) {
  const input = dom.window.document.querySelector<HTMLInputElement>('input[type=file]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () => input.dispatchEvent(new dom.window.Event('change', { bubbles: true })));
}

describe('reading customization user flows', () => {
  it('keeps translation controls and a shared cooldown in the fixed header before this reader has sent a request', async () => {
    setup();
    const now = Date.now();
    const props: ReadingViewProps = {
      article: { title: 'Article', byline: '', siteName: 'Example', sourceUrl: 'https://example.test/article', lang: 'en',
        excerpt: '', wordCount: 500, readingMinutes: 2, content: {} as HTMLElement, outline: [], sourceMap: new Map(), strategy: 'readability', truncated: false },
      preferences: { ...DEFAULT_READING_PREFERENCES }, translation: { status: 'idle', total: 0, completed: 0, failed: 0 },
      serviceStatus: { engine: 'deepl-web', cooldownUntil: now + 60_000, checkedAt: now },
      progress: 0, articleRef: vi.fn(), onPreferences: vi.fn(), onClose: vi.fn(), onTranslate: vi.fn(), onStop: vi.fn(), onRetry: vi.fn(), onHeading: vi.fn(),
    };
    await act(async () => root!.render(createElement(ReadingView, props)));
    expect(button('翻译正文').closest('.nr-header')).not.toBeNull();
    expect(button('翻译正文').disabled).toBe(true);
    expect(dom.window.document.querySelector('.nr-header-status')?.textContent).toContain('秒后可手动重试');
    expect(dom.window.document.querySelector('.nr-paper .nr-reading-tools')).toBeNull();
    await act(async () => root!.render(createElement(ReadingView, { ...props,
      preferences: { ...props.preferences, mode: 'translation' } })));
    expect(dom.window.document.querySelector('.nr-header-status')?.textContent).toContain('秒后可手动重试');
    await act(async () => root!.render(createElement(ReadingView, { ...props,
      serviceStatus: { engine: 'deepl-web', cooldownUntil: 0, checkedAt: now } })));
    expect(button('翻译正文').disabled).toBe(false);
    expect(dom.window.document.querySelector('.nr-header-status')).toBeNull();
  });

  it('applies recipes and a personal style while preserving the reading mode and saved appearance', async () => {
    const saved = readingStyle({ ...DEFAULT_READING_PREFERENCES, fontSize: 25, theme: 'paper' });
    const ui = await settings({ ...DEFAULT_READING_PREFERENCES, mode: 'bilingual', savedStyle: saved });
    await click('技术文档');
    expect(ui.current()).toMatchObject({ mode: 'bilingual', theme: 'paper', width: 'wide', fontFamily: 'sans', savedStyle: saved });
    await click('保存为我的样式');
    const personal = ui.current().savedStyle;
    await click('夜间阅读');
    expect(ui.current()).toMatchObject({ mode: 'bilingual', theme: 'dark', savedStyle: personal });
    await click('应用我的样式');
    expect(readingStyle(ui.current())).toEqual(personal);
    expect(ui.current().mode).toBe('bilingual');
    expect(dom.window.document.body.textContent).toContain('与当前一致');
  });

  it('shows actual save failures and offers separate retry, reset and undo actions', async () => {
    const retry = vi.fn(); const reset = vi.fn(); const undo = vi.fn();
    await settings({ ...DEFAULT_READING_PREFERENCES }, { preferencesStatus: 'error', onRetryPreferences: retry,
      onResetPreferences: reset, onUndoPreferences: undo, canUndoPreferences: true });
    expect(dom.window.document.body.textContent).toContain('显示偏好保存失败');
    expect(dom.window.document.body.textContent).not.toContain('显示偏好已自动保存');
    await click('重试保存显示偏好'); await click('恢复默认'); await click('撤销上次调整');
    expect(retry).toHaveBeenCalledTimes(1); expect(reset).toHaveBeenCalledTimes(1); expect(undo).toHaveBeenCalledTimes(1);
  });

  it('lets a low-contrast experiment be repaired without changing the chosen background or accent', async () => {
    const colors = { background: '#eeeeee', text: '#ededed', accent: '#123456' };
    const ui = await settings({ ...DEFAULT_READING_PREFERENCES, theme: 'custom', colors });
    expect(dom.window.document.querySelector('.nr-contrast-note')?.getAttribute('data-warning')).toBe('true');
    await click('提高文字对比度');
    expect(ui.current().colors).toMatchObject({ background: colors.background, accent: colors.accent });
    expect(contrastRatio(ui.current().colors.text, colors.background)).toBeGreaterThanOrEqual(4.5);
    expect(dom.window.document.querySelector('.nr-contrast-note')?.getAttribute('data-warning')).toBe('false');
  });

  it('keeps preferences intact after invalid or oversized imports and applies a valid appearance only', async () => {
    const prefs = { ...DEFAULT_READING_PREFERENCES, mode: 'translation' as const,
      savedStyle: readingStyle({ ...DEFAULT_READING_PREFERENCES, fontSize: 30 }) };
    const ui = await settings(prefs);
    await importFile({ size: 1, text: async () => '{' });
    expect(ui.changed).not.toHaveBeenCalled();
    expect(dom.window.document.body.textContent).toContain('当前设置未更改');
    const read = vi.fn(async () => '{}');
    await importFile({ size: MAX_READING_STYLE_FILE_BYTES + 1, text: read });
    expect(read).not.toHaveBeenCalled(); expect(ui.changed).not.toHaveBeenCalled();
    await importFile({ size: 1000, text: async () => serializeReadingStyle({ ...DEFAULT_READING_PREFERENCES, theme: 'dark', fontSize: 28 }) });
    expect(ui.current()).toMatchObject({ theme: 'dark', fontSize: 28, mode: 'translation', savedStyle: prefs.savedStyle });
    expect(dom.window.document.body.textContent).toContain('已应用导入版式');
  });

  it('uses current preferences when a file finishes reading and ignores a late read after unmount', async () => {
    const ui = await settings({ ...DEFAULT_READING_PREFERENCES, mode: 'bilingual' });
    let resolve!: (text: string) => void;
    const pending = new Promise<string>(done => { resolve = done; });
    await importFile({ size: 1000, text: () => pending });
    await click('保存为我的样式');
    const personal = ui.current().savedStyle;
    await act(async () => resolve(serializeReadingStyle({ ...DEFAULT_READING_PREFERENCES, theme: 'dark' })));
    expect(ui.current()).toMatchObject({ theme: 'dark', mode: 'bilingual', savedStyle: personal });
    let lateResolve!: (text: string) => void;
    await importFile({ size: 1000, text: () => new Promise(done => { lateResolve = done; }) });
    const calls = ui.changed.mock.calls.length;
    await act(async () => root!.unmount()); root = undefined;
    await act(async () => lateResolve(serializeReadingStyle({ ...DEFAULT_READING_PREFERENCES })));
    expect(ui.changed).toHaveBeenCalledTimes(calls);
  });

  it('exports an appearance-only JSON and revokes the download URL', async () => {
    vi.useFakeTimers();
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:reading-style');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    await settings({ ...DEFAULT_READING_PREFERENCES, mode: 'bilingual', savedStyle: readingStyle({ ...DEFAULT_READING_PREFERENCES }) });
    vi.spyOn(dom.window.HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await click('导出版式');
    const data = JSON.parse(await (create.mock.calls[0]![0] as Blob).text()) as Record<string, unknown>;
    expect(data).toMatchObject({ format: 'near-translate-reading-style', version: 1 });
    expect(data.style).not.toHaveProperty('mode'); expect(data.style).not.toHaveProperty('savedStyle');
    expect(dom.window.document.querySelector('a[download]')).toBeNull();
    await act(async () => vi.runAllTimers());
    expect(revoke).toHaveBeenCalledWith('blob:reading-style');
  });

  it('unlocks the article when an open mobile drawer becomes a desktop panel', async () => {
    setup();
    let width = 390;
    const listeners = new Set<() => void>();
    Object.defineProperty(dom.window, 'matchMedia', { value: (query: string) => ({
      get matches() { return width <= (query.includes('1180') ? 1180 : 860); },
      addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
    }) });
    const commit = vi.fn();
    const props: ReadingViewProps = {
      article: { title: 'Article', byline: '', siteName: 'Example', sourceUrl: 'https://example.test/article', lang: 'en',
        excerpt: '', wordCount: 500, readingMinutes: 2, content: {} as HTMLElement, outline: [], sourceMap: new Map(), strategy: 'readability', truncated: false },
      preferences: { ...DEFAULT_READING_PREFERENCES }, translation: { status: 'idle', total: 0, completed: 0, failed: 0 },
      progress: 0, articleRef: vi.fn(), onPreferences: vi.fn(), onClose: vi.fn(), onTranslate: vi.fn(), onStop: vi.fn(), onRetry: vi.fn(),
      onHeading: vi.fn(), onLayoutCommit: commit,
    };
    await act(async () => root!.render(createElement(ReadingView, props)));
    await act(async () => dom.window.document.querySelector<HTMLButtonElement>('.nr-small-screen')!.click());
    expect(dom.window.document.querySelector('.nr-scroll')?.hasAttribute('inert')).toBe(true);
    await act(async () => { width = 1400; for (const listener of listeners) listener(); });
    expect(dom.window.document.querySelector('.nr-scroll')?.hasAttribute('inert')).toBe(false);
    expect(dom.window.document.querySelector('.nr-outline')?.hasAttribute('inert')).toBe(false);
    expect(dom.window.document.querySelector('.nr-scrim')?.hasAttribute('data-panel')).toBe(false);
    const previous = commit.mock.calls.length;
    await act(async () => root!.render(createElement(ReadingView, { ...props, progress: 0.7 })));
    expect(commit).toHaveBeenCalledTimes(previous);
    await act(async () => root!.unmount()); root = undefined;
    expect(listeners.size).toBe(0);
  });
});
