// Core shared types used by parsers, providers, summarizer and launcher.

export type AgentName = 'codex' | 'claude';

export interface GitContext {
  /** Absolute path to git root, or to cwd if not in a git repo. */
  root: string;
  /** True if `root` is actually a git repository top-level. */
  inRepo: boolean;
  /** Last path segment of `root`, used as a name signal during ranking. */
  repoName: string;
  /** Best-effort current branch name, or null if unavailable. */
  branch: string | null;
  /** Truncated `git status --short` output, or null if not in a repo / git missing. */
  statusShort: string | null;
}

export interface SessionCandidate {
  /** Absolute path to the JSONL transcript file. */
  path: string;
  /** mtime of the file in epoch ms. */
  mtimeMs: number;
  /** Working directory recorded inside the transcript (if any). */
  recordedCwd: string | null;
  /** Higher = better match. Producers should set this on a 0..100-ish scale. */
  score: number;
  /** Human-readable reason for the score (debugging / inspect). */
  reasons: string[];
}

/** A normalized event extracted from either Codex or Claude transcripts. */
export interface TranscriptEvent {
  /** Source line index in the JSONL file (for debugging). */
  lineNo: number;
  /** Original epoch ms timestamp if any. Falls back to file mtime ordering. */
  timestampMs: number | null;
  kind:
    | 'user_message'
    | 'assistant_message'
    | 'thinking'
    | 'tool_call'
    | 'tool_result'
    | 'system'
    | 'unknown';
  /** Brief text payload. For tool calls this is a compact summary. */
  text: string;
  /** Tool name if kind === 'tool_call' or 'tool_result'. */
  toolName?: string;
  /** Shell command, if extractable from the tool call. */
  command?: string;
  /** Files that this event touched (read, edited, created). */
  files?: string[];
  /** If the tool result represents an error. */
  isError?: boolean;
}

export interface ParsedSession {
  /** The source JSONL file. */
  path: string;
  /** Working directory recorded in metadata, if any. */
  recordedCwd: string | null;
  /** Recorded git branch, if any. */
  recordedBranch: string | null;
  /** Session id, if any. */
  sessionId: string | null;
  /** Earliest and latest timestamps observed. */
  startedAtMs: number | null;
  endedAtMs: number | null;
  /** Number of lines we successfully parsed. */
  parsedLines: number;
  /** Number of malformed JSONL lines we skipped. */
  skippedLines: number;
  /** All events in original order. */
  events: TranscriptEvent[];
}

export interface HandoffContent {
  /** The fully-rendered prompt string. */
  text: string;
  /** Whether the source session may be stale (older than ~24h). */
  stale: boolean;
  /** Human-readable provenance line, e.g. file path + timestamp. */
  source: string;
  /** Source agent name. */
  sourceAgent: AgentName;
}

export interface RelayOptions {
  /** Force using the latest session regardless of repo match. */
  last: boolean;
  /** Include current git diff in the handoff. */
  withDiff: boolean;
  /** Cap on the rendered handoff prompt length (in characters). */
  maxChars: number;
  /** Print the handoff but do not launch anything. */
  dryRun: boolean;
  /** Disable secret redaction in the handoff (default: redaction ON). */
  noRedact: boolean;
  /** Print verbose info about discovery & parsing. */
  debug: boolean;
  /**
   * Explicit session selector. If null, use auto-pick (ranking-based).
   * Polymorphic — see resolveSelector():
   *   - all digits     → 1-based index into the ranked candidate list
   *   - contains '/'   → path or path-substring match
   *   - otherwise      → session UUID prefix match (matches against basename)
   */
  pick: string | null;
  /**
   * In `relay list`, include score-0 candidates (sessions from unrelated repos
   * that the broad scan swept in). Default: only show candidates with score > 0
   * (i.e. sessions actually relevant to the current repo).
   */
  all: boolean;
}

export const DEFAULT_OPTIONS: RelayOptions = {
  last: false,
  withDiff: false,
  maxChars: 12000,
  dryRun: false,
  noRedact: false,
  debug: false,
  pick: null,
  all: false,
};

/** Compact info for the `relay list` table — one row per candidate. */
export interface SessionListing {
  /** 1-based rank in the list (highest score first). */
  index: number;
  /** Short id (8-char UUID prefix), suitable for `--pick`. */
  shortId: string;
  /** Absolute path to the JSONL transcript. */
  path: string;
  /** mtime in epoch ms. */
  mtimeMs: number;
  /** Ranking score from the discovery step. */
  score: number;
  /** Brief first-user-message preview, capped to ~80 chars. */
  taskPreview: string;
  /** Top scoring reason for the row (debug hint, kept short). */
  topReason: string;
}
