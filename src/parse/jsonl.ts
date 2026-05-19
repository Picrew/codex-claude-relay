import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

export interface JsonlParseResult<T> {
  records: T[];
  skipped: number;
}

/**
 * Stream-parse a JSONL file. Each line is fed to `accept(obj, lineNo)`; if it
 * returns a non-null value the record is kept. Malformed lines are silently
 * counted in `skipped`.
 *
 * We use streaming because Claude/Codex transcripts can be tens of megabytes,
 * and we never need the whole raw array in memory — providers only keep the
 * normalized events.
 */
export async function parseJsonl<T>(
  path: string,
  accept: (obj: unknown, lineNo: number) => T | null
): Promise<JsonlParseResult<T>> {
  const records: T[] = [];
  let skipped = 0;
  let lineNo = 0;

  const stream = createReadStream(path, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const raw of rl) {
    lineNo += 1;
    const line = raw.trim();
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      skipped += 1;
      continue;
    }
    try {
      const kept = accept(obj, lineNo);
      if (kept !== null && kept !== undefined) {
        records.push(kept);
      }
    } catch {
      // accept() threw on a malformed-but-valid-JSON record; skip it.
      skipped += 1;
    }
  }

  return { records, skipped };
}

/**
 * Read just the head of a JSONL file to peek at session metadata cheaply.
 * Returns the first N parsed objects (default 5).
 */
export async function peekJsonl(
  path: string,
  n: number = 5
): Promise<unknown[]> {
  const out: unknown[] = [];
  const stream = createReadStream(path, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const raw of rl) {
    const line = raw.trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // ignore malformed
    }
    if (out.length >= n) {
      rl.close();
      stream.destroy();
      break;
    }
  }

  return out;
}

/** Compactly truncate a string for inclusion in summaries. */
export function clip(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + `... (+${s.length - n} chars)`;
}
