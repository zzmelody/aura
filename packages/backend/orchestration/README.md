# @aura/orchestration

Aura 唯一的流程编排包，所有定义校验、DAG 调度、并发、取消、节点输入装配、coordinator 汇总、运行记录与 HTTP 接口都在后端。前端不执行流程。

## 使用

启动 Aura 后打开「流程」，填写任务并选择模式：

- **DSH 演示**：使用真实 DSH agent/session/preset 链路，模型输出由本地规则生成，不需要登录、不消耗订阅额度。
- **Codex 真实模型**：由 DSH 的 `openai-codex` provider 执行，沿用顶部登录与后端凭据，消耗已登录账号额度。不会失败后退回演示。

内置「方案分析 + 风险审阅 → 最终报告」。通过「编辑流程 JSON」定制节点、依赖、preset 和 coordinator.sources；改 id 可另存为新流程。点击运行记录中的步骤，可查看对应 session ID、preset、节点输出及 DSH 会话内容。

## 边界

```text
React Native 展示 / 操作
          ↓ /flows/*
@aura/orchestration
  FlowDefinition → FlowRun → StepRun × N → coordinator StepRun
                       │          │                  │
                       │          └── DSH session ───┘
                       └── DSH storageDomain
```

- `schema.ts`：后端 schema、DAG 校验、默认模板和上游输入装配。
- `engine.ts`：后端调度、幂等请求、定义快照、故障与恢复策略。
- `sessions.ts`：DSH Session Controller 适配，使用 create/selectModel/prompt/cancel/follow/page，以及原生 turn events、deriveMessages/flush。
- `plugin.ts`：DSH 插件，组合调度器和原生领域存储；不定义私有 session event。
- `profile.ts`：通过官方 profile/插件接口配置宿主、preset roots 和模型路由。
- `index.ts`：长驻 DSH 子进程与 `/flows/*` HTTP 边界。
- `presets/*`：Aura 自有 DSH preset，不复制 DSH 代码。

普通节点及 coordinator 都是独立的普通 DSH session，不伪装成 DSH subagent。当前锁定版本的原生 subagent/workflow agent 会继承父 preset，不能为每个节点选择独立 preset，因此仅 DAG 调度由 Aura 实现。

## 生命周期与持久化

每个 runtime 懒启动一个 `aura-flow` DSH 宿主，最多同时运行两个流程，每个流程最多 16 个普通节点、并发 1–4。每次运行固定定义快照及 revision；同一 requestId 重复提交只返回原运行，参数变化则返回 409。

每个步骤先持久化独立 session ID，再调用 DSH。节点只有在对应回合成功、agent idle、session flush 成功且存在有效文本输出后才算完成。coordinator 在所有普通节点完成后接收 `sources` 指定的输出，不会隐式收到其他节点内容。依赖节点收到 `dependsOn` 指定的输出。空输出、超过 80,000 字符的输出和超过 180,000 字符的汇总输入均明确失败，不静默截断。

页面刷新、断开 HTTP、切换页面不会取消流程；只有显式取消、节点超时或 runtime 关闭才取消正在执行的 DSH 回合。节点失败后不再启动待执行节点，已运行的其他节点完成后保留其结果，coordinator 跳过。取消是尽力停止，不能撤回已经发生的工具副作用。

DSH 宿主在无运行、无请求五分钟后通过原生根生命周期释放；下一次请求会重新启动并冷读历史。Aura 不取得或销毁 Session Controller 私有 agent handle。

持久化位置均位于已忽略的 `.aura/dsh/`：

- `aura-flow-sessions/`：DSH 原生 JSONL 会话日志。
- `aura-flow-storages/`：DSH JSON backend，`aura_flows` domain 保存定义和运行记录。
- `aura-flow-settings.yaml`：流程宿主自己的 DSH settings，避免节点选模型修改普通对话默认设置。
- `.credentials.yaml`：复用 DSH 凭据，不由编排层读取或返回。

进程崩溃后的未完成运行标为 `interrupted`，保留已完成输出与全部步骤/session 映射。不会自动续跑、自动重试或重放可能产生副作用的工具；用户需要明确新建一次运行。同一请求 ID 在重启后仍保持幂等。领域存储不支持跨进程写锁，同一 DSH home 只能由一个 Aura runtime 的流程宿主使用。

