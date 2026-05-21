#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { detectGitContext, getDiff } from './git.js';
import {
  pickCodexSession,
  parseCodexSession,
  discoverCodexSessions,
  codexSessionId,
  peekCodexOriginalTask,
  CODEX_SESSIONS_DIR,
} from './providers/codex.js';
import {
  pickClaudeSession,
  parseClaudeSession,
  discoverClaudeSessions,
  readClaudeMemory,
  claudeSessionId,
  peekClaudeOriginalTask,
  CLAUDE_PROJECTS_DIR,
} from './providers/claude.js';
import { renderHandoff } from './summarize.js';
import { launchAgentAsync, hasBinary } from './launch.js';
import { resolveSelector, relativeAge, matchesGrep } from './select.js';
import { DEFAULT_OPTIONS } from './types.js';
import type { AgentName, RelayOptions, SessionCandidate } from './types.js';

const VERSION = '0.1.2';

const HELP = `codex-claude-relay v${VERSION} — stateless handoff between Codex CLI and Claude Code

Usage:
  relay <target>            Launch the target agent with a handoff from the OTHER agent
  relay preview <target>    Print the handoff that would be sent (no launch)
  relay list <target>       List candidate source sessions for this repo
  relay inspect             Show discovery results without parsing or launching
  relay --help              Show this help
  relay --version           Show version

Targets:
  claude   Handoff Codex -> Claude Code (reads ~/.codex/sessions, launches \`claude\`)
  codex    Handoff Claude Code -> Codex (reads ~/.claude/projects, launches \`codex\`)

Picking which session to hand off (default: most recent in this repo):

  --pick ID-PREFIX    A substring of the session UUID, e.g. --pick ab11e518.
                      Must match exactly one session (use a longer prefix if not).
  --grep TEXT         Case-insensitive substring filter over each session's
                      original-task preview. On \`list\` it narrows the table; on
                      \`claude\`/\`codex\` it must match exactly one session.

Other options:
  --all               Include sessions whose recorded cwd is outside this repo
                      (by default \`list\` shows only sessions for the current repo)
  --with-diff         Append \`git diff HEAD\` to the handoff
  --max-chars N       Cap the handoff size (default ${DEFAULT_OPTIONS.maxChars})
  --dry-run           Build & print the handoff, do not launch the target agent
  --no-redact         Disable secret redaction (default: ON)
  --debug             Verbose discovery / parsing info on stderr

Examples:
  relay claude                              # most recent Codex session for this repo
  relay list codex                          # see candidate Claude sessions for this repo
  relay list codex --grep "rate limit"      # narrow the list to those mentioning "rate limit"
  relay codex --pick ab11e518               # hand off a specific session by id prefix
  relay codex --grep "rate limit"           # ditto, by content match (must be unique)
  relay codex --with-diff
  relay preview claude --max-chars 6000
  relay inspect
`;

interface ParsedArgs {
  cmd: 'claude' | 'codex' | 'preview' | 'list' | 'inspect' | 'help' | 'version';
  target?: AgentName;
  options: RelayOptions;
  positional: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const options: RelayOptions = { ...DEFAULT_OPTIONS };
  let cmd: ParsedArgs['cmd'] = 'help';
  let target: AgentName | undefined;

