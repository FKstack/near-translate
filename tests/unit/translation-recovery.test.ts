import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecoveryAction, recoveryDeadline, translationRecovery, useTranslationRecovery } from '../../src/ui/translation/RecoveryAction';
import { PageBar, type PageBarProps } from '../../src/page/Bar';
import { ReadingView, type ReadingViewProps } from '../../src/reading/ReadingView';
import { Translator, type TranslatorView } from '../../src/ui/translator/Translator';
import type { TranslationError, TranslationServiceStatus } from '../../src/shared/contracts';
import { DEFAULT_READING_PREFERENCES } from '../../src/shared/reading';

const rate = (retryAt?: number): TranslationError => ({ code: 'RATE_LIMIT', message: 'DeepL 请求受限。', retryable: true, retryAt });
const status = (cooldownUntil: number): TranslationServiceStatus => ({ engine: 'deepl-web', cooldownUntil, checkedAt: 1_000 });
let dom: JSDOM | undefined;
let root: Root | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined; dom?.window.close(); dom = undefined;
  vi.useRealTimers(); vi.unstubAllGlobals();
});

function page(changes: Partial<PageBarProps> = {}) {
  const props: PageBarProps = {
    state: { status: 'stopped', total: 3, completed: 1, failed: 0, pending: 2, skipped: 0, limitReached: false },
    hasTranslations: true, onTranslate: vi.fn(), onStop: vi.fn(), onRestore: vi.fn(), onRetry: vi.fn(), onContinue: vi.fn(), onSettings: vi.fn(),
    ...changes,
  };
  return renderToStaticMarkup(createElement(PageBar, props));
}

function reading(changes: Partial<ReadingViewProps> = {}) {
  const props: ReadingViewProps = {
    article: { title: 'Reading recovery', byline: '', siteName: 'Example', sourceUrl: 'https://example.test/article', lang: 'en', excerpt: '',
      wordCount: 500, readingMinutes: 2, content: {} as HTMLElement, outline: [], sourceMap: new Map(), strategy: 'readability', truncated: false },
    preferences: { ...DEFAULT_READING_PREFERENCES },
    translation: { status: 'stopped', total: 3, completed: 1, failed: 0, pending: 2 }, progress: 0.2,
    articleRef: vi.fn(), onPreferences: vi.fn(), onClose: vi.fn(), onTranslate: vi.fn(), onStop: vi.fn(), onRetry: vi.fn(), onSettings: vi.fn(), onHeading: vi.fn(),
    ...changes,
  };
  return renderToStaticMarkup(createElement(ReadingView, props));
}

function documentFor(html: string): Document {
  dom = new JSDOM(html); return dom.window.document;
}

