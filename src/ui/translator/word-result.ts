import type { TranslationResult, WordSense } from '../../shared/contracts';

export interface WordSenseGroup {
  partOfSpeech: string;
  meanings: string[];
}

export const MISSING_CONTEXT_NOTE = '未提供上下文，以下为参考释义；具体含义需结合原句判断。';

/** Keep every returned sense and preserve the first-seen order of parts of speech. */
export function groupWordSenses(senses: readonly WordSense[]): WordSenseGroup[] {
  const groups = new Map<string, WordSenseGroup>();
  for (const sense of senses) {
    let group = groups.get(sense.partOfSpeech);
    if (!group) {
      group = { partOfSpeech: sense.partOfSpeech, meanings: [] };
      groups.set(sense.partOfSpeech, group);
    }
    group.meanings.push(sense.meaning);
  }
  return Array.from(groups.values());
}

export function formatTranslationForCopy(result: TranslationResult, hasContext: boolean): string {
  if (result.kind === 'text') return result.translation;
  const current = [
    hasContext ? '本句含义' : '参考释义',
    result.translation,
    `词性：${result.partOfSpeech}`,
    `解释：${result.explanation}`,
    ...(!hasContext ? [MISSING_CONTEXT_NOTE] : []),
  ].join('\n');
  const senses = groupWordSenses(result.senses).map((group) => [
    group.partOfSpeech,
    ...group.meanings.map((meaning, index) => `${index + 1}. ${meaning}`),
  ].join('\n')).join('\n\n');
  return `${current}\n\n常见义项\n${senses}`;
}
