# 编码模式（项目制）

## 目标

在 Aura 中新增一个**编码模式**：以**项目**（本机目录）为单位，用户与一个能读写代码、执行命令的
AI 对话，全程可见、可干预，结束时产出报告。对标 Codex 的项目制交互，底层复用 DeepSeek Harness
自带能力，不使用 Pi，也不自建文件/命令 Action。

用户明确要求的行为：

| #   | 要求                           | 对应机制                                             |
| --- | ------------------------------ | ---------------------------------------------------- |
| 1   | 能看见它在做什么               | `tool/call`、`tool/result`、`step/start`、`step/end` |
| 2   | 它可以自己规划                 | `plan-mode`、`todo_write`                            |
| 3   | 问到问题可以回答               | `userQuestions.ask()`、`approval/asked`              |
| 4   | 自己执行、走测试               | `dsh-tool-bash`                                      |
| 5   | 对话结束给出报告               | `present` → `deliverables/presented`                 |
| 6   | 信息透明，能看改了什么文件     | `write`/`edit` 的 diff-card 元数据、`present`        |
| 7   | 可以接受输入，不是完事后看结果 | 长驻 session + 中途提问应答                          |
| 8   | 对话中有进度条                 | `todo/write` 投影                                    |
| 9   | 有整体运行时间                 | `turn/start` … `turn/end`                            |
| 10  | 之后能进去看这次对话做了什么   | DSH JSONL session 日志重放                           |

## 关键发现

### DSH 已具备完整编码工具链

以下包都是 `@deepseek-ai/dsh-base` 的真实依赖，全部已安装：

| 能力         | 包                                                   | 对模型暴露                                                                                        |
| ------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 文件读写     | `dsh-tool-fs`                                        | `read`、`write`、`edit`（`old_string`/`new_string`，唯一匹配或 `replace_all`）、`read_image`      |
| 文件搜索     | `dsh-tool-fs-search`                                 | glob / grep                                                                                       |
| 命令执行     | `dsh-tool-bash`（POSIX）、`dsh-tool-pwsh`（Windows） | shell                                                                                             |
| 目录写入限制 | `dsh-fs-sandbox`                                     | 按 session 把写入限制在 workspace 根；模式 `read-only` / `workspace-write` / `danger-full-access` |
| 任务清单     | `dsh-tool-todo`                                      | `todo_write`（整表替换，按 session 归属）                                                         |
| 提问         | `dsh-user-questions`                                 | `ctx.userQuestions.ask()`                                                                         |
| 交付物       | `dsh-tool-present`                                   | `present`                                                                                         |
| 规划         | `dsh-plan-mode`                                      | `/plan`、`exit_plan_mode` 审阅                                                                    |

`dsh-tool-fs` 的 README 明确说明：`write`/`edit` 会产出**可重放的 diff 卡片元数据**供 UI 展示
——要求 6 不需要自己实现 diff。

### Aura 目前把工具全部禁用了

`packages/backend/orchestration/src/profile.ts:52-80` 的 `disabled` 列表禁用了 `tool-bash`、
`tool-pwsh`、`tool-fs`、`tool-fs-search`、`plan-mode`、`tool-todo`、`tool-web` 等。

注意：被禁用的是**面向模型的工具行**，而 `fs-local`、`fs-sandbox`、`sandbox-policy`、
`user-approval`、`permission-presets` 这些**基础设施仍然启用**。所以底座在，只是没接工具。

### 工具边界是 fail-closed 白名单

`chat.ts:108-115` 与 `sessions.ts:156-160` 都对 agent scope 先 `tools.restrict({ allow: [] })`
再注册白名单工具。`dsh-tools` 的类型声明确认 `restrict({ allow })` 语义是"keep only"，且
**不影响 scope 自身注册的工具**。

这带来一个很强的安全性质：即使全局启用这些工具，现有普通对话与 Flow Agent 也不会被波及。

### 项目制底座已挂载

`profile.ts:123` 已挂载 `@deepseek-ai/dsh-workspace`，提供 `ctx.workspaceRegistry`：
按 canonical realpath 去重的项目列表、`create(path, title)`、`setTitle`、排序、以及**按目录自动
归类 session**。对模型不可见，零 token 成本。

### 事件流已经足够详细

`dsh-session/lib/types/known-event-types.js` 列出完整事件词表。与需求相关的：
`tool/call`、`tool/result`、`step/start`、`step/end`、`todo/write`、`approval/asked`、
`approval/decided`、`sandbox/mode`、`permission/preset`、`plan/mode`、`deliverables/presented`、
`turn/start`、`turn/end`、`assistant/message`。

`chat.ts:149` 已经订阅 `session/event`，只是目前只挑出文本。

### 与现有对话的三个差异

