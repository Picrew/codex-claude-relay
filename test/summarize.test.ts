import test from 'node:test';
import assert from 'node:assert/strict';
import { renderHandoff } from '../src/summarize.ts';
import type { GitContext, ParsedSession, RelayOptions, TranscriptEvent } from '../src/types.ts';
import { DEFAULT_OPTIONS } from '../src/types.ts';

const git: GitContext = {
  root: '/tmp/foo',
  inRepo: true,
  repoName: 'foo',
  branch: 'main',
  statusShort: ' M src/app.ts',
};

function ev(partial: Partial<TranscriptEvent>): TranscriptEvent {
  return {
    lineNo: 0,
    timestampMs: null,
    kind: 'user_message',
    text: '',
    ...partial,
  };
}

function session(events: TranscriptEvent[]): ParsedSession {
  return {
    path: '/tmp/fake.jsonl',
    recordedCwd: '/tmp/foo',
    recordedBranch: 'main',
    sessionId: 'sess1',
    startedAtMs: Date.now() - 60_000,
    endedAtMs: Date.now() - 10_000,
    parsedLines: events.length,
    skippedLines: 0,
    events,
  };
}

const baseOpts: RelayOptions = { ...DEFAULT_OPTIONS, maxChars: 8000 };

test('renderHandoff contains required sections', () => {
  const s = session([
    ev({ kind: 'user_message', text: 'Add a feature to convert markdown to HTML in src/app.ts' }),
    ev({ kind: 'assistant_message', text: 'I will start by reading the file and outlining the converter approach with a unit test.' }),
    ev({ kind: 'tool_call', text: 'Bash $ npm test', command: 'npm test', toolName: 'Bash' }),
    ev({ kind: 'tool_result', text: 'PASS test/app.test.ts', isError: false }),
    ev({ kind: 'tool_call', text: 'Edit [src/app.ts]', files: ['src/app.ts'], toolName: 'Edit' }),
  ]);

  const out = renderHandoff({
    sourceAgent: 'codex',
    targetAgent: 'claude',
    git,
    session: s,
    options: baseOpts,
  });

  assert.ok(out.text.includes('Repository:'));
  assert.ok(out.text.includes('Original task:'));
  assert.ok(out.text.includes('Files touched or inspected:'));
  assert.ok(out.text.includes('src/app.ts'));
  assert.ok(out.text.includes('Commands run'));
  assert.ok(out.text.includes('npm test'));
  assert.ok(out.text.includes('Safety notes'));
});

test('renderHandoff respects maxChars cap', () => {
  const long = 'word '.repeat(5000);
  const s = session([
    ev({ kind: 'user_message', text: long }),
    ev({ kind: 'assistant_message', text: long }),
  ]);
  const out = renderHandoff({
    sourceAgent: 'codex',
    targetAgent: 'claude',
    git,
    session: s,
    options: { ...baseOpts, maxChars: 1500 },
  });
  assert.ok(out.text.length <= 1600); // 1500 + truncation marker
  assert.ok(out.text.includes('handoff truncated'));
});

test('renderHandoff flags stale sessions', () => {
  const s = session([ev({ kind: 'user_message', text: 'Hello' })]);
  s.endedAtMs = Date.now() - 48 * 60 * 60 * 1000;
  const out = renderHandoff({
    sourceAgent: 'claude',
    targetAgent: 'codex',
    git,
    session: s,
    options: baseOpts,
  });
  assert.ok(out.stale);
  assert.ok(out.text.includes('stale'));
});

test('renderHandoff redacts secrets by default', () => {
  const s = session([
    ev({
      kind: 'user_message',
      text: 'Here is my key: sk-proj-abcdef0123456789ABCDEFGHIJKL',
    }),
  ]);
  const out = renderHandoff({
    sourceAgent: 'codex',
    targetAgent: 'claude',
    git,
    session: s,
    options: baseOpts,
  });
  assert.ok(!out.text.includes('abcdef0123456789ABCDEFGHIJKL'));
});
