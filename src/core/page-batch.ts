import { TranslationFailure } from './errors';

export interface PageBatchEntry { index: number; text: string }

/** Incrementally decodes complete NDJSON records, keeping paragraph IDs separate from model text. */
export class PageBatchDecoder {
  private buffer = '';
  private readonly translations: Array<string | undefined>;
  private count = 0;
  private fence: 'none' | 'open' | 'closed' = 'none';

  constructor(private readonly expected: number) {
    this.translations = Array.from({ length: expected });
  }

  *push(delta: string): Generator<PageBatchEntry> {
    this.buffer += delta;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      const entry = this.line(line);
      // Commit each valid passage before inspecting a later, possibly malformed record.
      if (entry) yield entry;
    }
  }

  finish(): PageBatchEntry[] {
    const entry = this.line(this.buffer.trim());
    this.buffer = '';
    if (this.count !== this.expected || this.fence === 'open') this.invalid();
    return entry ? [entry] : [];
  }

  result(): string[] {
    if (this.count !== this.expected) this.invalid();
    return this.translations.map(text => text!);
  }

  private line(line: string): PageBatchEntry | undefined {
    if (!line) return;
    // Accommodate a single wrapper some models add, but never arbitrary prose or nested wrappers.
    if (this.fence === 'none' && !this.count && /^```(?:json|jsonl|ndjson)?$/i.test(line)) {
      this.fence = 'open';
      return;
    }
    if (this.fence === 'open' && this.count === this.expected && line === '```') {
      this.fence = 'closed';
      return;
    }
    if (this.fence === 'closed') this.invalid();
    let value: unknown;
    try { value = JSON.parse(line); }
    catch { this.invalid(); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) this.invalid();
    const data = value as Record<string, unknown>;
    if (Object.keys(data).length !== 2 || !Number.isInteger(data.i) || typeof data.i !== 'number'
      || data.i < 0 || data.i >= this.expected || typeof data.t !== 'string' || !data.t.trim()
      || this.translations[data.i] !== undefined) this.invalid();
    const text = (data.t as string).trim();
    this.translations[data.i as number] = text;
    this.count++;
    return { index: data.i as number, text };
  }

  private invalid(): never {
    throw new TranslationFailure('INVALID_RESPONSE', '整页译文分段不完整或格式不正确，请重试失败段落。', true);
  }
}
