import { MAX_TEXT_LENGTH } from '../shared/contracts';
import { MODEL_PAGE_POLICY } from '../shared/translation-policy';

/** Bounded request fan-out; the background keeps a separate process-wide limit. */
export const PAGE_CONCURRENCY = MODEL_PAGE_POLICY.concurrency;
export const PAGE_BATCH_TARGET_CHARS = MODEL_PAGE_POLICY.batchTargetChars;
export const PAGE_BATCH_MAX_ITEMS = MODEL_PAGE_POLICY.batchMaxItems;

export function normalizePageBatchTargetChars(value?: number): number {
  return Number.isInteger(value) && value! >= 2 ? Math.min(MAX_TEXT_LENGTH, value!) : PAGE_BATCH_TARGET_CHARS;
}

/** Short independent streams avoid a large paragraph becoming the page's tail. */
export function splitPageBatchText(text: string, targetChars = PAGE_BATCH_TARGET_CHARS): string[] {
  const limit = normalizePageBatchTargetChars(targetChars);
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const prefix = remaining.slice(0, limit);
    const minimum = Math.floor(limit / 2);
    let boundary = -1;
    for (const match of prefix.matchAll(/[.!?。！？](?:["'”’)]*)\s+|\n+/g)) {
      const end = match.index! + match[0].length;
      if (end >= minimum) boundary = end;
    }
    if (boundary < minimum) {
      for (const match of prefix.matchAll(/\s+/g)) {
        const end = match.index! + match[0].length;
        if (end >= minimum) boundary = end;
      }
    }
    if (boundary < minimum) boundary = limit;
    const previous = remaining.charCodeAt(boundary - 1);
    const next = remaining.charCodeAt(boundary);
    if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) boundary--;
    parts.push(remaining.slice(0, boundary));
    remaining = remaining.slice(boundary);
  }
  if (remaining) parts.push(remaining);
  return parts;
}
