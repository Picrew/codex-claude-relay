import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeProjectDir } from '../src/providers/claude.ts';

test('encodes a typical macOS project path', () => {
  // Claude Code encodes / and . as -.
  assert.equal(
    encodeProjectDir('/Users/alice/Downloads/codex-claude-relay'),
    '-Users-alice-Downloads-codex-claude-relay'
  );
});

test('encodes dots in path segments', () => {
  assert.equal(
    encodeProjectDir('/Users/alice/.codex/worktrees/foo'),
    '-Users-alice--codex-worktrees-foo'
  );
});

test('preserves embedded dashes', () => {
  assert.equal(
    encodeProjectDir('/Users/bob/my-cool-repo'),
    '-Users-bob-my-cool-repo'
  );
});
