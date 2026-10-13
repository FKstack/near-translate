import { describe, expect, it } from 'vitest';
import { parseRemotePdfSource, pdfErrorMessage } from '../../src/pdf/source';

describe('PDF source parsing', () => {
  it('keeps query tokens and ports in requests, strips hashes, grants hostname pattern', () => {
    expect(parseRemotePdfSource(' https://papers.example.com:9443/white%20paper.pdf?token=abc#page=2 ')).toEqual({
      url: 'https://papers.example.com:9443/white%20paper.pdf?token=abc',
      originPattern: 'https://papers.example.com/*', filename: 'white paper.pdf',
    });
  });
  it.each(['file:///C:/paper.pdf', 'javascript:alert(1)', 'https://user:secret@example.com/paper.pdf', 'paper.pdf'])('rejects unsupported source %s', (source) => {
    expect(() => parseRemotePdfSource(source)).toThrow();
  });
  it('tolerates non-decodable filenames without changing the URL', () => {
    expect(parseRemotePdfSource('https://example.com/a%E0.pdf').filename).toBe('a%E0.pdf');
  });
  it('gives download-and-open guidance for remote failures', () => {
    expect(pdfErrorMessage(new Error('HTTP 403'), true)).toContain('下载 PDF');
  });
  it('identifies invalid documents', () => {
    const error = new Error('invalid');
    error.name = 'InvalidPDFException';
    expect(pdfErrorMessage(error, false)).toContain('损坏');
  });
});