1. **cwd 是全局常量**。`chat.ts:98` 的 `cwd` 来自环境变量 `AURA_FLOW_CWD`，所有 agent 共用。
   项目制必须按 session 传入。
2. **session 是一次性的**。`chat.ts:93` 每次请求 `SessionId(randomUUID())`，历史以
   `AURA_HISTORY_V1` JSON 压成一条消息回灌。编码需要**长驻 session**，否则工具状态、
   todo、plan mode、事件日志都无法跨轮累积。
3. **没有提问/审批应答端**。profile 未配置 `approval`，DSH 基座默认为 `ask`；若无客户端应答，
   提问会挂住。这是必须先解决的一环。

## 架构设计

### 分层

| 层       | 位置                                               | 职责                                                |
| -------- | -------------------------------------------------- | --------------------------------------------------- |
| shared   | `packages/shared/protocol/src/coding.ts`           | 项目、编码会话、活动事件的 DTO                      |
| backend  | `packages/backend/orchestration/src/coding/`       | 项目注册、编码 session 生命周期、事件投影、提问应答 |
| backend  | `packages/backend/orchestration/presets/coder-v1/` | 编码 agent 的人设与工具组合                         |
| backend  | `packages/backend/runtime/src/coding-routes.ts`    | HTTP 边界                                           |
| frontend | `packages/frontend/workbench/src/features/coding/` | 项目屏、编码对话页、活动时间线、报告                |

`orchestration/src/coding/` 与既有 `content/`、`video/`、`topics/` 同级，符合
`docs/development/module-boundaries.md` 的领域目录约定。

### 数据归属

- **项目**：由 DSH `workspaceRegistry` 持有，持久化在 DSH storage domain，路径经 realpath 归一。
- **编码会话**：后端持有。每个编码对话 = 一个长驻 DSH session（JSONL 日志即完整过程记录），
  另在 Aura 自己的 domain 存一份索引（项目 id、标题、时间、状态）。
- **客户端**：只缓存列表与引用，不持有过程记录。

这与现有"普通对话历史存 localStorage"不同，是刻意的：编码过程需要刷新页面后仍可续、可回看。

### 工具启用方式

**首选**：在 `coder-v1` preset 的 `agent.cordis.yml` 里挂载 `dsh-tool-fs`、`dsh-tool-fs-search`、
`dsh-tool-bash`、`dsh-tool-todo`、`dsh-tool-present`、`dsh-plan-mode` 与人设。`dsh-agent-presets`
的文档确认 preset 就是按 session 组合工具、提示词与 skills 的机制，`dsh-tool-present` 也说明
自带 preset 就是这样挂的。

**兜底**：若 preset 层无法挂载被 profile 禁用的行，则从 `profile.ts` 的 `disabled` 列表移除这些
工具，改由 fail-closed 白名单保护——普通对话与 Flow Agent 已 `restrict({ allow: [] })`，
不会获得工具。

按 session 的写入限制由 `dsh-fs-sandbox` 提供，workspace 根取自 session 的 cwd。

### 交互通道

现有 `/chat/*` 是一条单向 NDJSON 流。编码模式在其上加**双向**能力：

- 下行：扩展事件类型（工具调用、结果、todo、交付物、提问、审批、计时）。
- 上行：新增 `POST /coding/sessions/:id/answer`，客户端提交提问/审批答案，后端 resolve 挂起的
  `userQuestions` promise。

## 分阶段实施

### Phase 0 · 可行性验证 ✅ 已通过

验证结果（`packages/backend/orchestration/test/coding-dsh.test.ts`，真实 DSH，非 stub）：

1. **工具可挂载** ✅ — 从 profile 禁用清单移除即可生效。`restrict({ allow })` 按名放行，
   编码会话拿到 `read` / `write` / `edit` / `glob` / `grep` 等工具，模型发起 `write` 后
   文件确实写入项目目录。
2. **按项目限制写入** ✅ — `meta.cwd` → `session.header.cwd` → `sandbox-policy` 的
   `workspaceRoot`，`workspace-write` 把变更限制在项目目录内。
3. **提问失败关闭** ✅ — 无应答端时审批立即返回 `unavailable`，**不会挂起**（非预期但更安全）。

**关键安全性质已用测试锁住**：普通对话仍只看到自己的工作流工具（`aura_tts` 等），
看不到任何编码工具。profile 层面启用不影响既有 fail-closed 白名单。

验证中修正的两处事实：

- **`present` 需要显式挂载**。它不在 `dsh-base`，而由 DSH 自带的 Web preset 提供，Aura 用
  `includeShippedRoot: false` 排除了那些 preset，因此必须在 profile 显式插入。
- **`agent-instructions` 不能启用**。它是提示词插件而非工具，`restrict` 只过滤工具，
  启用后会让**每个** agent 都加载仓库指令文件。已保留禁用。

