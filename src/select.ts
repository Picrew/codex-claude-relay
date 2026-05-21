import { basename } from 'node:path';
import type { SessionCandidate } from './types.js';

export interface SelectorResolution {
  candidate: SessionCandidate;
}

export interface SelectorError {
  kind: 'error';
  message: string;
  /** Other candidates that matched when the result was ambiguous, if any. */
  matched?: SessionCandidate[];
}

/**
 * Resolve a `--pick` selector against a list of candidates.
 *
 * The selector is a substring of the session UUID. Both Codex and Claude
 * embed the UUID in the JSONL filename, so we match against
 * `basename(path, '.jsonl')`. Matching is exact-substring, case-sensitive.
 *
 * Examples:
 *   --pick ab11e518                       → unique match → win
 *   --pick ab11e518-27f5-4b38              → also wins (longer prefix is fine)
 *   --pick 32533776                       → matches a Codex rollout uuid
 *   --pick 1                              → matches only if exactly one
 *                                            session uuid contains "1"
 *
 * Returns SelectorError on no match or ambiguous match.
 */
export function resolveSelector(
  selector: string,
  candidates: SessionCandidate[]
): SelectorResolution | SelectorError {
  const sel = selector.trim();
  if (!sel) {
    return { kind: 'error', message: 'empty selector' };
  }

  const matched = candidates.filter((c) =>
    basename(c.path, '.jsonl').includes(sel)
  );
  if (matched.length === 0) {
    return {
      kind: 'error',
      message: `no session id contains "${sel}"`,
    };
  }
  if (matched.length > 1) {
    return {
      kind: 'error',
      message: `selector "${sel}" matched ${matched.length} sessions; use a longer prefix`,
      matched,
    };
  }
  return { candidate: matched[0]! };
}

/** Case-insensitive substring filter for original-task previews. */
export function matchesGrep(preview: string, needle: string): boolean {
  if (!needle) return true;
  return preview.toLowerCase().includes(needle.toLowerCase());
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
