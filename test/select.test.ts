import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSelector, matchesGrep, relativeAge } from '../src/select.ts';
import type { SessionCandidate } from '../src/types.ts';

function cand(path: string, mtimeMs = 0, relevantToRepo = true): SessionCandidate {
  return { path, mtimeMs, recordedCwd: null, relevantToRepo };
}

const sample: SessionCandidate[] = [
  cand('/u/x/.claude/projects/-Users-x-foo/ab11e518-27f5-4b38-ae8d-3ab55384b7dc.jsonl'),
  cand('/u/x/.claude/projects/-Users-x-foo/fda29ad7-506f-4670-8772-f05a7de4e695.jsonl'),
  cand('/u/x/.codex/sessions/2026/05/19/rollout-2026-05-19T14-10-15-019e3edb-3adf-7d21-a33c-484bf81ac19c.jsonl'),
];

/* ----------------- resolveSelector (id-prefix only) ------------------- */

test('resolveSelector: id prefix matches Claude session', () => {
  const r = resolveSelector('ab11e518', sample);
  assert.ok('candidate' in r);
  if ('candidate' in r) {
    assert.ok(r.candidate.path.includes('ab11e518'));
  }
});

test('resolveSelector: id prefix matches Codex session by trailing UUID', () => {
  const r = resolveSelector('019e3edb', sample);
  assert.ok('candidate' in r);
  if ('candidate' in r) {
    assert.ok(r.candidate.path.includes('019e3edb'));
  }
});

test('resolveSelector: digit-only id prefix still works', () => {
  // The user specifically asked that "32533776"-style prefixes work.
  const digits: SessionCandidate[] = [cand('/p/32533776-abc-def.jsonl')];
  const r = resolveSelector('32533776', digits);
  assert.ok('candidate' in r);
});

test('resolveSelector: no match returns error', () => {
  const r = resolveSelector('zzz9999', sample);
  assert.ok('kind' in r && r.kind === 'error');
});

test('resolveSelector: ambiguous prefix returns error with matched list', () => {
  const colliding: SessionCandidate[] = [
    cand('/p/aaa-111.jsonl'),
    cand('/p/aaa-222.jsonl'),
  ];
  const r = resolveSelector('aaa', colliding);
  assert.ok('kind' in r && r.kind === 'error');
  if ('matched' in r) {
    assert.equal(r.matched?.length, 2);
  }
});

test('resolveSelector: empty selector errors', () => {
  const r = resolveSelector('', sample);
  assert.ok('kind' in r && r.kind === 'error');
});

test('resolveSelector: whitespace-only selector errors', () => {
  const r = resolveSelector('   ', sample);
  assert.ok('kind' in r && r.kind === 'error');
});

test('resolveSelector: longer prefix disambiguates', () => {
  const colliding: SessionCandidate[] = [
    cand('/p/aaa-111.jsonl'),
    cand('/p/aaa-222.jsonl'),
  ];
  const r = resolveSelector('aaa-2', colliding);
  assert.ok('candidate' in r);
  if ('candidate' in r) {
    assert.ok(r.candidate.path.includes('aaa-222'));
  }
});

/* ----------------------------- matchesGrep ---------------------------- */

test('matchesGrep: case-insensitive substring', () => {
  assert.ok(matchesGrep('Add Rate Limiting to /api/upload', 'rate limit'));
  assert.ok(matchesGrep('FIX BUILD', 'build'));
});

test('matchesGrep: empty needle matches everything', () => {
  assert.ok(matchesGrep('anything', ''));
});

test('matchesGrep: no match returns false', () => {
  assert.equal(matchesGrep('Add rate limiting', 'auth'), false);
});

/* ----------------------------- relativeAge ---------------------------- */

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

test('relativeAge: future timestamps clamp to 0s', () => {
  const now = Date.now();
  assert.match(relativeAge(now + 5_000, now), /^0s ago$/);
});
