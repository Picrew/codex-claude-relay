import { basename } from 'node:path';
import type { SessionCandidate } from './types.js';

export type SelectorKind = 'index' | 'path' | 'id';

export interface SelectorResolution {
  /** Which interpretation actually matched. */
  kind: SelectorKind;
  /** The chosen candidate. */
  candidate: SessionCandidate;
}

export interface SelectorError {
  kind: 'error';
  message: string;
  /** Other candidates that matched when the result was ambiguous, if any. */
  matched?: SessionCandidate[];
}

/**
 * Polymorphic selector resolution for `--pick <selector>`.
 *
 * Rules, in order:
 *   1. all-digits  → 1-based index into the (already-ranked) candidates list
 *   2. contains '/' → path or path-substring match on candidate.path
 *   3. otherwise   → session-id-prefix match on basename(candidate.path)
 *
 * Both providers store their session UUID at the end of the JSONL filename, so
 * matching basename(path) handles both Codex (rollout-<ts>-<uuid>.jsonl) and
 * Claude (<uuid>.jsonl) without provider-specific code.
 */
export function resolveSelector(
  selector: string,
  candidates: SessionCandidate[]
): SelectorResolution | SelectorError {
  const sel = selector.trim();
  if (!sel) {
    return { kind: 'error', message: 'empty selector' };
  }

  // Index (only when the digit string is plausibly an index — a UUID prefix
  // like "32533776" is also all-digits but obviously not a row number, so we
  // only treat it as an index if the value fits within the candidate count).
  if (/^\d+$/.test(sel)) {
    const i = parseInt(sel, 10);
    if (i >= 1 && i <= candidates.length) {
      return { kind: 'index', candidate: candidates[i - 1]! };
    }
    // Out of range — fall through so we try ID-prefix interpretation next.
    // An index that's clearly too large (e.g. > 99) is almost certainly an
    // ID prefix; otherwise we'll report a not-found error below.
  }

  // Path substring
  if (sel.includes('/')) {
    const matched = candidates.filter((c) => c.path.includes(sel));
    if (matched.length === 0) {
      return { kind: 'error', message: `no session whose path contains "${sel}"` };
    }
    if (matched.length > 1) {
      return {
        kind: 'error',
        message: `path substring "${sel}" matched ${matched.length} sessions; narrow it down`,
        matched,
      };
    }
    return { kind: 'path', candidate: matched[0]! };
  }

  // Session-id prefix on basename
  const matched = candidates.filter((c) => basename(c.path, '.jsonl').includes(sel));
  if (matched.length === 0) {
    return { kind: 'error', message: `no session whose id contains "${sel}"` };
  }
  if (matched.length > 1) {
    return {
      kind: 'error',
      message: `id "${sel}" matched ${matched.length} sessions; use a longer prefix`,
      matched,
    };
  }
  return { kind: 'id', candidate: matched[0]! };
}

/** Human-readable relative age, e.g. "1h ago", "3d ago". */
export function relativeAge(mtimeMs: number, nowMs: number = Date.now()): string {
  const ageSec = Math.max(0, (nowMs - mtimeMs) / 1000);
  if (ageSec < 60) return `${Math.round(ageSec)}s ago`;
  const ageMin = ageSec / 60;
  if (ageMin < 60) return `${Math.round(ageMin)}m ago`;
  const ageHr = ageMin / 60;
  if (ageHr < 48) return `${Math.round(ageHr)}h ago`;
  const ageDay = ageHr / 24;
  if (ageDay < 30) return `${Math.round(ageDay)}d ago`;
  const ageMo = ageDay / 30;
  if (ageMo < 24) return `${Math.round(ageMo)}mo ago`;
  return `${Math.round(ageMo / 12)}y ago`;
}