  let i = 0;
  while (i < argv.length) {
    const a = argv[i]!;
    if (a === '--help' || a === '-h') {
      cmd = 'help';
      return { cmd, options, positional };
    }
    if (a === '--version' || a === '-v') {
      cmd = 'version';
      return { cmd, options, positional };
    }
    if (a === '--last') {
      // Backward-compat alias: in v0.1.1 this meant "skip ranking and use the
      // most recent". v0.1.2 makes that the default, so it's a no-op now.
      // Kept to avoid breaking old scripts.
      i += 1;
      continue;
    }
    if (a === '--with-diff') {
      options.withDiff = true;
      i += 1;
      continue;
    }
    if (a === '--dry-run') {
      options.dryRun = true;
      i += 1;
      continue;
    }
    if (a === '--no-redact') {
      options.noRedact = true;
      i += 1;
      continue;
    }
    if (a === '--debug') {
      options.debug = true;
      i += 1;
      continue;
    }
    if (a === '--all') {
      options.all = true;
      i += 1;
      continue;
    }
    if (a === '--max-chars') {
      const next = argv[i + 1];
      const n = next ? parseInt(next, 10) : NaN;
      if (!Number.isFinite(n) || n < 500) {
        process.stderr.write(`codex-claude-relay: --max-chars requires a positive integer >= 500\n`);
        process.exit(2);
      }
      options.maxChars = n;
      i += 2;
      continue;
    }
    if (a.startsWith('--max-chars=')) {
      const n = parseInt(a.slice('--max-chars='.length), 10);
      if (!Number.isFinite(n) || n < 500) {
        process.stderr.write(`codex-claude-relay: --max-chars requires a positive integer >= 500\n`);
        process.exit(2);
      }
      options.maxChars = n;
      i += 1;
      continue;
    }
    if (a === '--pick') {
      const next = argv[i + 1];
      if (!next || next.startsWith('-')) {
        process.stderr.write(`codex-claude-relay: --pick requires a session id (or id prefix, e.g. ab11e518)\n`);
        process.exit(2);
      }
      options.pick = next;
      i += 2;
      continue;
    }
    if (a.startsWith('--pick=')) {
      const v = a.slice('--pick='.length);
      if (!v) {
        process.stderr.write(`codex-claude-relay: --pick requires a session id\n`);
        process.exit(2);
      }
      options.pick = v;
      i += 1;
      continue;
    }
    if (a === '--grep') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        process.stderr.write(`codex-claude-relay: --grep requires a text argument\n`);
        process.exit(2);
      }
      options.grep = next;
      i += 2;
      continue;
    }
    if (a.startsWith('--grep=')) {
      options.grep = a.slice('--grep='.length);
      i += 1;
      continue;
    }
    if (a.startsWith('-')) {
      process.stderr.write(`codex-claude-relay: unknown option ${a}\n`);
      process.exit(2);
    }
    positional.push(a);
    i += 1;
  }

  if (positional.length === 0) {
    cmd = 'help';
    return { cmd, options, positional };
  }

  const head = positional[0]!;
  if (head === 'claude' || head === 'codex') {
    cmd = head;
    target = head;
  } else if (head === 'preview') {
    cmd = 'preview';
    const t = positional[1];
    if (t === 'claude' || t === 'codex') target = t;
    else {
      process.stderr.write(`codex-claude-relay: \`preview\` requires a target: \`relay preview claude\` or \`relay preview codex\`\n`);
      process.exit(2);
    }
  } else if (head === 'list') {
    cmd = 'list';
    const t = positional[1];
    if (t === 'claude' || t === 'codex') target = t;
    else {
      process.stderr.write(`codex-claude-relay: \`list\` requires a target: \`relay list claude\` or \`relay list codex\`\n`);
      process.exit(2);
    }
  } else if (head === 'inspect') {
    cmd = 'inspect';
  } else if (head === 'help') {
    cmd = 'help';
  } else if (head === 'version') {
    cmd = 'version';
  } else {
    process.stderr.write(`codex-claude-relay: unknown command "${head}"\n`);
    process.exit(2);
  }

  return { cmd, options, positional, target };
}

function debug(opts: RelayOptions, msg: string): void {
  if (opts.debug) process.stderr.write(`[relay] ${msg}\n`);
}

/**
 * Resolve which source session to use. Returns null on hard error (already
 * reported to stderr).
 *
 * Resolution priority:
 *   1. --pick <id> → unique session whose UUID contains the substring
 *   2. --grep <text> → unique session whose original-task preview contains the
 *                       substring (case-insensitive)
 *   3. (default) → most recent session whose recorded cwd is inside this repo
 */
