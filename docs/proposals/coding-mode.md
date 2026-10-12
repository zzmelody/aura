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

### Phase 3 · 双向交互

**提问应答已完成** ✅（`src/coding/questions.ts`，测试 `coding-questions*.test.ts`）：

- `ask_user_question` 加入白名单。每轮在 agent 作用域挂 `user-questions/request`
  应答端，问题以 `question` 事件推给客户端，调用挂起直到用户作答或本轮停止。
- `POST /coding/sessions/:id/answer` 交回答案。只接受提问的那个会话、只接受被问到的
  问题 id，选项必须是给出的选项，单选最多一项，自由文本截断到 4000 字符；一个问题只能答一次。
- 前端问题卡片：选项、可选的自由回答、发送；作答后折叠为“已回答”，等待时轮次状态显示
  “等待你的回答”。
- 新增依赖 `@deepseek-ai/dsh-user-questions@0.1.5-rc.3`（固定版本，DSH 自带包）。

**审批与计划审阅已接入**：

- 每轮在 agent 作用域挂 `approval/request` 应答端（例如命令请求越出沙箱时），以“允许这一次 /
  拒绝”卡片推给用户。只有明确选“允许这一次”才放行；自由文本不能代替授权；停止本轮等于拒绝。
  新增依赖 `@deepseek-ai/dsh-user-approval@0.1.5-rc.3`。
- `exit_plan_mode` 的问题带 `intent: plan-review`，卡片标题为“请审阅计划”，计划正文放大显示，
  批准选项标注“批准后开始实施”；只有 `approve` 指向已给出选项时才保留 intent。
- 沙箱放宽请求的原因改写成中文（例如“请求把沙箱放宽到「完全访问」。理由：…”），其他原因原样显示。
- 验证程度：审批与 intent 的转换逻辑有单元测试；两种卡片已在浏览器里用模拟后端验证渲染与作答。
  审批端到端测试（`coding-approval-dsh.test.ts`）在真实 DSH 上运行沙箱、审批服务和 bash 工具：
  选“允许这一次”后命令执行并写入文件，选“拒绝”后命令不执行、步骤失败；两种结果都能从历史回放。
  测试会话从只读放宽到“可写项目目录”，授权范围只在临时项目内，没有测试 `danger-full-access`。

### Phase 4 · 回看 ✅（`src/coding/history.ts`，前端 `features/coding/turns.ts`）

- `GET /coding/sessions/:id/history` 通过 DSH 的分页读取（与 Flow 历史同一路径，宿主重启后可读）
  读回会话日志，按轮次重建：提问、工具步骤、diff、进度、问答及答案、回复、结束状态。
  只接受 Aura 索引里的编码对话，不能借此读取别的 DSH 会话。
- 实时流与回放共用后端 `projectCodingEvent` 和前端 `applyTurnEvent`，刷新前后内容一致
  （有测试断言二者等价）。
- 宿主重启后继续旧对话会 `agents.resume` 存储的会话，模型保留上下文，不会新建会话。
- 刷新页面时如果模型正在等你回答，等待中的问题会随历史一起返回，可以直接作答。
- 已结束轮次里没收到结果的步骤显示为失败，不会一直转圈。
- 同一对话同时只允许一轮进行。
- 已在真实 DSH 上测试（含宿主重启后回放和续聊），并在浏览器里验证刷新后回放。

- 本轮小结：每轮结束后列出改动的文件（合并同一文件的多次改动，带增删行数）、运行的命令及成败、
  失败步骤数和未回答的问题数。内容取自记录下来的步骤，不依赖模型自述；只读取文件的轮次不显示小结。

- 交付文件：每个文件可复制完整路径；桌面端还可“在文件夹中显示”。只定位、不打开，避免一键运行模型
  产出的脚本。主进程按项目目录解析路径，只接受项目内已存在的普通文件，拒绝 `..` 越界、绝对路径越界、
  目录和不存在的文件（`tests/desktop-reveal.test.ts`）。Web 端没有定位按钮。

## 风险与待定

仍然成立：

- **读取不受限**：`workspace-write` 沙箱只限制写入。`read`、`glob`、`grep` 能读项目目录以外的
  文件，`glob`/`grep` 也不经过 `fs-sandbox`。
- **界面不显示当前沙箱模式**：默认是 `workspace-write`，可被 `DSH_PERMISSION_MODE` 改掉；
  设成 `danger-full-access` 时审批策略变为 `never`，越权不再询问。界面目前看不出处于哪种模式
  （可用 `sandbox/mode` 事件展示）。
- **并发与普通对话共用名额**：编码轮次和 `/chat` 共用进程内 2 个并发名额（`plugin.ts` 的
  `chats.size >= 2`）。一轮编码最长 30 分钟，两轮编码同时进行会让普通对话返回“服务忙”。
  同一对话同时只允许一轮。
- **Windows 未验证**：命令在 Windows 走 `tool-pwsh`。白名单接受 `pwsh`，但审批端到端测试在
  Windows 上跳过，pwsh 路径没有跑过。
- **等待中的问题只在内存里**：宿主重启时等待中的问题会丢失（那一轮本身也随之中断），重启后该轮
  显示为已停止。

已解决：

- **profile 全局启用工具的影响面**：走了兜底路线。测试锁住了普通对话只看到自己的工作流工具、
  看不到编码工具；追问轮也会重新挂白名单（`coding-dsh.test.ts`）。
- **`AURA_HISTORY_V1` 回灌**：编码模式用真正的长驻多轮 session，不走回灌路径；宿主重启后用
  `agents.resume` 续上存储的会话。

## 验收

- 能添加本机目录为项目，并在项目下开多个编码对话。
- 对话中能实时看到每次工具调用与结果、改动过的文件、任务进度与整体耗时。
- 模型能主动提问，用户能作答并让对话继续。
- 模型能自行运行测试并报告结果。
- 对话结束有一份报告，且事后可回到该对话查看完整过程。
- 普通对话、Flow Agent 与演示模式的现有行为不变。
- 通过 `pnpm run format:check`、`pnpm run lint`、`pnpm run check`。

验收结果：以上功能项都已完成并测试。`format:check`、`lint`、`check:workspaces`、`typecheck`
通过；`pnpm run check` 里的 `test` 有 4 个失败（orchestration 3 个 ffmpeg 相关、runtime 1 个
AI routes），在编码模式改动之前的代码上同样失败，与本功能无关，因此 `pnpm run check` 整体不通过。