### Phase 1 · 项目制

**后端已完成** ✅（`src/coding/projects.ts`、`src/coding/index-record.ts`、
`runtime/src/coding-routes.ts`，测试覆盖创建、列表、状态、会话归组）：

- HTTP：`GET /coding/projects`、`POST /coding/projects`、`POST /coding/projects/:id/rename`、
  `DELETE /coding/projects/:id`、`GET /coding/projects/:id/conversations`、
  `POST /coding/turn`（NDJSON 流）。
- 项目记录由 DSH `workspaceRegistry` 持有，路径经 realpath 归一（macOS 上 `/var` →
  `/private/var`）。删除只移除登记，不动目录与会话日志。
- 沙箱根**只取自项目记录**，客户端只传 `projectId`，不传路径。
- DSH session header 没有标题字段，会话标题由 Aura 自己的 `aura_coding_conversations`
  域保存（首轮提问截取）。
- 会话必须先存在才能 `attachSession`，因此首轮结束后再归组。

**前端已完成** ✅（`workbench/src/features/coding/`，侧栏「工作台 → 编码」）：

- 项目栏 + 对话栏 + 主区，复用 `studio-shell` 布局；窄屏改为工具栏下拉。
- 目录选择：桌面端复用通用的 `workflowFiles.choose("directory")` 桥接（Site 的选择器要求
  `package.json`，不适用任意目录）；Web 端粘贴绝对路径。
- 已用真实浏览器在 1280px 与 390px 下验证，无横向滚动。

### Phase 2 · 编码会话与可见性

**大部分已完成** ✅：

- `coder-v1` preset、长驻 session（多轮续用，cwd 绑定项目）。
- 活动时间线：每次工具调用一行，显示中文名 + 涉及的文件/命令，配成功/失败状态。
  `tool/result` 的 callId 与失败标志在 `message.content[0]` 上，不在事件顶层。
- 进度条：`todo/write` 中 `status === "completed"` 的条数 / 总数。
- 交付文件：`deliverables/presented` 的 `files[].path`。
- 计时：每轮从发送到结束的耗时，运行中每秒刷新。

- 文件改动卡片：`write`/`edit` 的 hunk 取自 `tool/result.meta.diffs`。新建文件时
  `dsh-tool-fs` 不附 hunk，改用调用参数里的内容显示为全部新增。每侧截断到 4000 字符、
  最多 12 个 hunk。

已知限制（归入 Phase 4）：过程记录只保存在页面内存中，刷新后只剩对话列表和标题，
需要从 DSH JSONL 日志重放时间线。

### Phase 3 · 双向交互

- 提问应答：SSE 下发 `question` 事件（含 `intent`），客户端作答回传。
- 审批应答：`approval/asked` 同样处理；UI 明确展示被请求的操作与范围。
- 规划审阅：`exit_plan_mode` 的计划以审阅卡片呈现，可批准或退回修改。

### Phase 4 · 报告与回看

- 交付物：`deliverables/presented` 渲染为文件卡片，可打开/定位。
- 结束报告：本轮改动的文件清单、测试命令与结果、未决问题。
- 历史回看：按 session 读取 JSONL，重放活动时间线。

## 风险与待定

- **安全**：编码工具让模型可写本机文件。`workspace-write` 沙箱把写入限制在项目目录，但
  **读取不受限**；`danger-full-access` 会解除全部限制。默认模式与审批策略需明确设定，
  且必须在 UI 上说清当前处于哪种模式（`sandbox/mode` 事件可用于展示）。
- **profile 改动的影响面**：若走兜底路线，`profile.ts` 是全局配置，需回归普通对话、
  Flow Agent、演示模式三条链路。
- **`AURA_HISTORY_V1` 回灌**与长驻 session 并存会重复上下文，编码模式应改为真正的多轮
  session，不复用回灌路径。
- **并发**：现有 `/chat` 限制单进程 2 个并发请求（`api-server.ts:97`）。编码会话是长驻的，
  需要独立的并发与生命周期策略，不能直接套用。
- **跨平台**：命令执行在 Windows 走 `tool-pwsh`，与 POSIX 的 `tool-bash` 是两条路径，需分别验证。

## 验收

- 能添加本机目录为项目，并在项目下开多个编码对话。
- 对话中能实时看到每次工具调用与结果、改动过的文件、任务进度与整体耗时。
- 模型能主动提问，用户能作答并让对话继续。
- 模型能自行运行测试并报告结果。
- 对话结束有一份报告，且事后可回到该对话查看完整过程。
- 普通对话、Flow Agent 与演示模式的现有行为不变。
- 通过 `pnpm run format:check`、`pnpm run lint`、`pnpm run check`。
