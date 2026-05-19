import type {
  AgentName,
  GitContext,
  HandoffContent,
  ParsedSession,
  RelayOptions,
  TranscriptEvent,
} from './types.js';
import { clip } from './parse/jsonl.js';
import { redact } from './redact.js';

const STALE_MS = 24 * 60 * 60 * 1000;

interface DigestBuckets {
  originalTask: string;
  userInstructions: string[];
  assistantPlans: string[];
  filesTouched: string[];
  commands: Array<{ cmd: string; failed: boolean }>;
  todos: string[];
  errors: string[];
  recentMessages: string[];
}

/** Pull a compact digest out of a parsed session. */
function digest(session: ParsedSession): DigestBuckets {
  const out: DigestBuckets = {
    originalTask: '',
    userInstructions: [],
    assistantPlans: [],
    filesTouched: [],
    commands: [],
    todos: [],
    errors: [],
    recentMessages: [],
  };

  const events = session.events;
  if (events.length === 0) return out;

  // First substantial user message is the original task — remember its lineNo
  // so we exclude exactly that event (not by text, which loses identity after clipping).
  let originalTaskLineNo: number | null = null;
  for (const ev of events) {
    if (ev.kind !== 'user_message') continue;
    if (ev.text.trim().length < 12) continue;
    out.originalTask = clip(ev.text.trim(), 1500);
    originalTaskLineNo = ev.lineNo;
    break;
  }

  // Walk events to bucketize.
  const seenFiles = new Set<string>();
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;

    if (ev.kind === 'user_message' && ev.lineNo !== originalTaskLineNo) {
      out.userInstructions.push(clip(ev.text.trim(), 600));
    }

    if (ev.kind === 'assistant_message') {
      const txt = ev.text.trim();
      // Heuristic: short assistant messages are status pings; longer ones often
      // contain plans, decisions, summaries. Keep the longer ones.
      if (txt.length > 80) {
        out.assistantPlans.push(clip(txt, 800));
      }
      // Pull explicit TODO/plan markers regardless of length.
      const todoMatches = txt.match(/^[\-*]\s*(?:TODO|FIXME|Next)[:.\-]?\s+.+$/gim);
      if (todoMatches) {
        for (const m of todoMatches) out.todos.push(m.trim());
      }
    }

    if (ev.kind === 'tool_call') {
      if (ev.files) {
        for (const f of ev.files) {
          if (!seenFiles.has(f)) {
            seenFiles.add(f);
            out.filesTouched.push(f);
          }
        }
      }
      if (ev.command) {
        // Determine if a subsequent result indicates failure.
        let failed = false;
        for (let j = i + 1; j < Math.min(events.length, i + 4); j++) {
          const next = events[j]!;
          if (next.kind === 'tool_result') {
            failed = !!next.isError;
            break;
          }
          if (next.kind === 'tool_call') break;
        }
        out.commands.push({ cmd: clip(ev.command, 200), failed });
      }
    }

    if (ev.kind === 'tool_result' && ev.isError && ev.text) {
      out.errors.push(clip(ev.text, 240));
    }
  }

  // Recent conversation slice: last 6 user/assistant messages.
  const tail = events.filter(
    (e) => e.kind === 'user_message' || e.kind === 'assistant_message'
  );
  out.recentMessages = tail.slice(-6).map((e) => {
    const who = e.kind === 'user_message' ? 'User' : 'Assistant';
    return `${who}: ${clip(e.text.trim(), 500)}`;
  });

  // De-duplicate while keeping order.
  out.userInstructions = dedupe(out.userInstructions).slice(-6);
  out.assistantPlans = dedupe(out.assistantPlans).slice(-4);
  out.todos = dedupe(out.todos).slice(0, 10);
  out.errors = dedupe(out.errors).slice(-5);
  out.filesTouched = dedupe(out.filesTouched).slice(0, 25);
  // Keep the last N commands; failed ones get priority.
  out.commands = pickCommands(out.commands, 12);

  return out;
}

function dedupe(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    const key = x.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(x);
  }
  return out;
}

function pickCommands(
  cmds: Array<{ cmd: string; failed: boolean }>,
  limit: number
): Array<{ cmd: string; failed: boolean }> {
  const seen = new Set<string>();
  const unique: typeof cmds = [];
  for (const c of cmds) {
    if (seen.has(c.cmd)) continue;
    seen.add(c.cmd);
    unique.push(c);
  }
  if (unique.length <= limit) return unique;
  // Keep all failed + most recent successful commands.
  const failed = unique.filter((c) => c.failed);
  const ok = unique.filter((c) => !c.failed);
  const okTail = ok.slice(-(limit - failed.length));
  return [...failed, ...okTail].slice(-limit);
}

function bullet(items: string[], fallback: string): string {
  if (items.length === 0) return `- ${fallback}`;
  return items.map((x) => `- ${x.replace(/\n+/g, ' ')}`).join('\n');
}

