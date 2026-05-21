# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.1]: https://github.com/Picrew/codex-claude-relay/releases/tag/v0.1.1
[0.1.0]: https://github.com/Picrew/codex-claude-relay/releases/tag/v0.1.0