async function pickSourceSession(
  target: AgentName,
  opts: RelayOptions
): Promise<{ candidate: SessionCandidate; sourceAgent: AgentName; git: ReturnType<typeof detectGitContext> } | null> {
  const git = detectGitContext(process.cwd());
  if (!git.inRepo) {
    process.stderr.write(
      `codex-claude-relay: warning — current directory is not a git repo. Falling back to cwd: ${git.root}\n`
    );
  }
  debug(opts, `git root: ${git.root} (inRepo=${git.inRepo})`);

  const sourceAgent: AgentName = target === 'claude' ? 'codex' : 'claude';
  debug(opts, `source agent: ${sourceAgent}, target agent: ${target}`);

  // Discover everything; the providers return them sorted by mtime desc.
  let all: SessionCandidate[];
  if (sourceAgent === 'codex') {
    if (!existsSync(CODEX_SESSIONS_DIR)) {
      process.stderr.write(
        `codex-claude-relay: no Codex session directory found at ${CODEX_SESSIONS_DIR}.\n` +
          `  Run Codex CLI at least once to generate transcripts.\n`
      );
      return null;
    }
    all = await discoverCodexSessions(git);
  } else {
    if (!existsSync(CLAUDE_PROJECTS_DIR)) {
      process.stderr.write(
        `codex-claude-relay: no Claude Code projects directory found at ${CLAUDE_PROJECTS_DIR}.\n` +
          `  Run Claude Code at least once to generate transcripts.\n`
      );
      return null;
    }
    all = await discoverClaudeSessions(git);
  }

  if (all.length === 0) {
    process.stderr.write(`codex-claude-relay: no ${sourceAgent} sessions found on disk.\n`);
    return null;
  }

  if (opts.pick && opts.grep) {
    process.stderr.write(`codex-claude-relay: pass either --pick or --grep, not both.\n`);
    return null;
  }

  // --pick searches across ALL sessions, including ones from other repos
  // (you explicitly typed the id, so you know what you want).
  if (opts.pick) {
    const res = resolveSelector(opts.pick, all);
    if ('kind' in res && res.kind === 'error') {
      process.stderr.write(`codex-claude-relay: --pick ${opts.pick}: ${res.message}\n`);
      if (res.matched && res.matched.length > 1) {
        for (const m of res.matched.slice(0, 5)) {
          process.stderr.write(`  - ${m.path}\n`);
        }
      }
      process.stderr.write(`  Use \`relay list ${target}\` to see candidates.\n`);
      return null;
    }
    debug(opts, `--pick "${opts.pick}" → ${(res as { candidate: SessionCandidate }).candidate.path}`);
    return { candidate: (res as { candidate: SessionCandidate }).candidate, sourceAgent, git };
  }

  // --grep: peek the original task of each candidate (in priority order:
  // current repo first; with --all, fall back to others).
  if (opts.grep) {
    const pool = opts.all ? all : all.filter((c) => c.relevantToRepo);
    if (pool.length === 0) {
      process.stderr.write(
        `codex-claude-relay: --grep "${opts.grep}": no sessions to search (none for this repo). ` +
          `Try --all to search all sessions on disk.\n`
      );
      return null;
    }
    const peek = sourceAgent === 'codex' ? peekCodexOriginalTask : peekClaudeOriginalTask;
    const previews = await Promise.all(pool.map((c) => peek(c.path, 240)));
    const matches: SessionCandidate[] = [];
    for (let i = 0; i < pool.length; i++) {
      if (matchesGrep(previews[i]!, opts.grep)) matches.push(pool[i]!);
    }
    if (matches.length === 0) {
      process.stderr.write(
        `codex-claude-relay: --grep "${opts.grep}": no session's original task matched.\n` +
          `  Use \`relay list ${target} --grep "${opts.grep}"\` to inspect, or widen with --all.\n`
      );
      return null;
    }
    if (matches.length > 1) {
      process.stderr.write(
        `codex-claude-relay: --grep "${opts.grep}": matched ${matches.length} sessions, narrow it down:\n`
      );
      for (const m of matches.slice(0, 5)) {
        process.stderr.write(`  - ${m.path}\n`);
      }
      return null;
    }
    debug(opts, `--grep "${opts.grep}" → ${matches[0]!.path}`);
    return { candidate: matches[0]!, sourceAgent, git };
  }

  // Default: most recent session whose recorded cwd is inside this repo.
  const candidate = all.find((c) => c.relevantToRepo);
  if (!candidate) {
    process.stderr.write(
      `codex-claude-relay: no ${sourceAgent} session was recorded inside this repo (${git.root}).\n` +
        `  Try one of:\n` +
        `    relay list ${target} --all              # see all sessions on disk\n` +
        `    relay ${target} --pick <id-prefix>      # use a specific session\n`
    );
    return null;
  }
  debug(opts, `default → most recent for repo: ${candidate.path}`);
  return { candidate, sourceAgent, git };
}

