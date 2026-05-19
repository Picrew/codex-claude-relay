import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseJsonl, peekJsonl, clip } from '../src/parse/jsonl.ts';

function tmpFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'relay-test-'));
  const p = join(dir, 'sample.jsonl');
  writeFileSync(p, content);
  return p;
}

test('parseJsonl skips malformed lines and counts them', async () => {
  const path = tmpFile(
    [
      '{"a":1}',
      'this is not json',
      '{"a":2}',
      '',
      '{"a":3}',
    ].join('\n')
  );
  const { records, skipped } = await parseJsonl<number>(path, (obj) => {
    if (obj && typeof obj === 'object' && 'a' in (obj as Record<string, unknown>)) {
      return (obj as { a: number }).a;
    }
    return null;
  });
  assert.deepEqual(records, [1, 2, 3]);
  assert.equal(skipped, 1);
});

test('peekJsonl returns first N records and stops', async () => {
  const lines = Array.from({ length: 50 }, (_, i) => `{"i":${i}}`).join('\n');
  const path = tmpFile(lines);
  const head = await peekJsonl(path, 3);
  assert.equal(head.length, 3);
  assert.deepEqual(head, [{ i: 0 }, { i: 1 }, { i: 2 }]);
});

test('clip leaves short strings alone and trims long ones', () => {
  assert.equal(clip('hello', 10), 'hello');
  const long = 'x'.repeat(50);
  const clipped = clip(long, 20);
  assert.ok(clipped.startsWith('x'.repeat(20)));
  assert.ok(clipped.includes('+30 chars'));
});
