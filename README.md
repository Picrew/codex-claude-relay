# context-relay

> Stateless context handoff between **OpenAI Codex CLI** and **Anthropic Claude Code**.
> No database. No new memory layer. Just native transcripts → compact handoff → one-line launch.

🌐 中文文档: [README.zh.md](./README.zh.md)

---

## The problem

You're in the middle of a session in Codex CLI. You hit a wall — maybe Claude Code
handles this kind of refactor better. You switch.

But now Claude doesn't know:

- what task you were working on
- what files Codex already touched
- what shell commands have been run
- which approaches were tried and discarded
- what's still TODO

So you spend the first five minutes pasting context, hoping you didn't miss anything.

Going back the other way is just as painful.

The same problem occurs whenever people juggle two CLI coding agents. People have started
building "memory sync" tools for this — but those almost always end up creating a *third*
memory store (vector DB, `.ai/handoff.md` file, cloud sync, …) that the two native tools
don't know about. Now you have **three** sources of truth, and the new one always
drifts out of date.

## What `context-relay` is

`context-relay` is intentionally narrow:

1. Read the **native** transcript files Codex and Claude Code already write to disk.
   - Codex CLI: `~/.codex/sessions/**/rollout-*.jsonl`
   - Claude Code: `~/.claude/projects/<encoded-dir>/*.jsonl` (+ optional `memory/MEMORY.md`)
2. Pick the most relevant recent session for your **current git repository**.
3. Condense it into a compact, **agent-readable** handoff prompt.
4. Launch the other CLI with that prompt as the initial input.

That's the whole product. No database. No background daemon. No mutation of
native files. No fake session IDs.

```
codex
# work for a while, decide Claude is better for the next step

relay claude       # condense the Codex session, launch `claude` with it as the initial prompt

# later…
relay codex        # condense the Claude session, launch `codex` with it as the initial prompt
```

## What it deliberately is **not**

- **Not** a memory database. There's no vector store, no SQLite, no JSON cache.
- **Not** a session importer. It cannot make Claude believe it is continuing a real
  Codex session ID — that would require forging native session files, which the
  authoring tools may overwrite or invalidate at any time.
- **Not** a sync tool. It runs once per invocation, then exits.
- **Not** writing to `.ai/handoff.md` or any repo file by default. Set `--with-diff`
  or use `relay preview` if you want to inspect.

## Install

Requires **Node.js 20+**.

```bash
# From source
git clone https://github.com/<you>/context-relay
cd context-relay
npm install
npm run build
npm link        # makes `relay` available globally

# Or install globally from a published tarball
npm install -g context-relay
```

Make sure both `claude` and `codex` are on your `PATH` if you want the launch
behavior; otherwise `--dry-run` / `relay preview` still work for inspecting the
handoff.

## Usage

```
relay <target>            Launch the target agent with a handoff from the OTHER agent
relay preview <target>    Print the handoff that would be sent (no launch)
relay inspect             Show what sessions were discovered

Targets:
  claude   Hand off Codex -> Claude Code
  codex    Hand off Claude Code -> Codex

Options:
  --last              Use the most recently modified session, skipping the repo-relevance ranking
  --with-diff         Append the current `git diff HEAD` to the handoff
  --max-chars N       Cap the handoff size (default 12000)
  --dry-run           Build and print the handoff, do not launch the target agent
  --no-redact         Disable secret redaction (default is ON)
  --debug             Verbose discovery / parsing info on stderr
```

### Examples

```bash
# Continue your Codex work in Claude Code
relay claude

# Continue your Claude Code work in Codex, including the current git diff
relay codex --with-diff

# Inspect what the handoff would look like, without launching anything
relay preview claude
relay preview codex --max-chars 6000

# See which sessions context-relay would pick for this repo
relay inspect
```

## Safety model

- **Read-only** with respect to Codex and Claude Code files. We never write into
  `~/.codex/sessions/` or `~/.claude/projects/`.
- **Secret redaction is on by default.** API keys (`sk-…`, `sk-ant-…`, AWS,
  Google, GitHub tokens), JWTs, PEM private keys, `Authorization:` headers,
  `Set-Cookie:` headers, and common `*_SECRET=` / `*_TOKEN=` / `*_PASSWORD=`
  env-var values are scrubbed before the prompt is built.
- **Process-listing safety.** When the rendered handoff is longer than ~8 KB,
  we write it to a `0600` file inside a per-invocation `0700` temp directory
  and pass a short reference prompt to the target CLI instead of putting the
  full handoff in `argv`. The temp file is deleted when the child exits.
- **No shell.** `child_process.spawn` is called with `shell: false` so the
  handoff is never interpolated through a shell.

## How discovery works

For `relay claude` (source = Codex):

1. Walk `~/.codex/sessions/**/rollout-*.jsonl`.
2. Peek each file's `session_meta` line to read the recorded `cwd`.
3. Rank by:
   - **cwd match**: exact git root match > inside git root > path mentions repo name
   - **recency**: linear decay over 14 days
4. Use the top match (or the most recent file if `--last` is set).

For `relay codex` (source = Claude Code):

1. Try the fast path `~/.claude/projects/<encoded-git-root>/`. (Claude Code
   encodes path separators and dots as `-`, so `/Users/alice/foo.bar/baz`
   becomes `-Users-alice-foo-bar-baz`.)
2. Also broad-scan `~/.claude/projects/` as a fallback.
3. Detect each transcript's `cwd` from its first user/assistant record.
4. Same ranking as above.
5. If `memory/MEMORY.md` and linked files exist in the project's directory,
   include them in the handoff.

`relay inspect` shows exactly what was discovered, which file would be picked,
and why.

## Limitations

- **Codex CLI** and **Claude Code** must have actually written transcripts to
  their canonical directories. If transcripts are disabled or deleted,
  context-relay has nothing to work with.
- The handoff is a **summary**, not a literal session import. The receiving
  agent starts a fresh native session. We tell it explicitly: *do not assume
  the prior agent's conclusions are still correct; re-check current files
  before editing.*
- Cross-machine handoffs aren't supported. The native transcripts live on
  your local disk; context-relay just reads them.
- Provider transcript formats may change. We parse defensively (skip
  malformed lines, surface skip counts in `--debug`) but a major schema
  change in Codex or Claude Code may require an update here.

## Supported paths

| Provider     | Path                                                            |
| ------------ | --------------------------------------------------------------- |
| Codex CLI    | `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl`            |
| Claude Code  | `~/.claude/projects/<encoded-dir>/<session-uuid>.jsonl`         |
| Claude memory| `~/.claude/projects/<encoded-dir>/memory/MEMORY.md` and friends |

If a future version of either tool changes these paths, please open an issue
with the new layout.

## FAQ

**Can this really import a Codex session into Claude Code?**
No. It injects a compact handoff prompt synthesized from Codex's native
transcript. Claude starts a fresh session and receives the handoff as its
initial user prompt.

**Does it store any extra memory?**
No. There is no persistent store. Every invocation re-reads the native
transcripts.

**Does it mutate the native Codex or Claude transcripts?**
No. Open them in read-only mode only.

**Can it work if I've disabled or deleted transcripts?**
No. If the JSONL files aren't on disk, there is nothing to relay.

**Why not just use a vector DB?**
That's a different product. context-relay is intentionally a one-line
stateless launcher. If you want semantic search across all your past sessions,
build that separately — it's not a goal here.

**Why a single file, not split per topic?**
The receiving agent reads one prompt to start its turn. Splitting would just
force the agent to ingest a directory of fragments, which it would
re-concatenate anyway.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
node dist/cli.js inspect
```

## License

MIT
