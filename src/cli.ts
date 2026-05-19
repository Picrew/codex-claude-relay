#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { detectGitContext, getDiff } from './git.js';
import {
  pickCodexSession,
  parseCodexSession,
  discoverCodexSessions,
  CODEX_SESSIONS_DIR,
} from './providers/codex.js';
import {
  pickClaudeSession,
  parseClaudeSession,
  discoverClaudeSessions,
  readClaudeMemory,
  CLAUDE_PROJECTS_DIR,
} from './providers/claude.js';
import { renderHandoff } from './summarize.js';
import { launchAgentAsync, hasBinary } from './launch.js';
import { DEFAULT_OPTIONS } from './types.js';
import type { AgentName, RelayOptions } from './types.js';

const VERSION = '0.1.0';

const HELP = `context-relay v${VERSION} — stateless handoff between Codex CLI and Claude Code

Usage:
  relay <target>            Launch the target agent with a handoff from the OTHER agent
  relay preview <target>    Print the handoff that would be sent (no launch)
  relay inspect             Show discovery results without parsing or launching
  relay --help              Show this help
  relay --version           Show version

Targets:
  claude   Handoff Codex -> Claude Code (reads ~/.codex/sessions, launches \`claude\`)
  codex    Handoff Claude Code -> Codex (reads ~/.claude/projects, launches \`codex\`)

Options:
  --last              Use the most recently modified session (skip repo-relevance ranking)
  --with-diff         Append \`git diff HEAD\` to the handoff
  --max-chars N       Cap the handoff size (default ${DEFAULT_OPTIONS.maxChars})
  --dry-run           Build & print the handoff, do not launch the target agent
  --no-redact         Disable secret redaction (default: ON)
  --debug             Verbose discovery / parsing info on stderr

Examples:
  relay claude
  relay codex --with-diff
  relay preview claude --max-chars 6000
  relay inspect
`;

interface ParsedArgs {
  cmd: 'claude' | 'codex' | 'preview' | 'inspect' | 'help' | 'version';
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
      options.last = true;
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
    if (a === '--max-chars') {
      const next = argv[i + 1];
      const n = next ? parseInt(next, 10) : NaN;
      if (!Number.isFinite(n) || n < 500) {
        process.stderr.write(`context-relay: --max-chars requires a positive integer >= 500\n`);
        process.exit(2);
      }
      options.maxChars = n;
      i += 2;
      continue;
    }
    if (a.startsWith('--max-chars=')) {
      const n = parseInt(a.slice('--max-chars='.length), 10);
      if (!Number.isFinite(n) || n < 500) {
        process.stderr.write(`context-relay: --max-chars requires a positive integer >= 500\n`);
        process.exit(2);
      }
      options.maxChars = n;
      i += 1;
      continue;
    }
    if (a.startsWith('-')) {
      process.stderr.write(`context-relay: unknown option ${a}\n`);
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
      process.stderr.write(`context-relay: \`preview\` requires a target: \`relay preview claude\` or \`relay preview codex\`\n`);
      process.exit(2);
    }
  } else if (head === 'inspect') {
    cmd = 'inspect';
  } else if (head === 'help') {
    cmd = 'help';
  } else if (head === 'version') {
    cmd = 'version';
  } else {
    process.stderr.write(`context-relay: unknown command "${head}"\n`);
    process.exit(2);
  }

  return { cmd, options, positional, target };
}

function debug(opts: RelayOptions, msg: string): void {
  if (opts.debug) process.stderr.write(`[relay] ${msg}\n`);
}