async function runHandoff(target: AgentName, opts: RelayOptions, mode: 'launch' | 'preview'): Promise<number> {
  const picked = await pickSourceSession(target, opts);
  if (!picked) return 1;
  const { candidate, sourceAgent, git } = picked;
  process.stderr.write(
    `codex-claude-relay: using ${sourceAgent} session ${candidate.path.split('/').pop()}\n`
  );

  if (sourceAgent === 'codex') {
    const session = await parseCodexSession(candidate.path);
    debug(opts, `parsed ${session.parsedLines} events, skipped ${session.skippedLines} malformed lines`);
    const diff = opts.withDiff && git.inRepo ? getDiff(git.root, 6000) : null;
    const handoff = renderHandoff({
      sourceAgent,
      targetAgent: target,
      git,
      session,
      diff,
      options: opts,
    });
    return finishHandoff(target, handoff.text, opts, mode);
  } else {
    const session = await parseClaudeSession(candidate.path);
    debug(opts, `parsed ${session.parsedLines} events, skipped ${session.skippedLines} malformed lines`);
    const mem = await readClaudeMemory(git);
    debug(opts, `claude memory: exists=${mem.exists} bytes=${mem.summary.length}`);
    const diff = opts.withDiff && git.inRepo ? getDiff(git.root, 6000) : null;
    const handoff = renderHandoff({
      sourceAgent,
      targetAgent: target,
      git,
      session,
      memorySummary: mem.exists ? mem.summary : null,
      diff,
      options: opts,
    });
    return finishHandoff(target, handoff.text, opts, mode);
  }
}

async function finishHandoff(
  target: AgentName,
  prompt: string,
  opts: RelayOptions,
  mode: 'launch' | 'preview'
): Promise<number> {
  if (mode === 'preview' || opts.dryRun) {
    if (opts.dryRun && mode === 'launch') {
      process.stderr.write(
        `codex-claude-relay: --dry-run — printing handoff (would launch \`${target}\`)\n\n`
      );
    }
    process.stdout.write(prompt);
    if (!prompt.endsWith('\n')) process.stdout.write('\n');
    return 0;
  }

  if (!hasBinary(target)) {
    process.stderr.write(
      `codex-claude-relay: \`${target}\` is not on PATH. Install it (or use \`relay preview ${target}\` / \`--dry-run\`).\n`
    );
    return 127;
  }

  process.stderr.write(`codex-claude-relay: launching \`${target}\` with handoff (${prompt.length} chars)\n`);
  const res = await launchAgentAsync({ agent: target, prompt });
  return res.code;
}

function padR(s: string, width: number): string {
  if (s.length >= width) return s;
  return s + ' '.repeat(width - s.length);
}

function padL(s: string, width: number): string {
  if (s.length >= width) return s;
  return ' '.repeat(width - s.length) + s;
}