## 注册工具、skill、MCP

复用 DSH 原生 preset composition：在 DSH 用户 preset 根 `.aura/dsh/.agent-presets/<preset-id>/` 放置 `agent.cordis.yml` 与可选 `preset.yml`。DSH 负责发现、健康检查、standing scope 与工具/skill 隔离。下一次读取 catalog 即可发现新 preset；在流程定义中引用其 ID。

工具、skill、MCP 插件按该锁定 DSH 版本的公开配置接口写入用户 preset；宿主级服务通过部署 profile 配置。这里没有另建工具执行器、MCP 客户端、skill 加载器或凭据库，也不通过 HTTP 上传/执行任意插件代码。preset 是受信任的本地代码配置，不能交给不受信任的远程用户。若需注册服务，应遵守 DSH preset 的隔离 realm 规则。

内置三个 preset 只有 persona，不带文件、网络或 shell 工具，因此默认流程不会产生外部写入。自定义 preset 不应启动后台委派或依赖无人处理的交互审批；本期没有审批/提问桥接界面，涉及这些能力需后续接入 DSH 原生交互协议。输出中的上游内容作为数据传入，并在 persona 中明确不可当作指令。

运行快照固定的是 **preset ID**，不复制第三方插件代码或 preset 文件内容。应使用不可变版本 ID（如 `reviewer-v2`）发布 preset 变更；已挂载的 DSH standing composition 按原生生命周期复用，修改文件后需重启空闲宿主。保留旧 preset 和相关插件，以保证完整历史展示能力。

## UI 复用范围

`dsh-client-ui-conversation`、`dsh-client-ui-chat`、`dsh-client-ui-workflow-run` 依赖 DSH 浏览器侧 Cordis services、slots、Lexical 和 React 运行时，不提供可直接嵌入当前 React Native 的独立聊天组件。因此前端复用 `@aura/ui`，只渲染后端 DTO，历史分页仍用 DSH Controller。不会把 DSH 浏览器系统复制进 Aura，或把编排逻辑塞进页面。

历史视图显示用户输入、assistant 文本、工具名称/完成标记和回合状态。原始 request headers、凭据引用、provider 错误、reasoning 和插件私有 meta 不进入前端；完整工具结果仍保存在 DSH 日志，不在这一版页面中展开。没有完整 DSH 工具卡片、分支编辑器或 token 级实时输出。所有节点共用运行选择的 demo/Codex 模型路由，各自的 preset 独立。

## HTTP

| 方法 | 路径                                                | 作用                                                  |
| ---- | --------------------------------------------------- | ----------------------------------------------------- |
| GET  | `/flows/catalog`                                    | 定义版本、DSH preset 列表                             |
| POST | `/flows/definitions`                                | 校验并保存完整定义                                    |
| GET  | `/flows/runs`                                       | 最近 100 次运行摘要                                   |
| POST | `/flows/runs`                                       | `{requestId, definitionId, task, mode}`，202 返回运行 |
| GET  | `/flows/runs/:id`                                   | 运行快照、步骤、报告                                  |
| POST | `/flows/runs/:id/cancel`                            | 显式取消                                              |
| GET  | `/flows/runs/:id/steps/:stepId/history?beforeSeq=…` | 原生会话分页的安全显示投影                            |

历史只能通过某次运行确有的 stepId 访问，不接受任意 sessionId。当前 Aura runtime 仍是单用户、受信任局域网开发服务，没有多租户授权或公网保护，不应暴露到公网。

## 验证

```powershell
pnpm --filter @aura/orchestration typecheck
pnpm --filter @aura/orchestration test
pnpm run check
pnpm run build:web
```

真实 DSH 集成测试使用独立临时 DSH home 和本地模拟 provider，不读取个人登录凭据、不调用真实付费模型。覆盖不同 preset、选定来源、历史冷读和分页、取消、超时、崩溃恢复；单元测试覆盖 DAG 校验、并发、故障、幂等、快照及容量边界。