async function runHandoff(target: AgentName, opts: RelayOptions, mode: 'launch' | 'preview'): Promise<number> {
  const git = detectGitContext(process.cwd());
  if (!git.inRepo) {
    process.stderr.write(
      `context-relay: warning — current directory is not a git repo. Falling back to cwd: ${git.root}\n`
    );
  }
  debug(opts, `git root: ${git.root} (inRepo=${git.inRepo})`);

  const sourceAgent: AgentName = target === 'claude' ? 'codex' : 'claude';
  debug(opts, `source agent: ${sourceAgent}, target agent: ${target}`);

  if (sourceAgent === 'codex') {
    if (!existsSync(CODEX_SESSIONS_DIR)) {
      process.stderr.write(
        `context-relay: no Codex session directory found at ${CODEX_SESSIONS_DIR}.\n` +
          `  Run Codex CLI at least once to generate transcripts, or check ~/.codex/sessions.\n`
      );
      return 1;
    }
    const pick = await pickCodexSession(git, opts.last);
    if (!pick) {
      process.stderr.write(`context-relay: no Codex rollout files found under ${CODEX_SESSIONS_DIR}.\n`);
      return 1;
    }
    debug(opts, `picked codex session: ${pick.path} (score=${pick.score.toFixed(1)})`);
    debug(opts, `reasons: ${pick.reasons.join(' | ')}`);

    const session = await parseCodexSession(pick.path);
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
    // sourceAgent === 'claude'
    if (!existsSync(CLAUDE_PROJECTS_DIR)) {
      process.stderr.write(
        `context-relay: no Claude Code projects directory found at ${CLAUDE_PROJECTS_DIR}.\n` +
          `  Run Claude Code at least once to generate transcripts, or check ~/.claude/projects.\n`
      );
      return 1;
    }
    const pick = await pickClaudeSession(git, opts.last);
    if (!pick) {
      process.stderr.write(
        `context-relay: no Claude Code session JSONLs found under ${CLAUDE_PROJECTS_DIR}.\n`
      );
      return 1;
    }
    debug(opts, `picked claude session: ${pick.path} (score=${pick.score.toFixed(1)})`);
    debug(opts, `reasons: ${pick.reasons.join(' | ')}`);

    const session = await parseClaudeSession(pick.path);
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
        `context-relay: --dry-run — printing handoff (would launch \`${target}\`)\n\n`
      );
    }
    process.stdout.write(prompt);
    if (!prompt.endsWith('\n')) process.stdout.write('\n');
    return 0;
  }

  if (!hasBinary(target)) {
    process.stderr.write(
      `context-relay: \`${target}\` is not on PATH. Install it (or use \`relay preview ${target}\` / \`--dry-run\`).\n`
    );
    return 127;
  }

  process.stderr.write(`context-relay: launching \`${target}\` with handoff (${prompt.length} chars)\n`);
  const res = await launchAgentAsync({ agent: target, prompt });
  return res.code;
}

async function runInspect(opts: RelayOptions): Promise<number> {
  const git = detectGitContext(process.cwd());
  const codexPaths = existsSync(CODEX_SESSIONS_DIR) ? await discoverCodexSessions(git) : [];
  const claudePaths = existsSync(CLAUDE_PROJECTS_DIR) ? await discoverClaudeSessions(git) : [];
  const mem = await readClaudeMemory(git);

  const claudeOnPath = hasBinary('claude');
  const codexOnPath = hasBinary('codex');

  const lines: string[] = [];
  lines.push(`context-relay v${VERSION} inspect`);
  lines.push('');
  lines.push(`Git context:`);
  lines.push(`  cwd:         ${process.cwd()}`);
  lines.push(`  inRepo:      ${git.inRepo}`);
  lines.push(`  root:        ${git.root}`);
  lines.push(`  branch:      ${git.branch ?? '(unknown)'}`);
  lines.push('');
  lines.push(`Codex sessions (~/.codex/sessions):`);
  lines.push(`  dir exists:  ${existsSync(CODEX_SESSIONS_DIR)}`);
  lines.push(`  count:       ${codexPaths.length}`);
  if (codexPaths.length > 0) {
    const best = codexPaths[0]!;
    lines.push(`  best:        ${best.path}`);
    lines.push(`               score=${best.score.toFixed(1)} mtime=${new Date(best.mtimeMs).toISOString()}`);
    lines.push(`               cwd=${best.recordedCwd ?? '(unknown)'}`);
    lines.push(`               reasons: ${best.reasons.join(' | ')}`);
  }
  lines.push('');
  lines.push(`Claude Code sessions (~/.claude/projects):`);
  lines.push(`  dir exists:  ${existsSync(CLAUDE_PROJECTS_DIR)}`);
  lines.push(`  count:       ${claudePaths.length}`);
  if (claudePaths.length > 0) {
    const best = claudePaths[0]!;
    lines.push(`  best:        ${best.path}`);
    lines.push(`               score=${best.score.toFixed(1)} mtime=${new Date(best.mtimeMs).toISOString()}`);
    lines.push(`               cwd=${best.recordedCwd ?? '(unknown)'}`);
    lines.push(`               reasons: ${best.reasons.join(' | ')}`);
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
        process.stderr.write(`context-relay: missing target for preview\n`);
        return 2;
      }
      return runHandoff(parsed.target, parsed.options, 'preview');
    case 'claude':
    case 'codex':
      return runHandoff(parsed.cmd, parsed.options, 'launch');
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`context-relay: unexpected error: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
