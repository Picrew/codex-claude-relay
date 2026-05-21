import { readdir, stat } from 'node:fs/promises';
import { existsSync, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { findInJsonl, parseJsonl, peekJsonl, clip } from '../parse/jsonl.js';
import type {
  GitContext,
  ParsedSession,
  SessionCandidate,
  TranscriptEvent,
} from '../types.js';

export const CODEX_SESSIONS_DIR = join(homedir(), '.codex', 'sessions');

/** Recursively collect `rollout-*.jsonl` files under `dir`. */
async function collectRollouts(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: Dirent[];
  try {
    entries = (await readdir(dir, { withFileTypes: true })) as Dirent[];
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      const nested = await collectRollouts(full);
      out.push(...nested);
    } else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
      out.push(full);
    }
  }
  return out;
}

/** Read the first object of a rollout JSONL to extract the recorded cwd. */
async function readCodexMeta(path: string): Promise<{ cwd: string | null; ts: string | null }> {
  try {
    const head = await peekJsonl(path, 1);
    const first = head[0] as Record<string, unknown> | undefined;
    if (!first || first.type !== 'session_meta') return { cwd: null, ts: null };
    const payload = first.payload as Record<string, unknown> | undefined;
    const cwd = typeof payload?.cwd === 'string' ? (payload.cwd as string) : null;
    const ts = typeof payload?.timestamp === 'string' ? (payload.timestamp as string) : null;
    return { cwd, ts };
  } catch {
    return { cwd: null, ts: null };
  }
}

/**
 * Discover Codex rollout files and rank them by relevance to the current git
 * context. Returns the candidates sorted best-first.
 */
export async function discoverCodexSessions(git: GitContext): Promise<SessionCandidate[]> {
  if (!existsSync(CODEX_SESSIONS_DIR)) return [];
  const paths = await collectRollouts(CODEX_SESSIONS_DIR);

  const candidates: SessionCandidate[] = [];
  for (const p of paths) {
    let mtimeMs = 0;
    try {
      const st = await stat(p);
      mtimeMs = st.mtimeMs;
    } catch {
      continue;
    }

    const meta = await readCodexMeta(p);
    const reasons: string[] = [];
    let score = 0;

    if (meta.cwd) {
      if (meta.cwd === git.root) {
        score += 60;
        reasons.push('cwd matches git root exactly');
      } else if (git.inRepo && meta.cwd.startsWith(git.root + sep)) {
        score += 50;
        reasons.push('cwd inside git root');
      } else if (meta.cwd.includes(git.repoName)) {
        score += 25;
        reasons.push(`cwd path mentions repo name "${git.repoName}"`);
      }
    }

    // Recency weight: linear decay over 14 days, max 30 points.
    const ageDays = (Date.now() - mtimeMs) / (24 * 3600 * 1000);
    const recency = Math.max(0, 30 * (1 - ageDays / 14));
    score += recency;
    reasons.push(`recency +${recency.toFixed(1)} (age ${ageDays.toFixed(1)}d)`);

    candidates.push({
      path: p,
      mtimeMs,
      recordedCwd: meta.cwd,
      score,
      reasons,
    });
  }

  candidates.sort((a, b) => b.score - a.score || b.mtimeMs - a.mtimeMs);
  return candidates;
}

/** Pick the best Codex session. With `forceLast`, always pick the most recent by mtime. */
export async function pickCodexSession(
  git: GitContext,
  forceLast: boolean
): Promise<SessionCandidate | null> {
  const all = await discoverCodexSessions(git);
  if (all.length === 0) return null;
  if (forceLast) {
    return [...all].sort((a, b) => b.mtimeMs - a.mtimeMs)[0]!;
  }
  return all[0]!;
}

/**
 * Extract the UUID portion of a Codex rollout filename.
 *   rollout-2026-05-19T14-10-15-019e3edb-3adf-7d21-a33c-484bf81ac19c.jsonl
 *                                ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
 * Codex IDs are RFC 4122-like with 5 dash-separated segments, so the
 * trailing 5 segments of the basename give us the id.
 */
