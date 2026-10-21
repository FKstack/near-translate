/** Bounded request fan-out; the background keeps a separate process-wide limit. */
export const PAGE_CONCURRENCY = 32;
export const PAGE_BATCH_TARGET_CHARS = 1_600;
export const PAGE_BATCH_MAX_ITEMS = 16;

/** Short independent streams avoid a large paragraph becoming the page's tail. */
export function splitPageBatchText(text: string): string[] {
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > PAGE_BATCH_TARGET_CHARS) {
    const prefix = remaining.slice(0, PAGE_BATCH_TARGET_CHARS);
    const minimum = Math.floor(PAGE_BATCH_TARGET_CHARS / 2);
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
    if (boundary < minimum) boundary = PAGE_BATCH_TARGET_CHARS;
    const previous = remaining.charCodeAt(boundary - 1);
    const next = remaining.charCodeAt(boundary);
    if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) boundary--;
    parts.push(remaining.slice(0, boundary));
    remaining = remaining.slice(boundary);
  }
  if (remaining) parts.push(remaining);
  return parts;
}
