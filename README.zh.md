<div align="center">

# codex-claude-relay

**在 OpenAI Codex CLI 与 Anthropic Claude Code 之间做无状态上下文接力。**

读原生 session transcript → 压成一段 handoff prompt → 启动另一边 CLI 时把 prompt 当首条用户输入。

[![npm](https://img.shields.io/npm/v/codex-claude-relay.svg?label=npm&logo=npm&color=cb3837)](https://www.npmjs.com/package/codex-claude-relay)
[![runtime deps](https://img.shields.io/badge/runtime%20deps-0-brightgreen?logo=npm)](package.json)
[![license](https://img.shields.io/npm/l/codex-claude-relay.svg?color=brightgreen)](LICENSE)
[![node](https://img.shields.io/node/v/codex-claude-relay.svg?logo=node.js&color=339933)](https://nodejs.org)
[![types](https://img.shields.io/npm/types/codex-claude-relay.svg?logo=typescript&color=3178c6)](https://www.typescriptlang.org/)
[![GitHub stars](https://img.shields.io/github/stars/Picrew/codex-claude-relay?style=social)](https://github.com/Picrew/codex-claude-relay)

[English](README.md) · **简体中文**

</div>

---

不开数据库。不跑后台进程。不改写两边任何原生文件。

```bash
codex                  # 在 Codex 里干一会儿
relay claude           # 把 Codex 这次会话压缩好，作为初始 prompt 启动 claude
relay codex            # 反过来：把 Claude 这次会话压缩好，作为初始 prompt 启动 codex
```

## 工作流

```
  ┌──────────────────────────────────┐
  │   ~/.codex/sessions/**/          │ ──┐
  │        rollout-*.jsonl           │   │
  └──────────────────────────────────┘   │   按当前目录挑最匹配的 session
                                         │   （cwd 命中 + 新鲜度）
                                         ▼
                              ┌──────────────────────┐
                              │  流式解析 JSONL      │
                              │  归一化事件          │
                              │  脱敏密钥            │ ─→ handoff（markdown，约 6–12 KB）
                              │  套用模板渲染        │
                              └──────────────────────┘
                                         ▲
  ┌──────────────────────────────────┐   │
  │ ~/.claude/projects/<encoded>/    │ ──┘
  │        <session-uuid>.jsonl      │
  │        memory/MEMORY.md          │
  └──────────────────────────────────┘
                                         │
                                         ▼
                              用 spawn 启动 claude / codex，
                              handoff 作为首条用户 prompt
```

## 为什么需要它

两家主流 coding agent 都已经在本地各写各的 transcript，问题在于它们互相不读。任务切到一半换工具，就要花五分钟把上下文复制粘贴过去——改过哪些文件、哪些命令失败了、试过哪些方案。

常见的「记忆同步」方案几乎都会引入**第三个**存储（向量库、JSON 缓存、`.ai/handoff.md`），而这个新存储恰恰是两边原生工具都不读的。结果就是三份「真相来源」，新加的那份永远跟不上。

codex-claude-relay 走另一条路：**什么都不存**。每次调用都重新读原生 transcript。两个工具仍然是仅有的真相来源，这个 CLI 只是无状态的读取器 + 进程启动器。

| 方案                                  | 持久存储 | 修改原生文件 | 直接读原生 transcript |
| ------------------------------------- | :------: | :----------: | :-------------------: |
| 手动复制粘贴                          | —        | 否           | —                     |
| 向量库 / 记忆同步工具                 | 是       | 否           | 有时                  |
| 在仓库里维护 `.ai/handoff.md`         | 是       | 否           | 否                    |
| **codex-claude-relay**                     | 否       | 否           | 是                    |

## 安装

需要 Node.js 20+（`node --version` 检查）。

两种安装方式：**从 npm 装**适合普通使用，**从源码装**适合阅读、修改、贡献代码。

### 方案 A —— 从 npm 安装（推荐普通用户）

包已经发布到 npm 公共 registry：[`codex-claude-relay`](https://www.npmjs.com/package/codex-claude-relay)。

```bash
npm install -g codex-claude-relay
```

这一步会把 `relay` 和 `codex-claude-relay` 同时注册到 `PATH`。

验证：

```bash
which relay        # 应该打印 npm 全局 prefix 下的路径
relay --version    # 应该打印 0.1.2
relay inspect      # 应该列出发现的 session
```

只想临时试一次、不想全局装：

```bash
npx codex-claude-relay@latest inspect
```

如果 `npm install -g` 报 `EACCES` 权限错误，说明你的 npm 全局 prefix 不可写。**不要用 `sudo`**，改 prefix 才是正路：

```bash
npm config set prefix "$HOME/.npm-global"
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
npm install -g codex-claude-relay
```

以后升级：

```bash
npm install -g codex-claude-relay@latest
```

卸载：

```bash
npm uninstall -g codex-claude-relay
```

### 方案 B —— 从源码安装（推荐贡献者）

想改代码、跑测试、提 PR 用这个。

```bash
git clone https://github.com/Picrew/codex-claude-relay
cd codex-claude-relay
npm install        # 装 devDeps（typescript, tsx）
npm run build      # 编译 src/ → dist/
npm link           # 把 `relay` 和 `codex-claude-relay` 注册到全局
```

`npm install` 只下载两个 devDependency（`typescript`、`tsx`）。`npm run build` 把 `src/` 编译到 `dist/`。**`npm link` 是单独的一步，它才把 `relay` 命令暴露到全局 `PATH`** —— 跳过这步就是 `command not found: relay` 的最常见原因。

验证命令同方案 A：`which relay` / `relay --version` / `relay inspect`。

不想 link 全局，可以用 shell alias：

```bash
echo 'alias relay="node $HOME/path/to/codex-claude-relay/dist/cli.js"' >> ~/.zshrc
source ~/.zshrc
```

卸载：

```bash
cd codex-claude-relay
npm unlink -g
```

### 真正启动 agent 的前提

`claude` 和 `codex` 都需要在 `PATH` 上才能让 `relay claude` / `relay codex` spawn 起来：

```bash
which claude codex
```

如果哪个没有，去对应官网装。`relay preview`、`relay inspect`、`--dry-run` 不依赖它们也能用。

## 命令

| 命令                       | 作用                                                                          |
| -------------------------- | ----------------------------------------------------------------------------- |
| `relay claude`             | 用**当前 repo 最近的** Codex session 生成 handoff，启动 `claude`              |
| `relay codex`              | 用**当前 repo 最近的** Claude session 生成 handoff，启动 `codex`              |
| `relay list <target>`      | 列出指定方向上候选的源 session（默认只当前 repo）                             |
| `relay preview <target>`   | 只打印 handoff，不启动任何东西                                                |
| `relay inspect`            | 显示总量、本 repo 最新一条、binary 是否在 PATH                                |

### 选项

```
选 session 用哪一个（默认：当前 repo 最近的那个）：

  --pick ID-PREFIX  session UUID 的子串，例 --pick ab11e518。
                    必须唯一匹配；冲突的话用更长的前缀。
  --grep TEXT       按 session 的原始任务文本做大小写不敏感子串匹配。
                    在 `list` 上是过滤；在 `claude` / `codex` 上必须唯一匹配。

其他：

  --all             把记录的 cwd 在当前 repo 之外的 session 也算进来。
                    默认 `list` 只显示当前 repo 的。
  --with-diff       把当前 `git diff HEAD` 拼到 handoff 里
  --max-chars N     handoff 字符上限（默认 12000）
  --dry-run         只生成并打印 handoff，不启动目标 agent
  --no-redact       关闭密钥脱敏（默认开启）
  --debug           stderr 输出详细发现信息
```

### 在多个 session 之间挑选

同一个 repo 你通常会有**多个**过往的 Claude 或 Codex 会话，每个聊的事不一样。默认 `relay codex` 自动挑**当前 repo 最近的**那个 Claude session（按 cwd 命中 + mtime）。如果想要别的，先 `list` 看，再显式 pick。

```bash
relay list codex
```

```
codex-claude-relay v0.1.2 — Claude Code sessions for /Users/alice/work/my-project
---------------------------------------------------------------------------------

  AGE      SESSION        ORIGINAL TASK
  1h ago   ab11e518-27f…  Add rate limiting to the /api/upload endpoint
  8h ago   fda29ad7-506…  Fix the CI build failing on macOS only
  1d ago   8c3f1d2e-123…  Investigate slow tests in src/auth/

Pick one: relay codex --pick <id-or-prefix>
```

按 **session id 前缀** 选：

```bash
relay codex --pick fda29ad7              # session UUID 的任意唯一子串
relay codex --pick 32533776              # 纯数字前缀也可以
```

或者按**内容**选 —— 对每个 session 的原始任务文本做子串匹配（大小写不敏感）：

```bash
relay codex --grep "rate limit"          # 唯一一个原始任务含 "rate limit" 的会话
relay list codex --grep "build"          # 把列表过滤成包含 "build" 的
```

`--pick` 和 `--grep` 都可以用在 `relay preview <target>` 上，先看 handoff 再启动。

`--pick` 匹配到多个会列出冲突项，你拉长前缀；`--grep` 匹配到多个也会列出来让你用 id 精确指定。

要搜出当前 repo 以外的 session，加 `--all`：

```bash
relay list codex --all
relay list codex --grep "auth" --all
```

## 完整 Usage 教程

两种主流向：*Claude Code → Codex* 与 *Codex → Claude Code*。两边是对称的，按你要切的方向看对应那一段就行。

### 场景 A：Claude Code → Codex

你在 Claude Code 里干了一会儿，想让 Codex 接着干。

**Step 1 — 离开 Claude Code（或者直接开新终端窗口）。**

不需要"干净退出"。Claude Code 的 JSONL transcript 是边干边落盘的，哪怕你不正式退出，最近的事件也都在硬盘上。要么在 Claude Code 里输入 `/exit`，要么直接开一个新终端 tab（iTerm / Terminal 里 `Cmd+T`），让 Claude 在后台保持运行 —— 两种都可以。

> ⚠ **不要**把 `relay codex` 输入到 Claude Code 自己的输入框里。Claude REPL 会把它当成发给模型的一句消息，不会当成 shell 命令执行。`relay` 必须在普通 shell 里跑。

**Step 2 — `cd` 到你的仓库。**

```bash
cd /path/to/your/repo
```

当前目录很关键：context-relay 用 `git rev-parse --show-toplevel` 拿到 git root，再据此挑最相关的过往 session。

**Step 3 — 先 preview，看 handoff 会包含什么（零启动、零风险）。**

```bash
relay preview codex --max-chars 8000 | less
```

翻一翻确认：

- **Original task** —— 第一段是不是你原本让 Claude 做的事？
- **Subsequent user instructions** —— 你的后续指令在不在？
- **Files touched or inspected** —— 文件列表是不是合理？
- **Recent conversation tail** —— 是否覆盖了最后几轮对话？

如果原始任务被截断了想看完整版，加大 `--max-chars`（比如 `--max-chars 16000`）。

如果 `relay inspect` 已经显示 "for this repo" ≥ 1 且最新路径就是你刚刚在做的那个，这一步基本可以跳。按 `q` 退出 less。

**Step 4 — 真正启动 Codex，带 handoff。**

```bash
relay codex
```

会看到 stderr 打 `codex-claude-relay: launching \`codex\` with handoff (N chars)`，然后 Codex 的 TUI 起来。handoff 作为 Codex 的首条 user message 进入：

- handoff ≤ 8 KB：直接 inline 当首条消息传入
- handoff > 8 KB：context-relay 把它写到 `$TMPDIR` 下一个 `0600` 临时文件，argv 里只放一段简短引用 prompt：「请读 handoff 文件 …，然后继续」。Codex 用文件读取工具读完后继续。Codex 退出时临时文件被删除。

两种情况下，Codex 第一次回应都会"确认 + 概述下一步"（这就是上次讨论的那个 ~10s 回合）。之后你就照常打字。

**Step 5 — 验证 Codex 真的看到了上下文。**

等 Codex 第一次回应完，问它只有上次 session 才知道的事：

```
我之前在 Claude 里问的第一个问题是什么？逐字告诉我。
列一下 Claude 都动过哪些文件，跑过哪些命令。
```

Codex 应该能准确答出来。能答 → handoff 起作用了，继续干活。

### 场景 B：Codex → Claude Code

与场景 A 完全对称。你在 Codex 里干了一会儿，想让 Claude Code 接着干。

**Step 1 — 离开 Codex（或开新终端）。** Codex 的 rollout JSONL 也是连续落盘的。

**Step 2 — `cd` 到仓库。**

```bash
cd /path/to/your/repo
```

**Step 3 — Preview。**

```bash
relay preview claude --max-chars 8000 | less
```

如果 Codex 是在 worktree 或子目录里跑的，session 里记录的 cwd 可能跟你当前 git root 对不上。`relay inspect` 会告诉你"for this repo"是多少；如果是 0，加 `--all` 把范围放宽：

```bash
relay list claude --all
relay claude --pick <id-prefix>          # 再显式指定一个
```

**Step 4 — 启动。**

```bash
relay claude
```

Claude Code 的 TUI 起来，handoff 作为首条 user message 进入（> 8 KB 时同样走临时文件路径）。

**Step 5 — 验证。**

```
逐字告诉我我在前一个 Codex session 里问的第一个问题。
总结一下 Codex 已经搞定了什么，还有哪些没收尾。
```

### 并行模式（不切，两个一起开）

不一定非要关掉一个再用另一个。开两个终端 tab：

| Tab 1                                  | Tab 2                                                |
| -------------------------------------- | ---------------------------------------------------- |
| `codex`（或 `claude`）继续跑           | `cd repo && relay claude`（或 `relay codex`）        |

两边都拿到同样的仓库状态 + 同样的过往上下文。需要让另一个 agent 给同一个问题第二个意见时很方便，不用丢掉原来的 session。

### 实战常用 flag 组合

```bash
# 本 repo 没有 session 记录（worktree / 仓库挪过位置 / 软链）
relay list codex --all                     # 看磁盘上全部候选
relay codex --pick <id-prefix>             # 再显式选一个

# 让接收方也看到你当前未提交的改动
relay codex --with-diff

# 调大 handoff 上限，让原始任务和对话尾部都更完整
relay codex --max-chars 20000

# 只看不启动
relay codex --dry-run

# 排查到底选了哪个 session、为什么选它
relay codex --debug --dry-run

# 信任 transcript，跳过脱敏（少用）
relay codex --no-redact
```

### 不会工作的几种用法

- 在源 agent 自己的 REPL 里跑 `relay`。永远在普通 shell 里跑。
- 一条命令切换多个仓库。`relay` 只针对**当前** git root。
- 跨机器 handoff。transcript 在本地。真要跨机的话只能手动拷 JSONL。
- 期望接收方"真正续上"原 session ID。handoff 是结构化上下文摘要，不是 session 导入 —— 见 [FAQ](#faq)。

## 示例：`relay inspect`

```
$ cd ~/work/my-project
$ relay inspect
codex-claude-relay v0.1.2 inspect

Git context:
  cwd:         /Users/alice/work/my-project
  inRepo:      true
  root:        /Users/alice/work/my-project
  branch:      main

Codex sessions (~/.codex/sessions):
  dir exists:    true
  total on disk: 137
  for this repo: 12
  most recent:   ~/.codex/sessions/2026/05/21/rollout-2026-05-21T09-15-22-…jsonl
                 2026-05-21T01:22:08.142Z

Claude Code sessions (~/.claude/projects):
  dir exists:    true
  total on disk: 42
  for this repo: 3
  most recent:   ~/.claude/projects/-Users-alice-work-my-project/8c3f….jsonl
                 2026-05-21T14:10:01.000Z

Binaries on PATH:
  claude:      yes
  codex:       yes
```

## 示例：handoff 实际长什么样

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
- 不要假设上一个 agent 的结论仍然正确
- 动手前先看当前文件 / `git status` / `git diff`
- 优先以当前仓库状态为准，而非 transcript 里的回忆
```

## 发现规则

两边 provider 都递归扫对应目录，廉价读元数据，结果**按 mtime 倒序**返回，每条 session 带一个布尔标记 `relevantToRepo`。

"属于当前 repo" 的判定（满足任一即可）：

| 信号                                                          | Codex | Claude |
| ------------------------------------------------------------- | :---: | :----: |
| session 记录的 `cwd` 等于当前 git root                        |   ✓   |   ✓    |
| session 记录的 `cwd` 在当前 git root 之下                     |   ✓   |   ✓    |
| 文件位于 `~/.claude/projects/<encoded-当前-git-root>/`        |   —   |   ✓    |

就这些。不打分、不模糊匹配、不做衰减。"当前 repo 最适合的 session" = 满足上述任意一条且 mtime 最新的那个。

当前 repo 之外的 session 仍然被记录在内存里 —— `--all` 把它们放进 `list` / `--grep` 的范围；`--pick <id-prefix>` 永远在**全部** session 里找（不管你有没有加 `--all`）。

## 原生 transcript 格式

codex-claude-relay 不发明任何文件格式，直接解析两家 CLI 已经写好的内容。

**Codex CLI** — 每个 session 一份 JSONL，一行一个事件：

```
~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
```

每行结构 `{ "type", "payload", "timestamp" }`。重要的 payload 类型：

| `payload.type`               | 含义                                                |
| ---------------------------- | --------------------------------------------------- |
| `session_meta`               | `cwd`、`id`、originator、模型                      |
| `message`（role=user）       | 用户输入（`content[].input_text`）                  |
| `message`（role=assistant）  | 模型回复（`content[].output_text`）                 |
| `function_call`              | 工具调用（`name`，JSON 字符串 `arguments`）         |
| `function_call_output`       | 工具结果（`output` 是抓取到的输出文本）             |

**Claude Code** — 每个 session 一份 JSONL，按项目目录归组：

```
~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl
```

`<encoded-cwd>` 是把绝对路径里的 `/` 和 `.` 都替换成 `-`。关键行：

| `type`        | 含义                                                                |
| ------------- | ------------------------------------------------------------------- |
| `user`        | 用户消息或多个 `tool_result` 块；同时带 `cwd`、`gitBranch`          |
| `assistant`   | 模型回复：text + `tool_use` 块（`name`，`input`）                   |

工具调用在 `message.content[]` 里以 `{ type: "tool_use" }` 出现；它们的结果落在下一条 `user` 行里以 `{ type: "tool_result" }` 出现。

如果 `~/.claude/projects/<encoded-cwd>/memory/` 存在，里面的 `MEMORY.md` 和它链接的 `.md` 文件会一并拼进 Claude → Codex 方向的 handoff。

## 会被过滤掉的内容

为了让 handoff 可读，解析阶段会丢弃：

- Codex 的 `reasoning` 事件（模型的内部思考）
- Codex 的 `event_msg` / `turn_context` / `token_count` 等框架事件
- Codex 的 `<environment_context>…` 自动注入消息
- Claude 的 `<task-notification>`、`<system-reminder>`、单独的 `[Image: source: …]`、slash command 包装等
- Claude 的 sidechain 消息（`isSidechain: true`）
- 命中脱敏规则的所有字符串（见下）

每条工具输出会被裁到约 400 字符，避免一个 `cat 大文件` 把别的全挤掉。

## 安全模型

| 关注点                            | 实现方式                                                                                                  |
| --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 原生文件                          | 只读。不会向 `~/.codex/sessions/` 或 `~/.claude/projects/` 写入任何内容                                  |
| transcript 中的密钥               | 默认脱敏，规则见下                                                                                        |
| 进程列表 / argv 泄漏              | handoff 超过 8 KB 时写入 `0600` 临时文件（外层目录 `0700`，按本次调用单独建），argv 里只放一段简短引用 prompt。子进程退出时临时文件被删除 |
| Shell 解释                        | `spawn(..., { shell: false })`。handoff 永远不会被 shell 二次解释                                          |
| 数据陈旧                          | 源 session 超过 24 小时未活动时，handoff 头部会自动加 `⚠ stale` 提示                                       |

脱敏覆盖（含大小写不敏感处）：

- OpenAI 密钥：`sk-…`、`sk-proj-…`、`sk-ant-…`
- GitHub token：`ghp_`、`gho_`、`ghu_`、`ghs_`、`ghr_`
- AWS access key id（`AKIA…`）
- Google API key（`AIza…`）
- JWT（三段 base64url + 点号）
- PEM 私钥块（`-----BEGIN … PRIVATE KEY-----` … `-----END …-----`）
- `Authorization:` 和 `Set-Cookie:` 头
- `*SECRET*=`、`*TOKEN*=`、`*PASSWORD*=`、`*API_KEY*=`、`*CREDENTIAL*=` 环境变量风格（值长度 ≥ 6）

只在你信任 transcript 时再加 `--no-redact`。

## 局限

| 情况                                              | 行为                                                              |
| ------------------------------------------------- | ----------------------------------------------------------------- |
| transcript 被关闭或删除                           | 没东西可读；`relay inspect` 会显示 `count=0`                      |
| 两个仓库 basename 相同                            | cwd 精确匹配 +60 仍然会赢；可以 `--debug` 看具体原因              |
| 同一项目在 Claude 里跑过多次 session              | 当前 repo 最新的那次胜出；想钉死某次用 `--pick <id-前缀>` 或 `--grep "<text>"` |
| Codex / Claude 上游 schema 变化                   | 解析跳过坏行并在 `--debug` 中报告数量                             |
| 跨机器 handoff                                    | 不支持，transcript 在本地磁盘上                                   |
| 巨大的工具输出                                    | handoff 里每条事件裁到约 400 字符                                 |
| Codex / Claude 自己轮转或清理 session 文件        | 文件没了，对应的上下文源也就没了                                  |

## FAQ

**这真能让 Claude「续上」一个 Codex session 吗？**
不行。Claude 仍然是开新的原生 session，把 handoff 当作首条用户消息读进去。handoff 是给 agent 看的结构化摘要，不是字面意义上的 session 导入。

**它会往磁盘写东西吗？**
仅当 prompt 超过 argv 内联上限（约 8 KB）时会落临时文件，位于 `$TMPDIR` 下，子进程退出时删除。

**我想自己把 handoff 留底，可以吗？**
直接重定向就行：`relay preview codex > .ai/handoff.md`。工具默认不替你写，因为「无状态」是产品的核心定位。

**为什么不默认带上 `git diff`？**
大多数会话改动的文件你都已经 commit 了，diff 反而是噪声。真有未提交工作时加 `--with-diff`。

**为什么是一整段，不切碎？**
目标 agent 启动时只读一段初始 prompt。切碎以后它还得自己拼回去。

**能在 Codex / Claude 内部跑 `relay` 吗？**
能跑，但它会生成「当前正在被读的 session」的 handoff，通常不是你想要的。推荐用法是退出 agent 后在另一个终端窗口跑。

**为什么排序看 cwd，不看内容？**
便宜又够准。看内容意味着每次都得完整读所有 transcript。cwd 命中 + 新鲜度足够在毫秒级挑出当前仓库的会话。

## 开发

```bash
npm install
npm run typecheck     # 严格 TS，无任何 suppress
npm test              # node --test 跑 17 个单元测试
npm run build         # tsc → dist/
node dist/cli.js inspect
```

代码结构：

```
src/
  cli.ts              # 参数解析 + 子命令分发
  index.ts            # 编程接口导出
  types.ts            # 共享类型（仅类型，无运行时）
  git.ts              # git rev-parse / 分支 / diff
  parse/jsonl.ts      # 流式 JSONL 读取与工具函数
  providers/
    codex.ts          # ~/.codex/sessions 的发现与解析
    claude.ts         # ~/.claude/projects 的发现 / 解析 / memory
  redact.ts           # 密钥模式
  summarize.ts        # 事件归纳 + handoff 模板
  launch.ts           # child_process spawn + 大 prompt 落临时文件
test/                 # node:test 单元测试
```

依赖：仅 `typescript` 与 `tsx` 作为 devDependencies。**零运行时依赖**，CLI 完全跑在 Node 内置模块上。

## 更新历史

完整版本变更见 [CHANGELOG.md](./CHANGELOG.md)。

## License

MIT，见 [LICENSE](./LICENSE)。
