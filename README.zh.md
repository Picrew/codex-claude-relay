# context-relay

> 在 **OpenAI Codex CLI** 与 **Anthropic Claude Code** 之间做无状态的上下文接力。
> 不开新数据库。不加新记忆层。只做一件事：读原生 transcript → 压缩成 handoff → 一行命令启动另一个 agent。

🌐 English: [README.md](./README.md)

---

## 想解决的问题

你正在 Codex CLI 里干活，干到一半发现这种重构 Claude Code 可能更擅长。你切过去。

可是 Claude 不知道：

- 你原本在做什么任务
- Codex 改过哪些文件
- 已经跑过哪些 shell 命令
- 哪些方案试过了被放弃
- 还剩哪些 TODO

于是你前五分钟都在复制粘贴上下文，还总担心遗漏。反过来从 Claude 切回 Codex 也是一样痛。

很多人尝试用「记忆同步」工具来解决这件事，但这些方案几乎都会引入第三个记忆存储（向量库、`.ai/handoff.md`、云同步……），两个原生工具谁都不认它。于是你就有**三份「真相来源」**，新的那份永远跟不上。

## context-relay 是什么

它有意做得很窄：

1. 读 Codex 与 Claude Code **本来就写在硬盘上的原生 transcript 文件**。
   - Codex CLI：`~/.codex/sessions/**/rollout-*.jsonl`
   - Claude Code：`~/.claude/projects/<编码后的目录>/*.jsonl`（外加可选的 `memory/MEMORY.md`）
2. 针对你**当前所在的 git 仓库**，挑出最相关的近期 session。
3. 把它压缩成一段精炼的、agent 可读的 handoff prompt。
4. 用这段 prompt 作为初始输入，启动另一个 CLI。

整个产品就这么多。**没有数据库，没有后台进程，不会改写原生文件，也不会伪造 session ID。**

```
codex
# 干了一会儿，觉得接下来这步 Claude 更合适

relay claude       # 把 Codex 这次 session 压缩好，作为初始 prompt 启动 claude

# 再后来…
relay codex        # 把 Claude 这次 session 压缩好，作为初始 prompt 启动 codex
```

## 它**不是**什么

- **不是**记忆数据库。没有向量库，没有 SQLite，没有 JSON 缓存。
- **不是** session 导入器。它不能让 Claude 真的「续上」一个 Codex 的原生 session ID —— 那需要伪造原生文件，而那些文件会被原工具随时覆盖或失效。
- **不是**同步工具。它每次只跑一回，跑完就退出。
- **默认不会**往 `.ai/handoff.md` 或任何仓库文件写东西。想看可以用 `relay preview` 或 `--with-diff`。

## 安装

需要 **Node.js 20+**。

```bash
# 源码安装
git clone https://github.com/<you>/context-relay
cd context-relay
npm install
npm run build
npm link        # 这样全局都能用 `relay` 命令

# 或者从发布包安装
npm install -g context-relay
```

如果你想用真正的启动功能，需要把 `claude` 和 `codex` 都加进 `PATH`。如果只想看 handoff 长啥样，`--dry-run` / `relay preview` 不依赖它们。

## 用法

```
relay <target>            用对面 agent 的上下文 handoff 启动目标 agent
relay preview <target>    只打印 handoff，不启动
relay inspect             显示发现到了哪些 session

Targets:
  claude   Codex -> Claude Code 方向 handoff
  codex    Claude Code -> Codex 方向 handoff

Options:
  --last              直接用最新一次 session，不做仓库相关性排序
  --with-diff         把当前 `git diff HEAD` 也拼到 handoff 里
  --max-chars N       限制 handoff 字符数（默认 12000）
  --dry-run           只生成并打印 handoff，不启动目标 agent
  --no-redact         关掉密钥脱敏（默认开启）
  --debug             stderr 输出详细的发现 / 解析信息
```

### 示例

```bash
# 把 Codex 这次的工作交接给 Claude Code
relay claude

# 把 Claude Code 这次的工作交接给 Codex，并带上当前 git diff
relay codex --with-diff

# 只看一下 handoff 内容，不启动任何东西
relay preview claude
relay preview codex --max-chars 6000

# 看看 context-relay 给这个仓库挑了哪些 session
relay inspect
```

## 安全模型

