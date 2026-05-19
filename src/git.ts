import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import type { GitContext } from './types.js';

function safeGit(args: string[], cwd: string): string | null {
  try {
    const out = execFileSync('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      timeout: 3000,
    });
    return out.trim();
  } catch {
    return null;
  }
}

/**
 * Detect the git context for the current working directory.
 *
 * If we're not inside a repo we still return a usable context (root = cwd,
 * inRepo = false) so the rest of the pipeline degrades gracefully — callers
 * are expected to warn when inRepo is false.
 */
export function detectGitContext(cwd: string = process.cwd()): GitContext {
  const root = safeGit(['rev-parse', '--show-toplevel'], cwd);
  if (!root) {
    return {
      root: cwd,
      inRepo: false,
      repoName: basename(cwd),
      branch: null,
      statusShort: null,
    };
  }

  const branch =
    safeGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], root) ??
    safeGit(['rev-parse', '--short', 'HEAD'], root);

  // Keep the status excerpt small — we just want a flavor for the prompt.
  let statusShort = safeGit(['status', '--short'], root);
  if (statusShort && statusShort.length > 2000) {
    statusShort = statusShort.slice(0, 2000) + '\n... (truncated)';
  }

  return {
    root,
    inRepo: true,
    repoName: basename(root),
    branch: branch ?? null,
    statusShort,
  };
}

/** Return a short git diff (staged + unstaged) capped at maxChars. */
export function getDiff(root: string, maxChars: number = 6000): string | null {
  const diff = safeGit(['diff', '--no-color', 'HEAD'], root);
  if (!diff) return null;
  if (diff.length <= maxChars) return diff;
  return diff.slice(0, maxChars) + '\n... (diff truncated)';
}
