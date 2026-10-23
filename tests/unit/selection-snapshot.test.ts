import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { takeSelectionSnapshot } from '../../src/selection/snapshot';

let dom: JSDOM;

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html lang="zh-CN"><body><div id="content"><p>bank</p><textarea>bank</textarea></div></body></html>',
    { url: 'https://example.test/reader' });
  for (const name of ['window', 'document', 'Element', 'HTMLElement', 'Node', 'ShadowRoot', 'HTMLInputElement', 'HTMLTextAreaElement'] as const) {
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name]);
  }
  const rect = new dom.window.DOMRect(40, 80, 60, 20);
  Object.defineProperty(dom.window.Range.prototype, 'getClientRects', { configurable: true, value: () => [rect] });
  Object.defineProperty(dom.window.Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => rect });
});

afterEach(() => { dom.window.close(); vi.unstubAllGlobals(); });

function selectParagraph(text = 'bank', language?: string): HTMLElement {
  const element = document.querySelector('p')!;
  element.textContent = text;
  if (language) element.lang = language;
  const range = document.createRange(); range.selectNodeContents(element);
  const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  return element;
}

describe('selected content language versus host UI language', () => {
  it('keeps an English PDF word eligible for dictionary details despite the Chinese reader UI', () => {
    const element = selectParagraph();
    const snapshot = takeSelectionSnapshot({ root: document.querySelector<HTMLDivElement>('#content')!, path: [element], includeContext: true,
      languages: { sourceLanguage: 'auto', targetLanguage: 'zh-Hans' }, useDocumentLanguageHint: false });
    expect(snapshot?.input).toMatchObject({ text: 'bank', kind: 'word', sourceLanguage: 'auto', targetLanguage: 'zh-Hans' });
    expect(document.documentElement.lang).toBe('zh-CN');
  });

  it('retains a French web content hint instead of treating an ASCII French word as an English dictionary word', () => {
    const element = selectParagraph('bonjour', 'fr');
    const snapshot = takeSelectionSnapshot({ root: document, path: [element], includeContext: false,
      languages: { sourceLanguage: 'auto', targetLanguage: 'zh-Hans' } });
    expect(snapshot?.input).toMatchObject({ text: 'bonjour', kind: 'text', sourceLanguage: 'fr' });
  });

  it('continues using a web document language when there is no closer content hint', () => {
    document.documentElement.lang = 'fr-FR';
    const element = selectParagraph('bonjour');
    const snapshot = takeSelectionSnapshot({ root: document, path: [element], includeContext: false,
      languages: { sourceLanguage: 'auto', targetLanguage: 'zh-Hans' }, useDocumentLanguageHint: true });
    expect(snapshot?.input).toMatchObject({ text: 'bonjour', kind: 'text', sourceLanguage: 'fr' });
  });

  it('preserves an explicit content language choice when the PDF host language is ignored', () => {
    const element = selectParagraph('bonjour');
    const snapshot = takeSelectionSnapshot({ root: document.querySelector<HTMLDivElement>('#content')!, path: [element], includeContext: false,
      languages: { sourceLanguage: 'fr', targetLanguage: 'zh-Hans' }, useDocumentLanguageHint: false });
    expect(snapshot?.input).toMatchObject({ text: 'bonjour', kind: 'text', sourceLanguage: 'fr' });
  });

  it.each([
    { useDocumentLanguageHint: false, expectedKind: 'word', expectedSource: 'auto' },
    { useDocumentLanguageHint: true, expectedKind: 'text', expectedSource: 'fr' },
  ] as const)('applies the same host-language policy to editable selections: $useDocumentLanguageHint', ({ useDocumentLanguageHint, expectedKind, expectedSource }) => {
    document.documentElement.lang = useDocumentLanguageHint ? 'fr-FR' : 'zh-CN';
    const editable = document.querySelector('textarea')!; editable.setSelectionRange(0, 4);
    const snapshot = takeSelectionSnapshot({ root: document.querySelector<HTMLDivElement>('#content')!, path: [editable], includeContext: false,
      languages: { sourceLanguage: 'auto', targetLanguage: 'zh-Hans' }, useDocumentLanguageHint });
    expect(snapshot?.input).toMatchObject({ text: 'bank', kind: expectedKind, sourceLanguage: expectedSource });
  });
});
