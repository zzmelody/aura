# Agent 会话、工作区与 Flow 编排拆分方案

状态为已实施。包职责见 [模块边界](../development/module-boundaries.md)。

拆分前，`@aura/orchestration` 同时承载 Flow 引擎、对话 Agent、工作区和终端。拆分后，每项能力的状态、规则、持久化和测试归同一个包。`@aura/runtime` 负责 HTTP、进程生命周期和服务装配。各能力继续共用一个 DSH 宿主进程。

## 包职责

| 包                    | 负责的能力                                                                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `@aura/agent-runtime` | 主会话、侧边会话、显式分叉、会话索引和历史读写。管理 Agent 的轮次、系统提示、工具权限、提问审批、计划模式、子 Agent 和会话自动化。           |
| `@aura/workspace`     | 默认工作区、目录注册和校验、工作区状态及 PTY 生命周期。工作区移除或换目录时，由本包清理原工作区的终端。                                      |
| `@aura/orchestration` | Action 与 Flow 执行、步骤依赖和并行、运行记录、checkpoint、恢复、幂等及运行产物。Flow 步骤使用模型时，本包负责将 Flow 步骤和结果映射到 DSH。 |
| `@aura/runtime`       | Hono 路由、流式传输、DSH 进程与 RPC 生命周期。装配各包服务，把 HTTP 与内部 RPC 请求交给对应的能力所有者。                                    |

会话索引中的项目归属、侧边关系和历史投影一起迁入 `agent-runtime`。侧边首轮继续通过 DSH fork 获取主会话背景，系统提示以侧边用户消息确定任务。首次 fork 的计划模式初始化和重启恢复也由同一包负责。工作区则沿用 DSH 的工作区注册表和子进程服务。[会话驱动](../../packages/backend/agent-runtime/src/conversations/session.ts) · [工作区注册](../../packages/backend/workspace/src/projects.ts) · [终端](../../packages/backend/workspace/src/terminals.ts)

## 跨包调用

- **Agent 使用工作区。** Agent 按现有 `projectId` 解析默认工作区或用户已登记的目录，并把目录绑定到 DSH 会话。工作区服务提供目录解析和绑定校验，使用 DSH 验证会话的 `cwd` 与注册目录一致。按工作区列出会话时，工作区校验由 `workspace` 提供，查询和投影由 `agent-runtime` 完成。
- **Agent 调用 Flow。** Flow 工具的目录、启动准入、幂等和状态查询由 `orchestration` 负责。宿主按现有 `ChatToolHost` 的职责接好工具，Agent 在自己的会话作用域内挂载工具并转发运行事件。Flow 继续按自己的运行生命周期执行。[现有工具接口](../../packages/backend/orchestration/src/chat-tools.ts)
- **宿主组合能力。** `runtime` 依赖三个能力包，经公开入口装配目录解析、工具和事件通知。各能力包通过注入的接口消费外部能力。HTTP 和 RPC 适配层只处理传输相关的解析、取消、事件和错误转换。模块间使用显式导出，跨包 DTO 沿用 `@aura/protocol`。

## 迁移顺序

1. **建立基线。** 并行改动合入后，按功能重新盘点 `coding/`、DSH 宿主和 `/coding` 路由，先跑侧边会话、工作区、终端和 Flow 集成测试。新合入的会话能力连同状态、入口和测试一起迁移。
2. **迁工作区与终端。** 从 `CodingProjects` 分离会话索引查询，把目录注册、默认工作区、DSH 目录绑定和终端操作整体迁到 `workspace`。把移除或换目录后的终端清理收进工作区服务。以现有接口验证工作区和终端操作。
3. **迁 Agent 会话。** 把轮次执行、会话索引、冷读历史、权限、旁支、协作模式和相应的服务入口整体迁到 `agent-runtime`。配套迁移 Agent preset 和包内测试。由宿主注入工作区和 Flow 工具接口，移除迁移后冗余的内部入口。
4. **收拢宿主装配。** 把跨能力的 DSH profile 启动、RPC 分发和进程生命周期收进 `runtime`。Flow 引擎通过公开入口接入，装配层负责连接服务。同步更新 workspace 依赖、锁文件、模块职责文档及受影响的分发路径。

## 兼容与验收

- 沿用现有 HTTP 与 RPC 契约、会话和工作区 ID、DSH profile、domain 名称、日志和存储格式。用旧记录验证主会话、侧边会话和历史恢复。用户操作继续走原有校验与 revision 写入路径。
- 用合成模型核对侧边首轮与重启后的请求、显式分叉、计划模式和权限继承。验证终端启动、读写、关闭及工作区变更后的清理。
- 验证对话启动的 Flow 能查询同一个 Run，Flow 的暂停、恢复和幂等行为沿用现有契约。检查桌面与服务端能从打包路径启动同一个 DSH 宿主。
- 先跑 `pnpm run check:workspaces` 和受影响包的类型检查与测试，再跑 `pnpm run check`。以实际结果记录验收状态。