describe('manual translation recovery presentation', () => {
  it('merges local and service deadlines into one bounded countdown', () => {
    expect(recoveryDeadline(rate(2_000), status(3_500))).toBe(3_500);
    expect(translationRecovery(rate(2_000), status(3_500), 1_000)).toMatchObject({ action: 'retry', blocked: true, remainingSeconds: 3 });
    expect(translationRecovery(rate(2_000), status(3_500), 3_500)).toMatchObject({ action: 'retry', blocked: false, remainingSeconds: 0 });
    expect(translationRecovery(rate(), undefined, 1_000).message).toContain('请稍后');
    for (const value of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER]) expect(recoveryDeadline(rate(value))).toBe(0);
  });

  it.each(['NETWORK', 'TIMEOUT'] as const)('offers manual retry for %s', code => {
    expect(translationRecovery({ code, message: '请重试', retryable: false })).toMatchObject({ action: 'retry', blocked: false, message: '请重试' });
  });

  it.each(['CONFIG', 'AUTH'] as const)('offers settings for %s without disabling settings during service cooldown', code => {
    const recovery = translationRecovery({ code, message: '请检查服务设置', retryable: false }, status(5_000), 1_000);
    const doc = documentFor(renderToStaticMarkup(createElement(RecoveryAction, { recovery, onSettings: vi.fn(), onRetry: vi.fn() })));
    expect(doc.querySelector('button')?.textContent).toBe('打开设置');
    expect(doc.querySelector('button')?.disabled).toBe(false);
  });

  it('keeps retry disabled until expiry and never starts it automatically', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000);
    dom = new JSDOM('<!doctype html><div id="root"></div>');
    vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const retry = vi.fn();
    function Harness() {
      const recovery = useTranslationRecovery(rate(3_500), status(3_000));
      return createElement('div', null, createElement('p', { role: 'status' }, recovery.message),
        createElement(RecoveryAction, { recovery, onRetry: retry }));
    }
    root = createRoot(dom.window.document.getElementById('root')!);
    await act(async () => root!.render(createElement(Harness)));
    const button = dom.window.document.querySelector('button')!;
    expect(button.disabled).toBe(true); expect(dom.window.document.body.textContent).toContain('3 秒后');
    await act(async () => { button.click(); await vi.advanceTimersByTimeAsync(1_000); });
    expect(button.disabled).toBe(true); expect(dom.window.document.body.textContent).toContain('2 秒后');
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    expect(button.disabled).toBe(false); expect(retry).not.toHaveBeenCalled();
    await act(async () => button.click()); expect(retry).toHaveBeenCalledTimes(1);
    await act(async () => root!.unmount()); root = undefined;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans up an active countdown when its view unmounts', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000);
    dom = new JSDOM('<!doctype html><div id="root"></div>');
    vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    function Harness() { const recovery = useTranslationRecovery(rate(10_000)); return createElement('p', null, recovery.message); }
    root = createRoot(dom.window.document.getElementById('root')!);
    await act(async () => root!.render(createElement(Harness))); expect(vi.getTimerCount()).toBe(1);
    await act(async () => root!.unmount()); root = undefined;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('provides page continuation and preserves failure retry labels', () => {
    expect(page()).toContain('继续未完成部分');
    expect(page({ state: { status: 'done', total: 3, completed: 1, failed: 2, pending: 0, skipped: 0, limitReached: false } }))
      .toContain('重试失败段落');
  });

  it('blocks page continuation on service cooldown without duplicating the countdown', () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000);
    const doc = documentFor(page({ serviceStatus: status(4_000) }));
    const continuation = [...doc.querySelectorAll('button')].find(button => button.textContent === '继续未完成部分');
    expect(continuation?.disabled).toBe(true);
    expect(doc.querySelector<HTMLButtonElement>('[aria-label="恢复原文"]')?.disabled).toBe(false);
    expect((doc.body.textContent?.match(/秒后可手动重试/g) ?? [])).toHaveLength(1);
  });

  it('blocks a fresh page translation during service cooldown while leaving local reading available', () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000);
    const doc = documentFor(page({ state: { status: 'idle', total: 0, completed: 0, failed: 0, pending: 0, skipped: 0, limitReached: false },
      hasTranslations: false, onRead: vi.fn(), serviceStatus: status(4_000) }));
    expect(doc.querySelector<HTMLButtonElement>('[aria-label="翻译整个页面"]')?.disabled).toBe(true);
    expect(doc.querySelector<HTMLButtonElement>('[aria-label="阅读模式"]')?.disabled).toBe(false);
  });

  it('preserves reading continuation accessibility while gating it on the shared service cooldown', () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000);
    const doc = documentFor(reading({ serviceStatus: status(4_000) }));
    const button = doc.querySelector<HTMLButtonElement>('[aria-label="继续翻译"]');
    expect(button?.textContent).toContain('继续未完成部分'); expect(button?.disabled).toBe(true);
    expect((doc.body.textContent?.match(/秒后可手动重试/g) ?? [])).toHaveLength(1);
  });

  it('offers settings for a reading authorization error while preserving completed content controls', () => {
    const html = reading({ translation: { status: 'stopped', total: 3, completed: 1, failed: 1, pending: 1,
      error: { code: 'AUTH', message: '检查授权', retryable: false } } });
    expect(html).toContain('打开设置'); expect(html).not.toContain('重试失败段落');
    expect(html).toContain('正文显示模式'); expect(html).toContain('退出阅读模式');
  });

  it('uses generic selection labels and hides English analysis for unsupported language pairs', () => {
    const selection = { input: { kind: 'text' as const, text: 'A supported source sentence.', sourceLanguage: 'en' as const, targetLanguage: 'ja' as const },
      signature: 'test', anchor: { x: 0, y: 0 } };
    const props = { source: 'web' as const, onTranslate: vi.fn(), onClose: vi.fn(), onRetry: vi.fn(), onSettings: vi.fn(), onRetryAnalysis: vi.fn() };
    const trigger: TranslatorView = { mode: 'button', selection };
    expect(renderToStaticMarkup(createElement(Translator, { ...props, view: trigger }))).toContain('aria-label="翻译选中文字"');
    const view: TranslatorView = { mode: 'card', selection, status: 'done', streamed: '', result: { kind: 'text', translation: '翻訳' }, analysis: { status: 'loading' } };
    const html = renderToStaticMarkup(createElement(Translator, { ...props, view }));
    expect(html).toContain('aria-label="翻译结果"'); expect(html).toContain('日语'); expect(html).not.toContain('长难句拆解');
  });
});
