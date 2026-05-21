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
  /** True if the recorded cwd is inside the current git root (or equals it). */
  relevantToRepo: boolean;
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
   * Session-id selector (substring match on the session UUID embedded in the
   * JSONL filename). Examples: `ab11e518`, `32533776`. Null = auto-pick the
   * most recent session for the current repo.
   */
  pick: string | null;
  /**
   * Case-insensitive substring filter against each session's original-task
   * preview. On `list`, narrows the table; on `claude`/`codex`, requires the
   * filter to match exactly one session.
   */
  grep: string | null;
  /**
   * Include sessions whose recorded cwd is outside the current git root.
   * Default: only sessions for this repo.
   */
  all: boolean;
}

export const DEFAULT_OPTIONS: RelayOptions = {
  withDiff: false,
  maxChars: 12000,
  dryRun: false,
  noRedact: false,
  debug: false,
  pick: null,
  grep: null,
  all: false,
};

/** Compact info for the `relay list` table — one row per candidate. */
export interface SessionListing {
  /** Short id (~12-char UUID prefix), suitable for copy-paste into `--pick`. */
  shortId: string;
  /** Absolute path to the JSONL transcript. */
  path: string;
  /** mtime in epoch ms. */
  mtimeMs: number;
  /** Brief first-user-message preview, capped to ~80 chars. */
  taskPreview: string;
}
