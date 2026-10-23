import { ConversionError, LIMITS } from './types';

/** One-based pages; order and repeated pages are intentional for rearrangement. */
export function parsePageRange(value: string, total: number): number[] {
  if (!Number.isSafeInteger(total) || total < 1) throw new ConversionError('PDF 没有可处理的页面。');
  const source = value.trim();
  if (source.length > 5000) throw new ConversionError('页码范围过长，请简化后重试。');
  if (!source || /^(all|全部)$/i.test(source)) {
    if (total > LIMITS.maxPages) throw new ConversionError(`一次最多处理 ${LIMITS.maxPages} 页，请填写页码范围。`);
    return Array.from({ length: total }, (_, index) => index + 1);
  }
  const pages: number[] = [];
  for (const part of source.replace(/[，、]/g, ',').split(',')) {
    const match = /^\s*(\d+)\s*(?:[-–—]\s*(\d+)\s*)?$/.exec(part);
    if (!match) throw new ConversionError('页码请填写为 1-3,5,8；也可用 3,1,2 调整顺序。');
    const first = Number(match[1]), last = Number(match[2] ?? match[1]);
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < 1 || first > total || last > total) throw new ConversionError(`页码超出范围，这个 PDF 共 ${total} 页。`);
    if (pages.length + Math.abs(last - first) + 1 > LIMITS.maxPages) throw new ConversionError(`一次最多处理 ${LIMITS.maxPages} 页。`);
    const step = last < first ? -1 : 1;
    for (let page = first; ; page += step) { pages.push(page); if (page === last) break; }
  }
  return pages;
}
