import { StringDecoder } from 'node:string_decoder';
import { parseWebUrlFromLine } from './parse';

/** Incrementally scans one process stream without depending on chunk boundaries. */
export class ReadinessScanner {
  private readonly decoder = new StringDecoder('utf8');
  private tail = '';

  write(chunk: Buffer | string): string | null {
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    const combined = this.tail + text;
    const found = parseWebUrlFromLine(combined);
    if (found) return found;

    const lastBreak = Math.max(combined.lastIndexOf('\n'), combined.lastIndexOf('\r'));
    this.tail = (lastBreak >= 0 ? combined.slice(lastBreak + 1) : combined).slice(-8192);
    return null;
  }

  end(): string | null {
    const rest = this.decoder.end();
    return rest ? this.write(rest) : null;
  }
}
