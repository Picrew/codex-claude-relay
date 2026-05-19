# codex-claude-relay

Hand off context between **OpenAI Codex CLI** and **Anthropic Claude Code** by reading their native session transcripts. Pick the right past session for the current repo, condense it into one handoff prompt, and launch the other CLI with that prompt as its first message.

No database. No daemon. No writes to either tool's session files.

🌐 中文文档: [README.zh.md](./README.zh.md)

```bash
codex                  # work for a while in Codex
relay claude           # condense the Codex session, launch `claude` pre-loaded with it
relay codex            # later: condense the Claude session, launch `codex` pre-loaded with it
```

## How it works

```
  ┌──────────────────────────────────┐
  │   ~/.codex/sessions/**/          │ ──┐
  │        rollout-*.jsonl           │   │
  └──────────────────────────────────┘   │   pick best session for $PWD
                                         │   (cwd match + recency)
                                         ▼
                              ┌──────────────────────┐
                              │  stream-parse JSONL  │
                              │  normalize events    │
                              │  redact secrets      │ ─→ handoff (markdown, ~6–12 KB)
                              │  render template     │
                              └──────────────────────┘
                                         ▲
  ┌──────────────────────────────────┐   │
  │ ~/.claude/projects/<encoded>/    │ ──┘
  │        <session-uuid>.jsonl      │
  │        memory/MEMORY.md          │
  └──────────────────────────────────┘
                                         │
                                         ▼
                              spawn `claude` or `codex`
                              with the handoff as the
                              initial user prompt
```

## Why

Both major coding agents already write rich transcripts to disk. They just don't read each other's. So when you switch tools mid-task — Codex → Claude or Claude → Codex — you spend five minutes pasting back what you were doing, which files were touched, which commands failed.

The usual response is a "memory sync" tool. Those almost always introduce a *third* store (vector DB, JSON cache, `.ai/handoff.md`) that neither native tool consults. Now you have three sources of truth and the new one drifts out of date.

codex-claude-relay never stores anything. Every invocation re-reads the native transcripts. The two tools remain the only sources of truth.

| Approach                                    | Persistent store | Mutates native files | Reads native transcripts |
| ------------------------------------------- | :--------------: | :------------------: | :----------------------: |
| Manual copy-paste                           | —                | no                   | —                        |
| Vector-DB memory layer                      | yes              | no                   | sometimes                |
| `.ai/handoff.md` checked into repo          | yes              | no                   | no                       |
| **codex-claude-relay**                           | no               | no                   | yes                      |

## Install

Requires Node.js 20+ (check with `node --version`).

### Option A — clone, build, link (recommended)

`npm install` only fetches the two devDependencies (`typescript`, `tsx`). `npm run build` produces `dist/cli.js`. **`npm link` is the separate step that puts the `relay` command on your `PATH`.** Skipping it is the most common reason for `command not found: relay`.

```bash
git clone https://github.com/Picrew/codex-claude-relay
cd codex-claude-relay
npm install        # fetch devDeps (typescript, tsx)
npm run build      # compile src/ → dist/
npm link           # register `relay` and `codex-claude-relay` globally
```

Verify:

```bash
which relay        # should print a path under your npm global prefix
relay --version    # should print 0.1.0
relay inspect      # should list discovered sessions
```

If `npm link` reports a permission error, your global `npm` prefix isn't user-writable. Either fix the prefix (`npm config set prefix "$HOME/.npm-global"` and add `$HOME/.npm-global/bin` to `PATH`) or use Option B.

### Option B — no link, run via node

If you don't want to link globally:

```bash
node /absolute/path/to/codex-claude-relay/dist/cli.js inspect
```

A shell alias is the lightest workaround:

```bash
echo 'alias relay="node $HOME/path/to/codex-claude-relay/dist/cli.js"' >> ~/.zshrc
source ~/.zshrc
```

### Option C — install globally from a tarball