- 对 Codex 和 Claude Code 的文件是**只读**的。绝不会写到 `~/.codex/sessions/` 或 `~/.claude/projects/` 里。
- **默认开启密钥脱敏**。API key（`sk-…`、`sk-ant-…`、AWS、Google、GitHub token）、JWT、PEM 私钥、`Authorization:` 头、`Set-Cookie:` 头，以及常见的 `*_SECRET=` / `*_TOKEN=` / `*_PASSWORD=` 等环境变量值会在 prompt 拼出来之前先被替换掉。
- **进程列表安全**。当 handoff 超过约 8 KB 时，会写进一个权限为 `0600` 的临时文件（外层目录权限 `0700`，按本次调用单独创建），再把一段简短的引用 prompt 传给目标 CLI；整段长 handoff 不会出现在 `argv` 或 `ps` 里。子进程退出时这个临时文件会被删除。
- **不走 shell**。`child_process.spawn` 显式 `shell: false`，handoff 永远不会被 shell 二次解释。

## 发现逻辑

`relay claude`（源 = Codex）：

1. 遍历 `~/.codex/sessions/**/rollout-*.jsonl`。
2. 读每个文件第一行 `session_meta`，拿到记录的 `cwd`。
3. 打分：
   - **cwd 匹配**：精确等于 git root > 在 git root 之下 > 路径里包含仓库名
   - **新鲜度**：14 天内线性衰减
4. 取最高分（如果加了 `--last` 就直接用最新修改时间的那个）。

`relay codex`（源 = Claude Code）：

1. 先走快路径 `~/.claude/projects/<编码后的-git-root>/`。Claude Code 会把路径分隔符和 `.` 都编码成 `-`，所以 `/Users/alice/foo.bar/baz` 变成 `-Users-alice-foo-bar-baz`。
2. 再宽扫整个 `~/.claude/projects/` 作为兜底。
3. 从每个 transcript 的第一条 user/assistant 记录里读 `cwd`。
4. 打分规则同上。
5. 如果项目目录下存在 `memory/MEMORY.md` 和相关 `.md` 文件，会一起拼进 handoff。

`relay inspect` 会把这一切完全展示出来。

## 限制

- **Codex CLI** 和 **Claude Code** 必须真的往各自的目录里写过 transcript。如果你关掉或删掉了 transcript，那 context-relay 无米下锅。
- handoff 是一份**摘要**，不是 session 的字面导入。目标 agent 还是开一个全新的原生 session。我们会在 prompt 里明确告诉它：「不要假设上一个 agent 的结论仍然正确，动手前先检查当前文件」。
- 不支持跨机器 handoff。原生 transcript 在本地磁盘上，context-relay 只是读取它们。
- 各家 transcript 格式可能会变。我们用容错的方式解析（坏行跳过、`--debug` 会汇报跳过条数），但如果 Codex 或 Claude Code 有大改动，可能要更新这边的解析器。

## 支持的路径

| 来源        | 路径                                                              |
| ----------- | ----------------------------------------------------------------- |
| Codex CLI   | `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl`              |
| Claude Code | `~/.claude/projects/<编码后的目录>/<session-uuid>.jsonl`          |
| Claude 记忆 | `~/.claude/projects/<编码后的目录>/memory/MEMORY.md` 等           |

如果这两边以后改了路径，欢迎开 issue 给我们贴新路径。

## FAQ

**这真的能把 Codex 的 session 导进 Claude Code 吗？**
不能。它做的是基于 Codex 原生 transcript 合成一段精炼的 handoff prompt，Claude 仍然开新的 session，把这段当成第一条用户输入。

**它会自己存额外记忆吗？**
不会。没有持久存储。每次调用都重新读原生 transcript。

**它会改写 Codex 或 Claude 的原生文件吗？**
不会。只读。

**如果我关掉或删掉了 transcript 还能用吗？**
不能。没有 JSONL 文件就没东西可接力。

**为什么不上向量库？**
那是另一个产品。context-relay 故意只做一行命令的无状态接力。想跨所有历史 session 做语义检索可以另外做，那不是这里的目标。

**为什么 handoff 是一整段，不分多份？**
接收的 agent 启动时只读一段初始 prompt。拆开它还得自己拼回去。

## 开发

```bash
npm install
npm run typecheck
npm test
npm run build
node dist/cli.js inspect
```

## License

MIT
