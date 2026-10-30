import { JSDOM } from 'jsdom';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PageBar } from '../../src/page/Bar';

let dom: JSDOM | undefined;

afterEach(() => {
  dom?.window.close();
  dom = undefined;
  vi.unstubAllGlobals();
});

function page(doctype: boolean, htmlHeight: number, bodyHeight: number, width = 1265) {
  dom = new JSDOM(`${doctype ? '<!doctype html>' : ''}<html><body></body></html>`);
  Object.defineProperties(dom.window, { innerWidth: { value: 1280 }, innerHeight: { value: 1000 } });
  Object.defineProperties(dom.window.document.documentElement, {
    clientWidth: { value: width }, clientHeight: { value: htmlHeight },
  });
  Object.defineProperties(dom.window.document.body, {
    clientWidth: { value: width }, clientHeight: { value: bodyHeight },
  });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  return dom.window.document;
}

function renderedStyle() {
  const markup = renderToStaticMarkup(createElement(PageBar, {
    state: { status: 'idle', total: 0, completed: 0, failed: 0, pending: 0, skipped: 0, limitReached: false },
    hasTranslations: false,
    onTranslate: vi.fn(), onStop: vi.fn(), onRestore: vi.fn(), onRetry: vi.fn(), onSettings: vi.fn(),
  }));
  const style = markup.match(/<aside\b[^>]*\bstyle="([^"]*)"/)?.[1];
  expect(style).toBeDefined();
  return Object.fromEntries(style!.split(';').filter(Boolean).map(declaration => {
    const separator = declaration.indexOf(':');
    return [declaration.slice(0, separator), declaration.slice(separator + 1)];
  }));
}

function expectCenteredInViewport(style: Record<string, string>, viewportHeight = 1000) {
  expect(style.right).toBe('8px');
  expect(style.top).toBe(`${(viewportHeight - 40) / 2}px`);
  expect(Number.parseFloat(style.top!) + 40).toBeLessThan(viewportHeight);
}

describe('page translation button viewport placement', () => {
  it('uses the viewport root in standards mode even when the article body is much taller', () => {
    const document = page(true, 1000, 3314);
    expect(document.compatMode).toBe('CSS1Compat');
    expectCenteredInViewport(renderedStyle());
  });

  it('keeps the button visible on a long page without a doctype', () => {
    // The Qt page exposes the document height on html and the viewport on body.
    const document = page(false, 3314, 1000);
    expect(document.compatMode).toBe('BackCompat');
    expectCenteredInViewport(renderedStyle());
  });

  it('falls back to the window viewport when a quirks-mode body is not available yet', () => {
    const document = page(false, 3314, 1000);
    document.body.remove();
    expect(document.body).toBeNull();
    expectCenteredInViewport(renderedStyle());
  });

  it.each([true, false])('uses window dimensions before the viewport root has layout (doctype: %s)', doctype => {
    page(doctype, 0, 0, 0);
    expectCenteredInViewport(renderedStyle());
  });

  it('can render a stable initial position without browser globals', () => {
    vi.stubGlobal('window', undefined);
    vi.stubGlobal('document', undefined);
    expectCenteredInViewport(renderedStyle(), 768);
  });
});
