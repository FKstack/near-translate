import { describe, expect, it } from 'vitest';
import type { WordResult } from '../../src/shared/contracts';
import { formatTranslationForCopy, groupWordSenses, MISSING_CONTEXT_NOTE } from '../../src/ui/translator/word-result';

const result: WordResult = {
  kind: 'word', translation: '银行', partOfSpeech: '名词', explanation: '此处指提供金融服务的机构。',
  senses: [
    { partOfSpeech: '名词', meaning: '银行；金融机构' },
    { partOfSpeech: '动词', meaning: '将钱存入银行' },
    { partOfSpeech: '名词', meaning: '河岸；堤岸' },
    { partOfSpeech: '动词', meaning: '使飞机倾斜转弯' },
  ],
};

describe('word dictionary presentation', () => {
  it('groups every meaning by part of speech while preserving each group order', () => {
    expect(groupWordSenses(result.senses)).toEqual([
      { partOfSpeech: '名词', meanings: ['银行；金融机构', '河岸；堤岸'] },
      { partOfSpeech: '动词', meanings: ['将钱存入银行', '使飞机倾斜转弯'] },
    ]);
    expect(result.senses).toHaveLength(4);
  });

  it('copies the contextual meaning, explanation, and all grouped common senses', () => {
    expect(formatTranslationForCopy(result, true)).toBe([
      '本句含义', '银行', '词性：名词', '解释：此处指提供金融服务的机构。', '',
      '常见义项', '名词', '1. 银行；金融机构', '2. 河岸；堤岸', '',
      '动词', '1. 将钱存入银行', '2. 使飞机倾斜转弯',
    ].join('\n'));
  });

  it('labels a context-free result as a reference and retains the full dictionary copy', () => {
    const copied = formatTranslationForCopy(result, false);
    expect(copied.startsWith('参考释义\n')).toBe(true);
    expect(copied).toContain(MISSING_CONTEXT_NOTE);
    expect(copied).not.toContain('本句含义');
    for (const sense of result.senses) expect(copied).toContain(sense.meaning);
  });

  it('keeps paragraph copying unchanged and word meanings as literal plain text', () => {
    const paragraph = '第一段。\n\n第二段包含 <tag> 与 x < 3。';
    expect(formatTranslationForCopy({ kind: 'text', translation: paragraph }, false)).toBe(paragraph);
    const literal = '<img src=x onerror=alert(1)>';
    expect(formatTranslationForCopy({ ...result, senses: [{ partOfSpeech: '名词', meaning: literal }] }, true)).toContain(literal);
  });
});
