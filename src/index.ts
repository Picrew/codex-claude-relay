// Public programmatic API for codex-claude-relay. The CLI in src/cli.ts is the
// primary interface, but this re-exports the building blocks for users who
// want to embed handoff generation in their own tooling.

export * from './types.js';
export { detectGitContext, getDiff } from './git.js';
export {
  CODEX_SESSIONS_DIR,
  discoverCodexSessions,
  pickCodexSession,
  parseCodexSession,
} from './providers/codex.js';
export {
  CLAUDE_PROJECTS_DIR,
  discoverClaudeSessions,
  pickClaudeSession,
  parseClaudeSession,
  readClaudeMemory,
  encodeProjectDir,
} from './providers/claude.js';
export { renderHandoff } from './summarize.js';
export { redact } from './redact.js';
export { launchAgentAsync, hasBinary } from './launch.js';
