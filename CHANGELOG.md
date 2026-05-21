# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] — 2026-05-21

Major simplification of the picking model based on real-world use.

### Changed
- **Default pick rule is now just "most recent session whose recorded cwd is inside this repo"** — no more weighted scoring, no recency decay formula, no fuzzy "path mentions repo name" fallback. If a session wasn't recorded inside the current git root, it's not in scope by default.
- **`relay list` columns simplified** — dropped the `#` index column and the `SCORE` column. Output is now just `AGE / SESSION / ORIGINAL TASK`, sorted newest first.
- **`relay inspect` cleaned up** — replaces `score=… reasons=…` with `total on disk / for this repo / most recent path`.
- **`--pick` is now id-prefix-only.** It accepts any substring of the session UUID (e.g. `--pick ab11e518`, `--pick 32533776`). Indices and path substrings are no longer supported — the simpler API matches the actual primary use case.
- `--pick` searches across **all** sessions on disk (not just the in-repo filtered subset), because if you typed the id you know what you want.

### Added
- **`--grep <text>`** filters sessions by case-insensitive substring match against each session's original-task preview. On `list` it narrows the table; on `relay claude` / `relay codex` it must match exactly one session.

### Removed
- `--last` is now a no-op alias (the default IS the most-recent session for this repo).
- The `score` and `reasons` fields on `SessionCandidate` are gone, replaced by a single boolean `relevantToRepo`. The exported types changed; consumers of the programmatic API should update.

### Internal
- `discoverCodexSessions` / `discoverClaudeSessions` no longer compute or sort by a numeric score.
- `pickCodexSession` / `pickClaudeSession` lose their `forceLast` argument.
- New `matchesGrep()` helper in `src/select.ts`.
- 17 unit tests for the selector + relative-age + new grep helper (33/33 passing).

## [0.1.1] — 2026-05-21

### Added
- **`relay list <target>`** — print a numbered table of candidate source sessions for the current repo, showing score, age, short session id, and a preview of the first user message. Default shows only sessions with score > 0 (relevant to this repo).
- **`--pick <selector>`** for `relay <target>` and `relay preview <target>` — pick a specific source session explicitly. The selector is polymorphic:
  - all-digit string within range → 1-based index from `relay list`
  - all-digit string outside range → falls through to id-prefix
  - string containing `/` → path or path-substring match
  - any other string → session UUID prefix match against the JSONL filename
- **`--all`** for `relay list` — also show sessions from unrelated repos that the broad fallback scan swept in (hidden by default).
- Friendly hints on selector errors: out-of-range index shows the actual count; ambiguous matches list up to five matched paths; if the selector only matched in the hidden score-0 pool, the error hints at `--all`.

### Internal
- New `findInJsonl` streaming helper with early-exit semantics; used by the new per-provider `peekOriginalTask()` functions.
- New `src/select.ts` module with pure `resolveSelector()` and `relativeAge()`.
- 17 new unit tests for the selector and relative-age helpers (total: 34/34 passing).

### Docs
- Both READMEs gain a "Picking among multiple sessions" / "在多个 session 之间挑选" section.

## [0.1.0] — 2026-05-19

Initial public release on the npm registry as [`codex-claude-relay`](https://www.npmjs.com/package/codex-claude-relay).

### Added
- `relay claude` / `relay codex` — stateless context handoff between OpenAI Codex CLI and Anthropic Claude Code.
- `relay preview <target>` — print the handoff that would be sent without launching.
- `relay inspect` — show discovery results, scores, and binary availability.
- Native transcript discovery + ranking (cwd match + recency decay) for `~/.codex/sessions/**/rollout-*.jsonl` and `~/.claude/projects/<encoded-dir>/*.jsonl`.
- Reads optional `memory/MEMORY.md` from a Claude project directory when handing off to Codex.
- Secret redaction by default: `sk-…`, `sk-ant-…`, GitHub tokens, AWS keys, Google API keys, JWTs, PEM private keys, `Authorization:` / `Set-Cookie:` headers, and `*SECRET*` / `*TOKEN*` / `*PASSWORD*` env-var values.
- Temp-file fallback for handoff prompts > 8 KB to avoid `argv` / `ps` leakage.
- Bilingual READMEs (English + 简体中文).

[0.1.2]: https://github.com/Picrew/codex-claude-relay/releases/tag/v0.1.2
[0.1.1]: https://github.com/Picrew/codex-claude-relay/releases/tag/v0.1.1
[0.1.0]: https://github.com/Picrew/codex-claude-relay/releases/tag/v0.1.0