export function codexSessionId(path: string): string {
  const base = basename(path, '.jsonl');
  const parts = base.split('-');
  // Defensive: file naming may evolve, fall back to whole basename.
  if (parts.length < 5) return base;
  return parts.slice(-5).join('-');
}

/**
 * Cheaply peek the first substantial user message in a Codex rollout, capped
 * to ~`n` chars. Streams and bails early; safe even for huge rollouts.
 */
export async function peekCodexOriginalTask(
  path: string,
  n: number = 80
): Promise<string> {
  const text = await findInJsonl<string>(
    path,
    (obj) => {
      if (!obj || typeof obj !== 'object') return null;
      const rec = obj as Record<string, unknown>;
      if (rec.type !== 'response_item') return null;
      const payload = rec.payload as Record<string, unknown> | undefined;
      if (!payload || payload.type !== 'message') return null;
      if (payload.role !== 'user') return null;
      const content = payload.content;
      if (!Array.isArray(content)) return null;
      let out = '';
      for (const c of content) {
        if (!c || typeof c !== 'object') continue;
        const t = (c as Record<string, unknown>).text;
        if (typeof t === 'string') out += t;
      }
      out = out.trim();
      if (out.length < 12) return null;
      // Skip environment_context noise.
      if (/^<environment_context>/.test(out)) return null;
      return out;
    },
    400 // most rollouts have the first user message well within the first 400 lines
  );
  if (!text) return '(no user message found)';
  return clip(text.replace(/\s+/g, ' '), n);
}

/* ----------------------------- parsing --------------------------------- */

function asString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Extract text out of Codex's `content` array on message payloads. */
function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    const obj = c as Record<string, unknown>;
    if (typeof obj.text === 'string') parts.push(obj.text);
    else if (typeof obj.content === 'string') parts.push(obj.content);
  }
  return parts.join('\n').trim();
}

/** Heuristically pull file paths and a shell command out of a Codex function_call. */
function describeFunctionCall(payload: Record<string, unknown>): {
  text: string;
  command?: string;
  files?: string[];
  toolName: string;
} {
  const name = asString(payload.name || 'tool');
  const rawArgs = payload.arguments;
  let args: Record<string, unknown> = {};
  if (typeof rawArgs === 'string') {
    try {
      args = JSON.parse(rawArgs);
    } catch {
      // Some function calls embed plain text — that's fine.
    }
  } else if (rawArgs && typeof rawArgs === 'object') {
    args = rawArgs as Record<string, unknown>;
  }

  let command: string | undefined;
  const files: string[] = [];

  // Common Codex tools.
  if (typeof args.cmd === 'string') command = args.cmd;
  else if (typeof args.command === 'string') command = args.command;
  else if (Array.isArray(args.command)) command = (args.command as unknown[]).join(' ');

  // File-shaped args
  for (const key of ['path', 'file', 'filename', 'target']) {
    const v = args[key];
    if (typeof v === 'string') files.push(v);
  }
  if (Array.isArray(args.paths)) {
    for (const v of args.paths as unknown[]) {
      if (typeof v === 'string') files.push(v);
    }
  }

  // apply_patch — try to extract touched paths from a unified-diff-ish input.
  if (name === 'apply_patch' && typeof args.input === 'string') {
    const re = /^(?:\*\*\* (?:Update|Add|Delete) File: |\+\+\+ b\/|--- a\/)(.+)$/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(args.input as string)) !== null) {
      const p = m[1]?.trim();
      if (p) files.push(p);
    }
  }

  let text = `${name}`;
  if (command) text += ` $ ${clip(command, 200)}`;
  if (files.length > 0) text += ` [${files.slice(0, 6).join(', ')}]`;

  return { text, command, files: files.length ? files : undefined, toolName: name };
}

