import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { PageBar } from '../../src/page/Bar';
import type { PageSessionState } from '../../src/page/session';

function markup(state: Partial<PageSessionState>) {
  return renderToStaticMarkup(createElement(PageBar, {
    state: { status: 'idle', total: 0, completed: 0, failed: 0, pending: 0, skipped: 0, limitReached: false, ...state },
    hasTranslations: true, onTranslate: vi.fn(), onStop: vi.fn(), onRestore: vi.fn(), onRetry: vi.fn(), onSettings: vi.fn(),
  }));
}

describe('machine-readable page translation state', () => {
  it('exposes bounded counters without changing the visible buttons', () => {
    const html = markup({ status: 'running', total: 314, completed: 10, failed: 0, pending: 304 });
    for (const attribute of ['data-status="running"', 'data-total="314"', 'data-completed="10"', 'data-failed="0"', 'data-pending="304"']) expect(html).toContain(attribute);
    expect(html).toContain('aria-label="停止翻译"');
    expect(html).not.toContain('data-error-code=');
  });

  it('retains the stopped status and error code even when the error replaces the progress label', () => {
    const html = markup({ status: 'stopped', total: 314, completed: 20, failed: 1, pending: 293,
      error: { code: 'RATE_LIMIT', message: 'DeepL 请求受限，已暂停后续翻译。', retryable: true } });
    expect(html).toContain('data-status="stopped"');
    expect(html).toContain('data-error-code="RATE_LIMIT"');
    expect(html).toContain('DeepL 请求受限');
  });

  it('offers a manual retry for unfinished work with one connection failure message', () => {
    const html = markup({ status: 'stopped', total: 20, completed: 2, failed: 0, pending: 18,
      error: { code: 'NETWORK', message: '无法连接翻译服务。', retryable: true } });
    expect(html.match(/无法连接翻译服务。/g)).toHaveLength(1);
    expect(html).toContain('重试未完成部分');
    expect(html).not.toContain('继续未完成部分');
    expect(html).toContain('aria-label="恢复原文"');
  });
});
