import { readdir, stat, readFile } from 'node:fs/promises';
import { existsSync, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { parseJsonl, clip } from '../parse/jsonl.js';
import type {
  GitContext,
  ParsedSession,
  SessionCandidate,
  TranscriptEvent,
} from '../types.js';

export const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');

/**
 * Claude Code encodes the project directory by replacing path separators with
 * dashes. e.g. /Users/alice/work/foo -> -Users-alice-work-foo
 *
 * We can't reverse this perfectly (a `-` in a real directory name is ambiguous)
 * but we can compute the most likely encoded name and use it as a fast-path.
 */
export function encodeProjectDir(absPath: string): string {
  // Strip leading sep so the encoded form starts with a dash, matching observed format.
  // Replace any sequence of `sep` with `-`, and inside-segment '-' are kept.
  const normalized = absPath.replace(/\\/g, '/');
  // Replace '/' with '-' and also encode '.' as '-' (Claude's behavior).
  return normalized.replace(/[/\\.]/g, '-');
}

/** Recursively collect `*.jsonl` files under `dir`. */
async function collectJsonl(dir: string, depth: number = 0): Promise<string[]> {
  const out: string[] = [];
  if (depth > 4) return out; // safety
  let entries: Dirent[];
  try {
    entries = (await readdir(dir, { withFileTypes: true })) as Dirent[];
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      // Skip noisy subtrees like tool-results within session dirs.
      if (e.name === 'tool-results' || e.name === 'memory') continue;
      const nested = await collectJsonl(full, depth + 1);
      out.push(...nested);
    } else if (e.isFile() && e.name.endsWith('.jsonl')) {
      out.push(full);
    }
  }
  return out;
}

/** Sample lines of a Claude transcript to detect its recorded cwd. */
async function detectClaudeCwd(path: string): Promise<string | null> {
  // We can't easily peek mid-file; just sample first lines.
  const { records } = await parseJsonl<string>(path, (obj) => {
    if (!obj || typeof obj !== 'object') return null;
    const rec = obj as Record<string, unknown>;
    if (typeof rec.cwd === 'string') return rec.cwd as string;
    return null;
  });
  return records[0] ?? null;
}

/**
 * Discover Claude session JSONL files and rank them.
 *
 * Strategy:
 *   1. Fast path: try `~/.claude/projects/<encoded(root)>/*.jsonl` first; those
 *      get a big score boost.
 *   2. Fallback: scan the full `projects/` tree (one level deep is typical),
 *      detect cwd from each transcript, and rank.
 */
export async function discoverClaudeSessions(git: GitContext): Promise<SessionCandidate[]> {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return [];

  const encoded = encodeProjectDir(git.root);
  const fastPath = join(CLAUDE_PROJECTS_DIR, encoded);

  let paths: string[] = [];
  const fastMatch = existsSync(fastPath);
  if (fastMatch) {
    paths = await collectJsonl(fastPath, 0);
  }

  // Always also do a broad scan so the user can still find sessions even if
  // the project directory encoding has changed.
  const broad = await collectJsonl(CLAUDE_PROJECTS_DIR, 0);
  for (const p of broad) {
    if (!paths.includes(p)) paths.push(p);
  }

  const candidates: SessionCandidate[] = [];
  for (const p of paths) {
    let mtimeMs = 0;
    try {
      const st = await stat(p);
      mtimeMs = st.mtimeMs;
    } catch {
      continue;
    }

    let recordedCwd = await detectClaudeCwd(p);
    const reasons: string[] = [];
    let score = 0;

    if (fastMatch && p.startsWith(fastPath + sep)) {
      score += 40;
      reasons.push('inside encoded project dir');
    }

    if (recordedCwd) {
      if (recordedCwd === git.root) {
        score += 60;
        reasons.push('cwd matches git root exactly');
      } else if (git.inRepo && recordedCwd.startsWith(git.root + sep)) {
        score += 50;
        reasons.push('cwd inside git root');
      } else if (recordedCwd.includes(git.repoName)) {
        score += 20;
        reasons.push(`cwd path mentions repo name "${git.repoName}"`);
      }
    }

    const ageDays = (Date.now() - mtimeMs) / (24 * 3600 * 1000);
    const recency = Math.max(0, 30 * (1 - ageDays / 14));
    score += recency;
    reasons.push(`recency +${recency.toFixed(1)} (age ${ageDays.toFixed(1)}d)`);

    candidates.push({
      path: p,
      mtimeMs,
      recordedCwd,
      score,
      reasons,
    });
  }

  candidates.sort((a, b) => b.score - a.score || b.mtimeMs - a.mtimeMs);
  return candidates;
}