export interface RenderInput {
  sourceAgent: AgentName;
  targetAgent: AgentName;
  git: GitContext;
  session: ParsedSession;
  /** Optional extra memory blob (Claude project memory). */
  memorySummary?: string | null;
  /** Optional current `git diff` blob to append. */
  diff?: string | null;
  options: RelayOptions;
}

export function renderHandoff(input: RenderInput): HandoffContent {
  const { sourceAgent, targetAgent, git, session, options } = input;
  const d = digest(session);

  const mtime = session.endedAtMs ?? session.startedAtMs ?? 0;
  const stale = mtime > 0 ? Date.now() - mtime > STALE_MS : false;
  const sourceLine = `${session.path} (last activity ${
    mtime ? new Date(mtime).toISOString() : 'unknown'
  })`;

  const sourceLabel = sourceAgent === 'codex' ? 'OpenAI Codex CLI' : 'Anthropic Claude Code';
  const targetLabel = targetAgent === 'codex' ? 'OpenAI Codex CLI' : 'Anthropic Claude Code';

  const sections: string[] = [];

  sections.push(
    `You are continuing work in this repository after a context handoff from ${sourceLabel} to ${targetLabel}.`
  );
  sections.push(
    `This handoff was synthesized by \`codex-claude-relay\` from the prior agent's native local transcript. ` +
      `It is a *summary*, not a literal session import — treat it as background context, then verify the current repository state before acting.`
  );

  if (stale) {
    sections.push(
      `⚠ Source session is stale (last activity > 24h ago at ${new Date(mtime).toISOString()}). Other changes may have happened since.`
    );
  }
  if (!git.inRepo) {
    sections.push(
      `⚠ The current working directory is not inside a git repository — file paths from the transcript may not resolve here.`
    );
  }

  sections.push(
    [
      'Repository:',
      `- Path: ${git.root}`,
      `- Branch: ${git.branch ?? '(unknown)'}`,
      `- Repo name: ${git.repoName}`,
      git.statusShort
        ? `- Git status summary:\n${indent(clip(git.statusShort, 1200), '  ')}`
        : '- Git status summary: (clean or unavailable)',
    ].join('\n')
  );

  sections.push(
    [
      'Original task:',
      d.originalTask ? indent(d.originalTask, '  ') : '  - (no user message recorded)',
    ].join('\n')
  );

  sections.push(
    [
      'Subsequent user instructions:',
      bullet(d.userInstructions, '(no further instructions captured)'),
    ].join('\n')
  );

  sections.push(
    [
      'What has already been done / key decisions:',
      bullet(d.assistantPlans, '(no substantial assistant summaries captured)'),
    ].join('\n')
  );

  sections.push(
    [
      'Files touched or inspected:',
      bullet(d.filesTouched, '(none captured)'),
    ].join('\n')
  );

  sections.push(
    [
      'Commands run (★ = errored):',
      d.commands.length === 0
        ? '- (none captured)'
        : d.commands.map((c) => `- ${c.failed ? '★ ' : ''}\`${c.cmd}\``).join('\n'),
    ].join('\n')
  );

  if (d.errors.length > 0) {
    sections.push(
      [
        'Errors observed:',
        d.errors.map((e) => `- ${e.replace(/\n+/g, ' ')}`).join('\n'),
      ].join('\n')
    );
  }

  if (d.todos.length > 0) {
    sections.push(
      [
        'Open TODOs from transcript:',
        d.todos.map((t) => `- ${t}`).join('\n'),
      ].join('\n')
    );
  }

  sections.push(
    [
      'Recent conversation tail:',
      d.recentMessages.length === 0
        ? '- (no recent messages)'
        : d.recentMessages.map((m) => `- ${m}`).join('\n'),
    ].join('\n')
  );

  if (input.memorySummary) {
    sections.push(
      [
        'Claude Code auto-memory for this project:',
        '```',
        clip(input.memorySummary, 4000),
        '```',
      ].join('\n')
    );
  }

  if (input.diff) {
    sections.push(
      [
        'Current git diff (HEAD vs working tree):',
        '```diff',
        input.diff,
        '```',
      ].join('\n')
    );
  }

  sections.push(
    [
      'Safety notes for you, the receiving agent:',
      '- Do not assume the prior agent\'s conclusions are still correct.',
      '- Re-check current file contents and `git status` / `git diff` before editing.',
      '- Prefer the live repository state over anything implied by this transcript.',
      '- If something here looks wrong or outdated, ask the user before destructive action.',
    ].join('\n')
  );

  sections.push(`(Handoff generated by codex-claude-relay; source: ${sourceLine})`);

  let text = sections.join('\n\n');
  if (!options.noRedact) text = redact(text);

  // Hard cap. We try not to chop mid-section: if we overshoot, drop the
  // memory + recent conversation tail first.
  if (text.length > options.maxChars) {
    text = text.slice(0, options.maxChars) + '\n... (handoff truncated)';
  }

  return {
    text,
    stale,
    source: sourceLine,
    sourceAgent,
  };
}

function indent(s: string, prefix: string): string {
  return s
    .split('\n')
    .map((line) => prefix + line)
    .join('\n');
}
