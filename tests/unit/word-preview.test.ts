import { describe, expect, it } from 'vitest';
import { WordPreviewDecoder } from '../../src/core/word-preview';

describe('incremental word previews', () => {
  it('publishes contextual fields before dictionary generation finishes, without publishing raw or unfinished JSON', () => {
    const decoder = new WordPreviewDecoder();
    expect(decoder.push('{"translation":"可扩')).toBeUndefined();
    expect(decoder.push('展的"')).toBeUndefined();
    expect(decoder.push(',"partOfSpeech":"形容词",')).toEqual({ translation: '可扩展的', partOfSpeech: '形容词' });
    expect(decoder.push('"explanation":"本句描述系统随规模增长。","senses":[')).toEqual({
      translation: '可扩展的', partOfSpeech: '形容词', explanation: '本句描述系统随规模增长。',
    });
    expect(decoder.push('{"partOfSpeech":"形容词","meaning":"可扩展的"}]}')).toBeUndefined();
  });

  it('handles every character boundary, escaped field names and escaped string contents in any field order', () => {
    const decoder = new WordPreviewDecoder();
    const source = ' {"explanation":"line\\nquote: \\"; path: C:\\\\tmp; letter: \\u4e2d",'
      + '"partOfSpeech":" noun ","translat\\u0069on":" bank "} ';
    const updates = Array.from(source).flatMap(character => {
      const update = decoder.push(character);
      return update ? [update] : [];
    });
    expect(updates).toEqual([
      { explanation: 'line\nquote: "; path: C:\\tmp; letter: 中' },
      { explanation: 'line\nquote: "; path: C:\\tmp; letter: 中', partOfSpeech: 'noun' },
      { explanation: 'line\nquote: "; path: C:\\tmp; letter: 中', partOfSpeech: 'noun', translation: 'bank' },
    ]);
  });

  it('ignores matching names inside unknown strings, objects and arrays', () => {
    const decoder = new WordPreviewDecoder();
    expect(decoder.push(JSON.stringify({
      unknown: { translation: 'nested', deeper: [{ explanation: 'nested too' }] },
      senses: [{ partOfSpeech: 'wrong field', meaning: '} , "translation": "fake"' }],
      ignored: '"translation":"quoted"', truth: true, nothing: null, number: -1.5e3,
      translation: 'correct',
    }))).toEqual({ translation: 'correct' });
  });

  it('only emits changed non-empty string fields and returns independent accumulated snapshots', () => {
    const decoder = new WordPreviewDecoder();
    const first = decoder.push('{"translation":" bank ",');
    expect(first).toEqual({ translation: 'bank' });
    expect(decoder.push('"translation":"bank","partOfSpeech":null,"explanation":"  ",')).toBeUndefined();
    expect(decoder.push('"partOfSpeech":"noun"}')).toEqual({ translation: 'bank', partOfSpeech: 'noun' });
    expect(first).toEqual({ translation: 'bank' });
    expect(decoder.push(' \r\n\t')).toBeUndefined();
  });

  it.each([
    '[{"translation":"wrong root"}]',
    '"translation":"missing object"',
    '{"translation":"unfinished',
    '{"translation":"bad\\q",',
    '{"translation":"bad\\u12xz",',
    '{"translation":"bad\ncontrol",',
    '{"translation":"closed"x,',
    '{"translation":"closed":',
    '{"unknown":[{"translation":"nested"}],"translation":false}',
    '{"unknown":[},"translation":"later"}',
    '{"unknown":invalid,"translation":"later"}',
    '{"unknown":{"bad":"\\q"},"translation":"later"}',
    '{"unknown":0,,"translation":"later"}',
    '{"unknown":0,}',
    '{"translation":"value"} trailing',
  ])('does not publish malformed or non-string prefixes: %s', source => {
    const decoder = new WordPreviewDecoder();
    expect(decoder.push(source)).toBeUndefined();
  });

  it('does not recover previews after malformed input, leaving final failure to the provider', () => {
    const decoder = new WordPreviewDecoder();
    expect(decoder.push('{"translation":"first",')).toEqual({ translation: 'first' });
    expect(decoder.push('"explanation":"bad\\x",')).toBeUndefined();
    expect(decoder.push('"partOfSpeech":"noun"}')).toBeUndefined();
  });
});
