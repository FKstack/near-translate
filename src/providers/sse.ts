import { TranslationFailure } from '../core/errors';

const MAX_EVENT_LENGTH = 256_000;

/** Incremental SSE framing, independent of the network and the provider's JSON schema. */
export class SseDecoder {
  private pending = '';
  private data: string[] = [];
  private eventLength = 0;

  push(text: string): string[] {
    this.pending += text;
    const events: string[] = [];
    while (true) {
      const end = this.pending.search(/[\r\n]/);
      if (end < 0 || (this.pending[end] === '\r' && end === this.pending.length - 1)) break;
      const line = this.pending.slice(0, end);
      const delimiterLength = this.pending[end] === '\r' && this.pending[end + 1] === '\n' ? 2 : 1;
      this.pending = this.pending.slice(end + delimiterLength);
      this.consumeLine(line, events);
    }
    this.checkLimit(this.pending.length + this.eventLength);
    return events;
  }

  finish(): string[] {
    const events = this.push('\n');
    if (this.pending) {
      this.consumeLine(this.pending, events);
      this.pending = '';
    }
    this.consumeLine('', events);
    return events;
  }

  private consumeLine(line: string, events: string[]): void {
    if (line === '') {
      if (this.data.length) events.push(this.data.join('\n'));
      this.data = [];
      this.eventLength = 0;
      return;
    }
    if (line === 'data' || line.startsWith('data:')) {
      const value = line === 'data' ? '' : line.slice(5).replace(/^ /, '');
      this.eventLength += value.length + 1;
      this.checkLimit(this.eventLength);
      this.data.push(value);
    }
    // SSE comments, event IDs, and retry fields carry no translation content.
  }

  private checkLimit(length: number): void {
    if (length > MAX_EVENT_LENGTH) {
      throw new TranslationFailure('INVALID_RESPONSE', 'DeepSeek 返回的数据过大，请缩短选区后重试。', true);
    }
  }
}
