import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSelector, relativeAge } from '../src/select.ts';
import type { SessionCandidate } from '../src/types.ts';

function cand(path: string, score: number, mtimeMs = 0): SessionCandidate {
  return {
    path,
    score,
    mtimeMs,
    recordedCwd: null,
    reasons: [],
  };
}

const sample: SessionCandidate[] = [
  cand('/u/x/.claude/projects/-Users-x-foo/ab11e518-27f5-4b38-ae8d-3ab55384b7dc.jsonl', 130),
  cand('/u/x/.claude/projects/-Users-x-foo/fda29ad7-506f-4670-8772-f05a7de4e695.jsonl', 95),
  cand('/u/x/.codex/sessions/2026/05/19/rollout-2026-05-19T14-10-15-019e3edb-3adf-7d21-a33c-484bf81ac19c.jsonl', 80),
];

test('resolveSelector: index picks the right row', () => {
  const r = resolveSelector('1', sample);
  assert.equal(r.kind, 'index');
  assert.ok('candidate' in r);
  if ('candidate' in r) {
    assert.equal(r.candidate.score, 130);
  }
});

test('resolveSelector: index out of range falls through to id-lookup then errors', () => {
  // "99" is digits, doesn't match a candidate id either → final error.
  const r = resolveSelector('99', sample);
  assert.equal(r.kind, 'error');
});

test('resolveSelector: digit-only string that matches an id is treated as id', () => {
  // 019e3edb starts with "019e", but the trailing parts of the path include
  // "484bf81ac19c" — and Codex IDs have digit-runs in them. Use a deliberately
  // digit-heavy id prefix that doesn't fit an index.
  const digitsOnly: SessionCandidate[] = [
    {
      path: '/sessions/123456789abc.jsonl',
      score: 1,
      mtimeMs: 0,
      recordedCwd: null,
      reasons: [],
    },
  ];
  const r = resolveSelector('123456789', digitsOnly);
  assert.equal(r.kind, 'id');
});

test('resolveSelector: index 0 errors (1-based)', () => {
  // 0 isn't a valid 1-based index, and "0" probably isn't a session id either.
  const r = resolveSelector('0', sample);
  assert.equal(r.kind, 'error');
});

test('resolveSelector: id prefix matches Claude session', () => {
  const r = resolveSelector('ab11e518', sample);
  assert.equal(r.kind, 'id');
  if ('candidate' in r) {
    assert.ok(r.candidate.path.includes('ab11e518'));
  }
});

test('resolveSelector: id prefix matches Codex session by tail UUID', () => {
  const r = resolveSelector('019e3edb', sample);
  assert.equal(r.kind, 'id');
  if ('candidate' in r) {
    assert.ok(r.candidate.path.includes('019e3edb'));
  }
});

test('resolveSelector: ambiguous id prefix errors with matches', () => {
  // Both Claude session IDs share no common prefix in this set; build a colliding case.
  const colliding: SessionCandidate[] = [
    cand('/p/aaa-1.jsonl', 1),
    cand('/p/aaa-2.jsonl', 2),
  ];
  const r = resolveSelector('aaa', colliding);
  assert.equal(r.kind, 'error');
  if ('matched' in r && r.matched) {
    assert.equal(r.matched.length, 2);
  }
});

test('resolveSelector: id with no match errors', () => {
  const r = resolveSelector('zzz9999', sample);
  assert.equal(r.kind, 'error');
});

test('resolveSelector: path substring with / matches unique session', () => {
  const r = resolveSelector('2026/05/19', sample);
  assert.equal(r.kind, 'path');
  if ('candidate' in r) {
    assert.ok(r.candidate.path.includes('2026/05/19'));
  }
});

test('resolveSelector: path substring with multiple matches errors', () => {
  const r = resolveSelector('-Users-x-foo/', sample);
  assert.equal(r.kind, 'error');
});

test('resolveSelector: empty selector errors', () => {
  const r = resolveSelector('', sample);
  assert.equal(r.kind, 'error');
});

test('resolveSelector: whitespace-only selector errors', () => {
  const r = resolveSelector('   ', sample);
  assert.equal(r.kind, 'error');
});

test('relativeAge: seconds', () => {
  const now = Date.now();
  assert.match(relativeAge(now - 5_000, now), /^\d+s ago$/);
});

test('relativeAge: minutes', () => {
  const now = Date.now();
  assert.match(relativeAge(now - 5 * 60_000, now), /^\d+m ago$/);
});

test('relativeAge: hours', () => {
  const now = Date.now();
  assert.match(relativeAge(now - 3 * 3600_000, now), /^\d+h ago$/);
});

test('relativeAge: days', () => {
  const now = Date.now();
  assert.match(relativeAge(now - 5 * 86_400_000, now), /^\d+d ago$/);
});

test('relativeAge: future or zero returns 0s', () => {
  const now = Date.now();
  assert.match(relativeAge(now + 5_000, now), /^0s ago$/);
});
