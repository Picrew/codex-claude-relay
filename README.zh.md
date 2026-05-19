# context-relay

在 **OpenAI Codex CLI** 与 **Anthropic Claude Code** 之间做上下文接力：直接读两边写在本地的原生 session 文件，挑出和当前仓库相关的一次会话，压成一段 handoff prompt，把另一边的 CLI 用这段 prompt 当作首条用户输入启动。

不开数据库。不跑后台进程。不改写两边任何原生文件。

🌐 English: [README.md](./README.md)

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

context-relay 走另一条路：**什么都不存**。每次调用都重新读原生 transcript。两个工具仍然是仅有的真相来源，这个 CLI 只是无状态的读取器 + 进程启动器。

| 方案                                  | 持久存储 | 修改原生文件 | 直接读原生 transcript |
| ------------------------------------- | :------: | :----------: | :-------------------: |
| 手动复制粘贴                          | —        | 否           | —                     |
| 向量库 / 记忆同步工具                 | 是       | 否           | 有时                  |
| 在仓库里维护 `.ai/handoff.md`         | 是       | 否           | 否                    |
| **context-relay**                     | 否       | 否           | 是                    |

## 安装

需要 Node.js 20+。如果想真的启动目标 CLI，`claude` 与 `codex` 都需要在 `PATH` 上（否则 `relay preview` / `--dry-run` 仍可用）。

```bash
git clone https://github.com/Picrew/codex-claude-relay
cd codex-claude-relay
npm install
npm run build
npm link          # 暴露全局 `relay` 命令
```

或者不 link，直接：

```bash
node dist/cli.js inspect
```

## 命令

| 命令                       | 作用                                                                  |
| -------------------------- | --------------------------------------------------------------------- |
| `relay claude`             | 从最相关的 Codex session 生成 handoff，启动 `claude`                  |
| `relay codex`              | 从最相关的 Claude session 生成 handoff，启动 `codex`                  |
| `relay preview <target>`   | 只打印 handoff，不启动任何东西                                        |
| `relay inspect`            | 显示发现到的 session、打分与原因                                      |

### 选项

```
--last           直接用最新 mtime 的 session，跳过 cwd 排序
                 （当 cwd 匹配不上时有用）
--with-diff      把当前 `git diff HEAD` 拼到 handoff 里
--max-chars N    handoff 字符上限（默认 12000）
--dry-run        只生成并打印 handoff，不启动目标 agent
--no-redact      关闭密钥脱敏（默认开启）
--debug          stderr 输出详细发现 / 解析信息
```

## 示例：`relay inspect`

```
$ cd ~/work/my-project
$ relay inspect
context-relay v0.1.0 inspect

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

## 发现与打分

两边的 provider 都递归遍历对应目录，廉价读出 metadata 后排序：

```
score = cwd 匹配信号 + 新鲜度衰减
```

| 信号                              | Codex 权重  | Claude 权重 |
| --------------------------------- | :---------: | :---------: |
| 记录的 cwd 等于 git root          | +60         | +60         |
| 记录的 cwd 在 git root 之下       | +50         | +50         |
| 记录的 cwd 路径中包含仓库名       | +25         | +20         |
| 文件位于 Claude 编码后的项目目录  | —           | +40         |
| 新鲜度：14 天内线性衰减           | +0 … +30    | +0 … +30    |

加 `--last` 跳过打分，强制使用 mtime 最新的那个文件。加 `--debug` 看选中候选的 reasons 字符串。

## 原生 transcript 格式

context-relay 不发明任何文件格式，直接解析两家 CLI 已经写好的内容。

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
| 同一项目在 Claude 里跑过多次 session              | cwd 分最高且最新的那次胜出；必要时用 `--last` 钉死                |
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

## License

MIT，见 [LICENSE](./LICENSE)。