/** Compact a function_call_output payload for the summary. */
function describeFunctionCallOutput(payload: Record<string, unknown>): {
  text: string;
  isError: boolean;
} {
  const raw = asString(payload.output ?? payload.content ?? '');
  // Strip Codex's wrapper prefix lines like "Chunk ID:", "Wall time:", etc.
  const stripped = raw
    .replace(/^Chunk ID:.*$/gm, '')
    .replace(/^Wall time:.*$/gm, '')
    .replace(/^Original token count:.*$/gm, '')
    .replace(/^Output:\s*/m, '')
    .trim();

  const isError =
    /Process exited with code (?!0)\d+/.test(raw) ||
    /\bError\b/i.test(stripped.slice(0, 200));

  return { text: clip(stripped, 400), isError };
}

/** Parse a full Codex rollout JSONL into normalized events. */
export async function parseCodexSession(path: string): Promise<ParsedSession> {
  const events: TranscriptEvent[] = [];
  let recordedCwd: string | null = null;
  let sessionId: string | null = null;
  let startedAtMs: number | null = null;
  let endedAtMs: number | null = null;

  const { skipped, records } = await parseJsonl(path, (obj, lineNo) => {
    if (!obj || typeof obj !== 'object') return null;
    const rec = obj as Record<string, unknown>;
    const tsStr = typeof rec.timestamp === 'string' ? (rec.timestamp as string) : null;
    const tsMs = tsStr ? Date.parse(tsStr) : NaN;
    const ts = Number.isFinite(tsMs) ? tsMs : null;
    if (ts !== null) {
      if (startedAtMs === null || ts < startedAtMs) startedAtMs = ts;
      if (endedAtMs === null || ts > endedAtMs) endedAtMs = ts;
    }

    const type = rec.type;
    const payload = (rec.payload ?? {}) as Record<string, unknown>;

    if (type === 'session_meta') {
      if (typeof payload.cwd === 'string') recordedCwd = payload.cwd as string;
      if (typeof payload.id === 'string') sessionId = payload.id as string;
      return null;
    }

    if (type === 'response_item') {
      const pt = payload.type;
      if (pt === 'message') {
        const role = payload.role as string | undefined;
        const text = extractMessageText(payload.content);
        if (!text) return null;
        if (role === 'user') {
          // Skip environment_context noise.
          if (/^<environment_context>/m.test(text)) return null;
          const ev: TranscriptEvent = {
            lineNo,
            timestampMs: ts,
            kind: 'user_message',
            text,
          };
          return ev;
        }
        if (role === 'assistant') {
          const ev: TranscriptEvent = {
            lineNo,
            timestampMs: ts,
            kind: 'assistant_message',
            text,
          };
          return ev;
        }
        if (role === 'developer' || role === 'system') {
          return null; // not useful in the handoff
        }
      }
      if (pt === 'reasoning') {
        // We intentionally skip Codex internal reasoning — too noisy & private.
        return null;
      }
      if (pt === 'function_call') {
        const d = describeFunctionCall(payload);
        const ev: TranscriptEvent = {
          lineNo,
          timestampMs: ts,
          kind: 'tool_call',
          text: d.text,
          toolName: d.toolName,
          command: d.command,
          files: d.files,
        };
        return ev;
      }
      if (pt === 'function_call_output') {
        const d = describeFunctionCallOutput(payload);
        const ev: TranscriptEvent = {
          lineNo,
          timestampMs: ts,
          kind: 'tool_result',
          text: d.text,
          isError: d.isError,
        };
        return ev;
      }
    }

    // event_msg / turn_context / token_count / etc. — ignore for the handoff.
    return null;
  });

  events.push(...records);

  return {
    path,
    recordedCwd,
    recordedBranch: null,
    sessionId,
    startedAtMs,
    endedAtMs,
    parsedLines: events.length,
    skippedLines: skipped,
    events,
  };
}