export async function pickClaudeSession(
  git: GitContext,
  forceLast: boolean
): Promise<SessionCandidate | null> {
  const all = await discoverClaudeSessions(git);
  if (all.length === 0) return null;
  if (forceLast) {
    return [...all].sort((a, b) => b.mtimeMs - a.mtimeMs)[0]!;
  }
  return all[0]!;
}

/* ----------------------------- memory ---------------------------------- */

export interface ClaudeMemory {
  exists: boolean;
  dir: string;
  index: string | null;
  /** A short summary string suitable for inclusion in the handoff. */
  summary: string;
}

/**
 * Read the Claude Code auto-memory directory for the current project.
 *
 * Layout: `~/.claude/projects/<encoded>/memory/MEMORY.md` plus arbitrarily-named
 * `.md` files referenced by it.
 */
export async function readClaudeMemory(git: GitContext): Promise<ClaudeMemory> {
  const encoded = encodeProjectDir(git.root);
  const dir = join(CLAUDE_PROJECTS_DIR, encoded, 'memory');
  const result: ClaudeMemory = { exists: false, dir, index: null, summary: '' };
  if (!existsSync(dir)) return result;
  result.exists = true;

  const indexPath = join(dir, 'MEMORY.md');
  if (existsSync(indexPath)) {
    try {
      result.index = await readFile(indexPath, 'utf8');
    } catch {
      result.index = null;
    }
  }

  // Concatenate index + every linked file, capped to keep things compact.
  const parts: string[] = [];
  if (result.index) parts.push(`# MEMORY.md\n${result.index.trim()}`);

  try {
    const entries = await readdir(dir);
    for (const name of entries) {
      if (!name.endsWith('.md') || name === 'MEMORY.md') continue;
      try {
        const content = await readFile(join(dir, name), 'utf8');
        parts.push(`# ${name}\n${content.trim()}`);
      } catch {
        // ignore
      }
      if (parts.join('\n\n').length > 8000) break;
    }
  } catch {
    // ignore
  }

  result.summary = parts.join('\n\n').slice(0, 8000);
  return result;
}

/* ---------------------------- parsing ---------------------------------- */

/**
 * Detect Claude Code framework-injected "user" messages that aren't really the
 * user typing — task-completion notifications, system reminders, image attachment
 * markers, slash-command boilerplate, etc. These pollute the handoff and should
 * be filtered out so only real user instructions remain.
 */
function isClaudeSystemNoise(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return true;
  // Tag-shaped framework messages
  if (/^<(?:task-notification|system-reminder|command-name|command-message|command-args|local-command-stdout|user-prompt-submit-hook|bash-input|bash-stdout|bash-stderr)[\s>]/i.test(t)) {
    return true;
  }
  // Image-attachment markers (one or more, possibly separated by whitespace)
  if (/^(?:\[Image[: ][^\]]+\]\s*)+$/.test(t)) return true;
  if (/^\[Request interrupted by user\]/i.test(t)) return true;
  // Pure tag wrappers like "<...>...</...>" with no other content
  if (/^<[\w-]+>[\s\S]*<\/[\w-]+>\s*$/.test(t) && t.length < 600) return true;
  return false;
}

function asString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Extract human-readable text from a Claude `message.content` value. */
function extractClaudeText(content: unknown): { text: string; toolUses: Array<{ name: string; input: Record<string, unknown> }>; toolResults: Array<{ content: string; isError: boolean }> } {
  const toolUses: Array<{ name: string; input: Record<string, unknown> }> = [];
  const toolResults: Array<{ content: string; isError: boolean }> = [];
  if (typeof content === 'string') return { text: content, toolUses, toolResults };
  if (!Array.isArray(content)) return { text: '', toolUses, toolResults };

  const parts: string[] = [];
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    const obj = c as Record<string, unknown>;
    const t = obj.type;
    if (t === 'text' && typeof obj.text === 'string') {
      parts.push(obj.text);
    } else if (t === 'tool_use') {
      const name = typeof obj.name === 'string' ? obj.name : 'tool';
      const input = (obj.input && typeof obj.input === 'object') ? (obj.input as Record<string, unknown>) : {};
      toolUses.push({ name, input });
    } else if (t === 'tool_result') {
      const inner = obj.content;
      let textOut = '';
      if (typeof inner === 'string') textOut = inner;
      else if (Array.isArray(inner)) {
        for (const it of inner) {
          if (it && typeof it === 'object' && (it as Record<string, unknown>).type === 'text') {
            const tx = (it as Record<string, unknown>).text;
            if (typeof tx === 'string') textOut += tx + '\n';
          }
        }
      }
      const isError = obj.is_error === true;
      toolResults.push({ content: textOut.trim(), isError });
    }
    // skip thinking
  }
  return { text: parts.join('\n').trim(), toolUses, toolResults };
}