async function runList(target: AgentName, opts: RelayOptions): Promise<number> {
  // `list <target>` shows the OTHER agent's sessions (the source for handoff).
  // e.g. `relay list codex` → list Claude sessions (the source) for handoff TO Codex.
  const sourceAgent: AgentName = target === 'claude' ? 'codex' : 'claude';
  const git = detectGitContext(process.cwd());
  if (!git.inRepo) {
    process.stderr.write(
      `codex-claude-relay: warning — current directory is not a git repo. Falling back to cwd: ${git.root}\n`
    );
  }

  let discovered: SessionCandidate[];
  if (sourceAgent === 'codex') {
    discovered = existsSync(CODEX_SESSIONS_DIR) ? await discoverCodexSessions(git) : [];
  } else {
    discovered = existsSync(CLAUDE_PROJECTS_DIR) ? await discoverClaudeSessions(git) : [];
  }

  const sourceLabel = sourceAgent === 'codex' ? 'Codex CLI' : 'Claude Code';
  const header = `codex-claude-relay v${VERSION} — ${sourceLabel} sessions for ${git.root}`;
  process.stdout.write(header + '\n');
  process.stdout.write('-'.repeat(Math.min(header.length, 100)) + '\n');

  if (discovered.length === 0) {
    process.stdout.write(`\n  (no ${sourceLabel} sessions found on disk)\n`);
    return 0;
  }

  // Default: only sessions whose recorded cwd is inside this repo.
  // --all opens the gate to everything.
  const inRepo = discovered.filter((c) => c.relevantToRepo);
  const pool = opts.all ? discovered : inRepo;

  if (pool.length === 0) {
    process.stdout.write(
      `\n  No ${sourceLabel} sessions were recorded inside this repo.\n` +
        `  ${discovered.length} sessions found on disk overall.\n` +
        `  Try \`relay list ${target} --all\` to see them, or \`cd\` into the right repo.\n`
    );
    return 0;
  }

  const LIMIT = 10;
  // Peek original task text for the pool head — these reads are mostly IO-bound
  // and cheap (`findInJsonl` bails out at first user message).
  const peek = sourceAgent === 'codex' ? peekCodexOriginalTask : peekClaudeOriginalTask;
  const previewLen = opts.grep ? 240 : 90; // wider window when grepping content
  const headPool = pool.slice(0, Math.max(LIMIT * 3, 30)); // peek up to 30 for grep
  const previews = await Promise.all(headPool.map((c) => peek(c.path, previewLen)));

  const filtered = headPool
    .map((c, i) => ({ c, preview: previews[i]! }))
    .filter(({ preview }) => (opts.grep ? matchesGrep(preview, opts.grep) : true));

  if (opts.grep && filtered.length === 0) {
    process.stdout.write(
      `\n  No ${sourceLabel} sessions matched --grep "${opts.grep}"` +
        `${opts.all ? '' : ' (within this repo)'}.\n` +
        `  ${opts.all ? '' : 'Try --all to widen the search.'}\n`
    );
    return 0;
  }

  const rows = filtered.slice(0, LIMIT).map(({ c, preview }) => {
    const id =
      sourceAgent === 'codex' ? codexSessionId(c.path) : claudeSessionId(c.path);
    const shortId = id.length > 13 ? id.slice(0, 12) + '…' : id;
    // For display, keep preview compact even if we peeked wider for grep.
    const displayPreview = preview.length > 90 ? preview.slice(0, 89) + '…' : preview;
    return {
      age: relativeAge(c.mtimeMs),
      shortId,
      preview: displayPreview,
    };
  });

  // Column widths.
  const wAge = Math.max(6, ...rows.map((r) => r.age.length));
  const wId = Math.max(13, ...rows.map((r) => r.shortId.length));

  process.stdout.write(
    '\n  ' +
      padR('AGE', wAge) +
      '  ' +
      padR('SESSION', wId) +
      '  ' +
      'ORIGINAL TASK\n'
  );
  for (const r of rows) {
    process.stdout.write(
      '  ' +
        padR(r.age, wAge) +
        '  ' +
        padR(r.shortId, wId) +
        '  ' +
        r.preview +
        '\n'
    );
  }

  const hiddenFromCap = filtered.length - rows.length;
  if (hiddenFromCap > 0) {
    process.stdout.write(`\n  (${hiddenFromCap} more matching sessions not shown)\n`);
  }
  if (!opts.all && discovered.length > pool.length) {
    process.stdout.write(
      `  (${discovered.length - pool.length} sessions from other repos hidden; pass --all to include them)\n`
    );
  }

  process.stdout.write(
    `\nPick one: relay ${target} --pick <id-or-prefix>\n` +
      `Examples:\n` +
      `  relay ${target} --pick ${rows[0]?.shortId.replace('…', '') ?? '<id>'}\n` +
      `  relay ${target} --grep "<word from original task>"\n` +
      `  relay preview ${target} --pick ${rows[0]?.shortId.replace('…', '') ?? '<id>'}\n`
  );

  return 0;
}