If the package is published (it currently isn't, but the layout supports it):

```bash
npm install -g codex-claude-relay
```

### Requirements for actually launching agents

`claude` and `codex` must be on `PATH` for `relay claude` and `relay codex` to spawn them:

```bash
which claude codex
```

If either is missing, install it from its vendor — `relay preview`, `relay inspect`, and `--dry-run` still work without them.

### Uninstall

```bash
cd codex-claude-relay
npm unlink -g       # remove the global symlink
```

## Commands

| Command                  | Effect                                                                |
| ------------------------ | --------------------------------------------------------------------- |
| `relay claude`           | Build handoff from latest relevant Codex session → launch `claude`    |
| `relay codex`            | Build handoff from latest relevant Claude session → launch `codex`    |
| `relay preview <target>` | Print the handoff that would be sent; don't launch                    |
| `relay inspect`          | Show what would be picked, with scores and reasons                    |

### Flags

```
--last           Use the most recently modified session, skipping the
                 cwd-based ranking. Useful when cwd doesn't match.
--with-diff      Append the current `git diff HEAD` to the handoff.
--max-chars N    Cap the rendered handoff length (default 12000).
--dry-run        Build the handoff and print it; do not launch.
--no-redact      Disable secret redaction. Default is ON.
--debug          Verbose discovery / parsing info on stderr.
```

## Walkthrough

The two main flows are *Claude Code → Codex* and *Codex → Claude Code*. They are symmetric; pick the one that matches the direction you're switching.

### Scenario A: Claude Code → Codex

You've been working in Claude Code, you want Codex to continue.

**Step 1 — Leave Claude Code (or just open a new terminal).**

You don't need to exit cleanly. Claude Code flushes its JSONL transcript as you go, so even mid-conversation the latest events are on disk. Either type `/exit` inside Claude Code, or open a new terminal tab (`Cmd+T` in iTerm / Terminal) and keep Claude running in the background — both work.

> ⚠ Do **not** type `relay codex` into the Claude Code prompt itself. The Claude REPL will treat it as a message to the model, not a shell command. Always run `relay` from a regular shell.

**Step 2 — `cd` into the repo.**

```bash
cd /path/to/your/repo
```

The current directory matters: context-relay uses it (plus `git rev-parse --show-toplevel`) to pick the right past session.

**Step 3 — Sanity check what would be sent.**

```bash
relay preview codex --max-chars 8000 | less
```

Scroll through and verify:

- **Original task** — does the first paragraph match what you originally asked Claude to do?
- **Subsequent user instructions** — are your follow-up messages there?
- **Files touched or inspected** — is the list reasonable?
- **Recent conversation tail** — does it cover the last few exchanges?

If the original task is truncated and you want more of it, raise `--max-chars` (e.g. `--max-chars 16000`).

If `relay inspect` was already showing the right session at score ≥ 90, you can usually skip this step. Press `q` to exit `less`.

**Step 4 — Launch Codex with the handoff.**

```bash
relay codex
```

You'll see stderr print `codex-claude-relay: launching \`codex\` with handoff (N chars)`, then Codex's TUI opens. The handoff arrives as Codex's first user message:

- If the handoff is ≤ 8 KB, it's passed inline as the first message.
- If it's > 8 KB, context-relay writes it to a `0600` temp file (under `$TMPDIR`) and passes a short reference prompt: *"Read the handoff context file at … and continue."* Codex calls its file-read tool, reads the handoff, and proceeds. The temp file is deleted when Codex exits.

Either way, Codex's first response will acknowledge the context (~10 s round-trip). After that you continue typing as usual.

**Step 5 — Verify the handoff actually landed.**

Once Codex finishes its first reply, ask it something only the prior session would know:

```
我之前在 Claude 里问的第一个问题是什么？逐字告诉我。
列一下 Claude 都动过哪些文件，跑过哪些命令。
```

Or, in English:

```
Quote my original first question to the previous agent verbatim.
List every file the previous agent touched and the commands it ran.
```

If Codex can answer accurately, the handoff is working. Continue your work.

### Scenario B: Codex → Claude Code

Symmetric to Scenario A. You've been working in Codex, you want Claude Code to continue.

**Step 1 — Leave Codex (or open a new terminal).** Codex also flushes its rollout JSONL continuously.

**Step 2 — `cd` into the repo.**

```bash
cd /path/to/your/repo
```

**Step 3 — Preview.**

```bash
relay preview claude --max-chars 8000 | less
```

If Codex worked in a worktree or under a subdir, the cwd recorded in the session might not match your current git root. `relay inspect` will show the score; if it's low (< 60), try `--last`:

```bash
relay preview claude --last
```

**Step 4 — Launch.**

```bash
relay claude
```

Claude Code's TUI opens. The handoff becomes its first user message (or temp-file ref for handoffs > 8 KB).

**Step 5 — Verify.**

```
Quote my original first question to the previous Codex session verbatim.
Summarize what Codex got working and what's still open.
```

### Side-by-side mode (don't actually "switch", run both)

You don't have to close one to use the other. Open two terminal tabs:

| Tab 1                        | Tab 2                          |
| ---------------------------- | ------------------------------ |
| `codex` (or `claude`) keeps running | `cd repo && relay claude` (or `relay codex`) |

Both agents now have the same repo state plus the same prior context. Useful when you want a second opinion on the same problem without losing your original session.

### Useful flags in practice

```bash
# Cwd doesn't match the recorded one (worktree, moved repo, symlink, etc.)
relay codex --last

# Receiving agent should see your uncommitted work too
relay codex --with-diff

# Bigger handoff — more original task + more conversation tail
relay codex --max-chars 20000

# See what would happen without launching
relay codex --dry-run

# Diagnose which session was picked and why
relay codex --debug --dry-run

# Trust the transcript, skip redaction (rare)
relay codex --no-redact
```

### What does *not* work

- Running `relay` inside the source agent's REPL itself. Always run from a regular shell.
- Switching between repos in one command. `relay` operates on the **current** git root only.
- Cross-machine handoff. Transcripts are local. Copy the JSONL across by hand if you really need to.
- Forging a fake "previous session" so the receiving agent thinks it's literally resuming. The handoff is structured context, not a session import — see [FAQ](#faq).

## Example: `relay inspect`

```
$ cd ~/work/my-project
$ relay inspect
codex-claude-relay v0.1.0 inspect

Git context:
  cwd:         /Users/alice/work/my-project
  inRepo:      true
  root:        /Users/alice/work/my-project
  branch:      main

Codex sessions (~/.codex/sessions):
  dir exists:  true
  count:       137
  best:        ~/.codex/sessions/2026/05/14/rollout-2026-05-14T09-15-22-…jsonl
               score=88.7  mtime=2026-05-14T01:22:08.142Z
               cwd=/Users/alice/work/my-project
               reasons: cwd matches git root exactly | recency +28.7 (age 0.4d)

Claude Code sessions (~/.claude/projects):
  dir exists:  true
  count:       42
  best:        ~/.claude/projects/-Users-alice-work-my-project/8c3f….jsonl
               score=130.0  mtime=2026-05-19T14:10:01.000Z
               cwd=/Users/alice/work/my-project
               reasons: inside encoded project dir | cwd matches git root exactly | recency +30.0 (age 0.0d)

Claude memory for this project:
  exists:      false
  bytes:       0

Binaries on PATH:
  claude:      yes
  codex:       yes
```

## Example: what's actually in the handoff

```
You are continuing work in this repository after a context handoff from
OpenAI Codex CLI to Anthropic Claude Code.

Repository:
- Path: /Users/alice/work/my-project
- Branch: main
- Git status summary:
   M src/server.ts

Original task:
  Add rate limiting to the /api/upload endpoint.

Subsequent user instructions:
- use redis, not in-memory
- ignore /health pings

What has already been done / key decisions:
- Implemented sliding-window limiter in src/middleware/rate.ts
- Chose redis pipelining over a Lua script for simpler ops

Files touched or inspected:
- src/middleware/rate.ts
- src/server.ts
- test/rate.test.ts

Commands run (★ = errored):
- `npm test -- rate`
- ★ `redis-cli ping`

Errors observed:
- redis-cli ping: Could not connect to Redis at 127.0.0.1:6379

Recent conversation tail:
- User: it should also rate-limit anonymous IPs
- Assistant: Added a fallback bucket keyed by IP for unauthenticated calls.

Safety notes for you, the receiving agent:
- Do not assume the prior agent's conclusions are still correct.
- Re-check current files and `git status` / `git diff` before editing.
- Prefer the live repository state over anything implied by this transcript.
```

## Session discovery & ranking

Both providers walk the canonical directory recursively, peek each file's metadata cheaply, then rank:

```
score = cwd_match_signal  +  recency_decay
```

| Signal                                | Codex weight | Claude weight |
| ------------------------------------- | :----------: | :-----------: |
| Recorded cwd equals git root          | +60          | +60           |
| Recorded cwd inside git root          | +50          | +50           |
| Recorded cwd mentions repo name       | +25          | +20           |
| Inside Claude's encoded project dir   | —            | +40           |
| Recency: linear decay 0 → 14 days     | +0 … +30     | +0 … +30      |

Pass `--last` to skip ranking and force the most-recent-by-mtime file. Pass `--debug` to see the reasons string for the chosen candidate.

## Native transcript formats

codex-claude-relay parses the formats the official CLIs already write. It does not invent any file shape.

**Codex CLI** — one JSONL per session, one line per event:

```
~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
```

Each line is `{ "type", "payload", "timestamp" }`. Useful payload types:

| `payload.type`           | What it carries                                |
| ------------------------ | ---------------------------------------------- |
| `session_meta`           | `cwd`, `id`, originator, model                 |
| `message` (role=user)    | The user's message turn (`content[].input_text`) |
| `message` (role=assistant) | The model's message turn (`content[].output_text`) |
| `function_call`          | Tool invocation (`name`, JSON-string `arguments`) |
| `function_call_output`   | Tool result (`output` is the captured text)    |

**Claude Code** — one JSONL per session, grouped per project:

```
~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl
```

`<encoded-cwd>` is the absolute project path with `/` and `.` replaced by `-`. Each useful line:

| `type`     | Carries                                                              |
| ---------- | -------------------------------------------------------------------- |
| `user`     | User turn or `tool_result` block(s); also `cwd`, `gitBranch`         |
| `assistant`| Model turn: text + `tool_use` blocks (`name`, `input`)               |

Tool calls live inside `message.content[]` as `{ type: "tool_use" }`. Their results land inside the next `user` line as `{ type: "tool_result" }`.

If `~/.claude/projects/<encoded-cwd>/memory/` exists, its `MEMORY.md` and the `.md` files it links are included when generating the Claude → Codex handoff.

## What gets filtered out

To keep the handoff readable, the parser drops:

- Codex `reasoning` events (the model's private chain-of-thought)
- Codex `event_msg` / `turn_context` / `token_count` framing
- Codex environment-context user messages (`<environment_context>…`)
- Claude `<task-notification>`, `<system-reminder>`, lone `[Image: source: …]` markers, slash-command framing
- Claude sidechain messages (`isSidechain: true`)
- Anything matching the secret-redaction rules (see below)

Tool outputs are clipped to ~400 chars per event so a single noisy `cat large-file` doesn't crowd out everything else.

## Safety

| Concern                       | What codex-claude-relay does                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Native files                  | Opened read-only. Never written to `~/.codex/sessions/` or `~/.claude/projects/`.                                  |
| Secrets in transcripts        | Redacted by default. See list below.                                                                               |
| Process-list / argv leakage   | Handoffs > 8 KB are written to a `0600` temp file in a per-invocation `0700` dir; only a short ref prompt goes in `argv`. The temp file is unlinked when the child exits. |
| Shell interpolation           | `spawn(..., { shell: false })`. The handoff is never interpreted by a shell.                                       |
| Stale data                    | If the source session is > 24 h old, the handoff includes a `⚠ stale` notice.                                      |

Redaction covers (case-insensitive where applicable):

- OpenAI keys: `sk-…`, `sk-proj-…`, `sk-ant-…`
- GitHub tokens: `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`
- AWS access key IDs (`AKIA…`)
- Google API keys (`AIza…`)
- JWTs (three base64url segments separated by dots)
- PEM private key blocks (`-----BEGIN … PRIVATE KEY-----` … `-----END …-----`)
- `Authorization:` and `Set-Cookie:` headers
- Env-var style `*SECRET*=`, `*TOKEN*=`, `*PASSWORD*=`, `*API_KEY*=`, `*CREDENTIAL*=` with ≥ 6-char values

Pass `--no-redact` only when you trust the transcript.

## Limitations

| Situation                                            | What happens                                                            |
| ---------------------------------------------------- | ----------------------------------------------------------------------- |
| Transcripts deleted or disabled                      | Nothing to read; `relay inspect` reports `count=0`.                     |
| Two repos with the same basename                     | Cwd-exact-match (+60) still wins; otherwise check `--debug`.            |
| Same project across multiple Claude sessions         | Highest cwd-score + most recent wins; pin with `--last` if you need to. |
| Codex/Claude transcript schema changes upstream      | Parser skips malformed lines and reports the count in `--debug`.        |
| Cross-machine handoff                                | Not supported. Transcripts are local-only.                              |
| Huge tool outputs                                    | Clipped to ~400 chars per event in the handoff.                         |
| Codex/Claude rotate or compact session files         | Once the file is gone, so is the context source.                        |

## FAQ

**Does Claude actually resume a Codex session?**
No. Claude starts a fresh native session and reads the handoff as its first user message. The handoff is structured for an agent to consume but it is not a literal session import.

**Does codex-claude-relay write anywhere on disk?**
Only the optional temp file used when the prompt exceeds the inline-argv limit (~8 KB). It lives under `$TMPDIR` and is unlinked when the child exits.

**Can I save the handoff into my repo if I want to?**
Sure — pipe it: `relay preview codex > .ai/handoff.md`. codex-claude-relay won't do this by default because the point is to stay stateless.

**Why not always include `git diff`?**
Most sessions already touched files you've committed; the diff would be noise. Pass `--with-diff` when uncommitted work actually matters.

**Why one big prompt, not a folder of fragments?**
The receiving agent reads one prompt at the start of its turn. Splitting just forces it to re-concatenate.

**Can I run `relay` from inside Codex or Claude?**
You can, but it'll generate a handoff for the *current* session it's reading — usually not what you want. The intended use is in a separate shell, after you step out of the agent.

**Why does ranking depend on cwd, not on content?**
Cheap and accurate enough in practice. Content-based ranking would need to read every transcript fully on every invocation. cwd-match + recency picks the right session for the current repo in milliseconds.

## Development

```bash
npm install
npm run typecheck     # strict TS, zero suppressions
npm test              # node --test on the 17 unit tests
npm run build         # tsc → dist/
node dist/cli.js inspect
```

Project layout:

```
src/
  cli.ts              # arg parsing, command dispatch
  index.ts            # programmatic exports
  types.ts            # shared types only — no runtime
  git.ts              # git rev-parse / branch / diff
  parse/jsonl.ts      # streaming JSONL reader + helpers
  providers/
    codex.ts          # ~/.codex/sessions discovery + parsing
    claude.ts         # ~/.claude/projects discovery + parsing + memory
  redact.ts           # secret patterns
  summarize.ts        # event digest + handoff template
  launch.ts           # child_process spawn + temp-file fallback
test/                 # node:test unit tests
```

Dependencies: only `typescript` and `tsx` as devDependencies. Zero runtime dependencies — the CLI uses Node built-ins exclusively.

## License

MIT. See [LICENSE](./LICENSE).