/** Convert a Claude tool_use input into a compact summary. */
function summarizeToolUse(name: string, input: Record<string, unknown>): {
  text: string;
  command?: string;
  files?: string[];
} {
  let command: string | undefined;
  const files: string[] = [];

  if (typeof input.command === 'string') command = input.command as string;

  for (const key of ['file_path', 'path', 'notebook_path']) {
    const v = input[key];
    if (typeof v === 'string') files.push(v);
  }
  if (Array.isArray((input as { files?: unknown }).files)) {
    for (const v of (input as { files?: unknown[] }).files ?? []) {
      if (typeof v === 'string') files.push(v);
    }
  }
  // Edit/Write/MultiEdit tools have file_path; Read has file_path; Bash has command.
  // Grep/Glob have `pattern` — include it as part of the summary.
  if (name === 'Grep' || name === 'Glob') {
    const pattern = input.pattern;
    if (typeof pattern === 'string') {
      return { text: `${name} pattern=${clip(pattern, 80)}` };
    }
  }

  let text = name;
  if (command) text += ` $ ${clip(command, 200)}`;
  if (files.length) text += ` [${files.slice(0, 6).join(', ')}]`;
  return { text, command, files: files.length ? files : undefined };
}

export async function parseClaudeSession(path: string): Promise<ParsedSession> {
  const events: TranscriptEvent[] = [];
  let recordedCwd: string | null = null;
  let recordedBranch: string | null = null;
  let sessionId: string | null = null;
  let startedAtMs: number | null = null;
  let endedAtMs: number | null = null;

  const { skipped, records } = await parseJsonl<TranscriptEvent | TranscriptEvent[]>(path, (obj, lineNo) => {
    if (!obj || typeof obj !== 'object') return null;
    const rec = obj as Record<string, unknown>;

    if (typeof rec.cwd === 'string' && !recordedCwd) recordedCwd = rec.cwd as string;
    if (typeof rec.gitBranch === 'string' && !recordedBranch) recordedBranch = rec.gitBranch as string;
    if (typeof rec.sessionId === 'string' && !sessionId) sessionId = rec.sessionId as string;

    const tsStr = typeof rec.timestamp === 'string' ? (rec.timestamp as string) : null;
    const tsMs = tsStr ? Date.parse(tsStr) : NaN;
    const ts = Number.isFinite(tsMs) ? tsMs : null;
    if (ts !== null) {
      if (startedAtMs === null || ts < startedAtMs) startedAtMs = ts;
      if (endedAtMs === null || ts > endedAtMs) endedAtMs = ts;
    }

    const type = rec.type;
    if (type !== 'user' && type !== 'assistant') return null;

    const message = (rec.message ?? {}) as Record<string, unknown>;
    const role = message.role;
    const { text, toolUses, toolResults } = extractClaudeText(message.content);

    const out: TranscriptEvent[] = [];

    if (role === 'user' && type === 'user') {
      // Skip side-chains and internal system reminders.
      if (rec.isSidechain === true) return null;

      if (text && !isClaudeSystemNoise(text)) {
        // Skip pure tool_result echoes (those are emitted from `tool_result` parts).
        out.push({
          lineNo,
          timestampMs: ts,
          kind: 'user_message',
          text,
        });
      }
      for (const r of toolResults) {
        if (!r.content) continue;
        out.push({
          lineNo,
          timestampMs: ts,
          kind: 'tool_result',
          text: clip(r.content, 400),
          isError: r.isError,
        });
      }
    } else if (role === 'assistant' && type === 'assistant') {
      if (text) {
        out.push({
          lineNo,
          timestampMs: ts,
          kind: 'assistant_message',
          text,
        });
      }
      for (const tu of toolUses) {
        const d = summarizeToolUse(tu.name, tu.input);
        out.push({
          lineNo,
          timestampMs: ts,
          kind: 'tool_call',
          text: d.text,
          toolName: tu.name,
          command: d.command,
          files: d.files,
        });
      }
    }

    return out.length > 0 ? out : null;
  });

  for (const r of records) {
    if (Array.isArray(r)) events.push(...r);
    else events.push(r);
  }

  return {
    path,
    recordedCwd,
    recordedBranch,
    sessionId,
    startedAtMs,
    endedAtMs,
    parsedLines: events.length,
    skippedLines: skipped,
    events,
  };
}