async function runInspect(opts: RelayOptions): Promise<number> {
  const git = detectGitContext(process.cwd());
  const codexPaths = existsSync(CODEX_SESSIONS_DIR) ? await discoverCodexSessions(git) : [];
  const claudePaths = existsSync(CLAUDE_PROJECTS_DIR) ? await discoverClaudeSessions(git) : [];
  const mem = await readClaudeMemory(git);

  const claudeOnPath = hasBinary('claude');
  const codexOnPath = hasBinary('codex');

  const lines: string[] = [];
  lines.push(`codex-claude-relay v${VERSION} inspect`);
  lines.push('');
  lines.push(`Git context:`);
  lines.push(`  cwd:         ${process.cwd()}`);
  lines.push(`  inRepo:      ${git.inRepo}`);
  lines.push(`  root:        ${git.root}`);
  lines.push(`  branch:      ${git.branch ?? '(unknown)'}`);
  lines.push('');
  const codexRelevant = codexPaths.filter((c) => c.relevantToRepo);
  const claudeRelevant = claudePaths.filter((c) => c.relevantToRepo);

  lines.push(`Codex sessions (~/.codex/sessions):`);
  lines.push(`  dir exists:    ${existsSync(CODEX_SESSIONS_DIR)}`);
  lines.push(`  total on disk: ${codexPaths.length}`);
  lines.push(`  for this repo: ${codexRelevant.length}`);
  if (codexRelevant.length > 0) {
    const newest = codexRelevant[0]!;
    lines.push(`  most recent:   ${newest.path}`);
    lines.push(`                 ${new Date(newest.mtimeMs).toISOString()}`);
  }
  lines.push('');
  lines.push(`Claude Code sessions (~/.claude/projects):`);
  lines.push(`  dir exists:    ${existsSync(CLAUDE_PROJECTS_DIR)}`);
  lines.push(`  total on disk: ${claudePaths.length}`);
  lines.push(`  for this repo: ${claudeRelevant.length}`);
  if (claudeRelevant.length > 0) {
    const newest = claudeRelevant[0]!;
    lines.push(`  most recent:   ${newest.path}`);
    lines.push(`                 ${new Date(newest.mtimeMs).toISOString()}`);
  }
  lines.push('');
  lines.push(`Claude memory for this project:`);
  lines.push(`  exists:      ${mem.exists}`);
  lines.push(`  dir:         ${mem.dir}`);
  lines.push(`  bytes:       ${mem.summary.length}`);
  lines.push('');
  lines.push(`Binaries on PATH:`);
  lines.push(`  claude:      ${claudeOnPath ? 'yes' : 'NO'}`);
  lines.push(`  codex:       ${codexOnPath ? 'yes' : 'NO'}`);

  process.stdout.write(lines.join('\n') + '\n');
  return 0;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);

  switch (parsed.cmd) {
    case 'help':
      process.stdout.write(HELP);
      return 0;
    case 'version':
      process.stdout.write(`${VERSION}\n`);
      return 0;
    case 'inspect':
      return runInspect(parsed.options);
    case 'preview':
      if (!parsed.target) {
        process.stderr.write(`codex-claude-relay: missing target for preview\n`);
        return 2;
      }
      return runHandoff(parsed.target, parsed.options, 'preview');
    case 'list':
      if (!parsed.target) {
        process.stderr.write(`codex-claude-relay: missing target for list\n`);
        return 2;
      }
      return runList(parsed.target, parsed.options);
    case 'claude':
    case 'codex':
      return runHandoff(parsed.cmd, parsed.options, 'launch');
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`codex-claude-relay: unexpected error: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
