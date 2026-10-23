import type { WordPreview } from '../shared/contracts';

type Phase = 'start' | 'key-or-end' | 'key' | 'colon' | 'value' | 'string-value' | 'nested-value' | 'primitive-value' | 'separator' | 'done';
const previewKeys = new Set(['translation', 'partOfSpeech', 'explanation']);
const whitespace = (character: string) => character === ' ' || character === '\n' || character === '\r' || character === '\t';

/** Reads complete top-level strings without exposing raw or unfinished model JSON. */
export class WordPreviewDecoder {
  private source = '';
  private cursor = 0;
  private phase: Phase = 'start';
  private invalid = false;
  private allowEnd = true;
  private tokenStart = 0;
  private key = '';
  private escaped = false;
  private inString = false;
  private containers: string[] = [];
  private preview: WordPreview = {};

  push(delta: string): WordPreview | undefined {
    if (this.invalid) return undefined;
    this.source += delta;
    let changed = false;
    try {
      while (this.cursor < this.source.length) {
        const character = this.source[this.cursor]!;
        switch (this.phase) {
          case 'start':
            if (whitespace(character)) break;
            if (character !== '{') throw new Error('Expected a top-level object.');
            this.phase = 'key-or-end';
            break;
          case 'key-or-end':
            if (whitespace(character)) break;
            if (character === '}' && this.allowEnd) { this.phase = 'done'; break; }
            if (character !== '"') throw new Error('Expected a field name.');
            this.tokenStart = this.cursor;
            this.escaped = false;
            this.phase = 'key';
            break;
          case 'key':
            if (this.stringEnds(character)) {
              this.key = JSON.parse(this.source.slice(this.tokenStart, this.cursor + 1)) as string;
              this.phase = 'colon';
            }
            break;
          case 'colon':
            if (whitespace(character)) break;
            if (character !== ':') throw new Error('Expected a field separator.');
            this.phase = 'value';
            break;
          case 'value':
            if (whitespace(character)) break;
            this.tokenStart = this.cursor;
            this.escaped = false;
            if (character === '"') this.phase = 'string-value';
            else if (character === '{' || character === '[') {
              this.containers = [character];
              this.inString = false;
              this.phase = 'nested-value';
            } else {
              this.phase = 'primitive-value';
              continue;
            }
            break;
          case 'string-value':
            if (this.stringEnds(character)) this.phase = 'separator';
            break;
          case 'nested-value':
            if (this.inString) {
              if (this.stringEnds(character)) this.inString = false;
            } else if (character === '"') {
              this.inString = true;
              this.escaped = false;
            } else if (character === '{' || character === '[') this.containers.push(character);
            else if (character === '}' || character === ']') {
              if (this.containers.pop() !== (character === '}' ? '{' : '[')) throw new Error('Mismatched container.');
              if (!this.containers.length) this.phase = 'separator';
            }
            break;
          case 'primitive-value':
            if (whitespace(character) || character === ',' || character === '}') {
              this.phase = 'separator';
              continue;
            }
            break;
          case 'separator': {
            if (whitespace(character)) break;
            if (character !== ',' && character !== '}') throw new Error('Expected a value delimiter.');
            const value: unknown = JSON.parse(this.source.slice(this.tokenStart, this.cursor));
            if (previewKeys.has(this.key) && typeof value === 'string' && value.trim()) {
              const key = this.key as keyof WordPreview;
              const text = value.trim();
              if (this.preview[key] !== text) { this.preview = { ...this.preview, [key]: text }; changed = true; }
            }
            this.allowEnd = false;
            this.phase = character === '}' ? 'done' : 'key-or-end';
            break;
          }
          case 'done':
            if (!whitespace(character)) throw new Error('Unexpected trailing content.');
            break;
        }
        this.cursor++;
      }
    } catch {
      // Final schema validation belongs to the provider. A malformed prefix can
      // no longer produce trustworthy previews, so leave its terminal handling there.
      this.invalid = true;
      return undefined;
    }
    return changed ? { ...this.preview } : undefined;
  }

  private stringEnds(character: string): boolean {
    if (this.escaped) { this.escaped = false; return false; }
    if (character === '\\') { this.escaped = true; return false; }
    return character === '"';
  }
}
