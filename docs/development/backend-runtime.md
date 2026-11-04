# Aura 后端 Runtime 技术方案

状态：已采纳

最后更新：2026-11-02

适用范围：`packages/backend/runtime`、`packages/backend/dsh-auth`、`packages/backend/tripo`、`apps/server`、`apps/desktop`

## 1. 目标与边界

Aura Runtime 为桌面应用和独立服务提供同一套后端能力，负责 HTTP 接入、DSH 会话执行、模型授权适配、Tripo 3D 任务和资源生命周期。设计目标是保持宿主无关、凭据后置、依赖方向单一，并让每个模块可以独立测试和替换。

当前方案不解决公网多租户、长期权威会话、分布式任务调度或云端凭据托管。移动端不能内嵌 Node/DSH，只能通过受信网络连接 Runtime。

## 2. 组件关系

```text
apps/server ─────┐
                 ├─→ @aura/runtime ─→ HTTP API
apps/desktop ────┘          │            ├─→ Codex auth routes ─→ @aura/dsh-auth ─→ DSH authorization
                            │            └─→ chat routes
                            ├─→ Tripo routes ─→ @aura/tripo ─→ official Tripo v3 SDK
                            ├─→ @aura/orchestration ─→ 长驻 DSH SDK profile
                            ├─→ @aura/plugin-manager ─→ 插件校验与动态激活
                            └─→ loopback demo model
```

`@aura/dsh-auth` 表达“DSH 授权适配”这一稳定职责。Codex 是当前 provider，因此实现类型命名为 `CodexSubscriptionAuth`；新增 Claude 等 provider 时增加并列服务，不新增供应商命名的顶层包，也不把 HTTP 路由放进授权包。

## 3. Runtime 模块

| 模块                                       | 单一职责                                         | 不应承担                     |
| ------------------------------------------ | ------------------------------------------------ | ---------------------------- |
| `index.ts`                                 | 组合依赖、启动服务、统一关闭                     | 路由判断、协议解析、模型逻辑 |
| `runtime-config.ts`                        | 解析配置，定位 DSH home 与插件配置               | 启动网络服务                 |
| `api-server.ts`                            | Hono、CORS、健康检查、并发准入、对话路由         | OAuth 细节、子进程协议细节   |
| `codex-auth-routes.ts`                     | 把授权端口映射为脱敏 HTTP API                    | 读取或保存 token             |
| `demo-model.ts`                            | 提供开发期 OpenAI-compatible loopback 模型       | 对外提供生产模型服务         |
| `demo-chat-tools.ts`                       | 演示模型按规则选择对话工作流工具，保证离线可复现 | 判断真实模型意图             |
| `tripo-routes.ts`                          | 校验 Tripo 请求并投影异步任务状态                | 保存 Key 或实现 Tripo API    |
| `ai-services.ts` / `ai-services-routes.ts` | 模型服务配置与脱敏 HTTP 投影                     | Flow 执行与媒体制作          |
| `plugin-settings-routes.ts`                | 本机插件配置的 HTTP 边界                         | 发现、激活与回滚实现         |
| `service-routes.ts`                        | 服务 Flow 的准入与状态投影                       | 领域策略                     |
| `site-*.ts`                                | 本机项目配置、端口归属、进程和生命周期           | Electron IPC 与窗口          |
| `http-server.ts`                           | Hono Node 适配器生命周期与本地 Origin 中间件     | 业务路由                     |
| `validation.ts`                            | 运行时无关的基础类型守卫                         | HTTP body 解析、领域状态变更 |

HTTP 层只依赖 `CodexAuthPort`、`ChatPort` 与 `TripoPort`，组合根再注入真实实现。Hono app 可以通过标准 Fetch `Request` 在进程内测试，不需要启动端口、OAuth、DSH 子进程或真实 Tripo 请求，供应商实现也不会反向依赖 HTTP。

## 4. 请求与授权流程

会话历史的分页读取有独立的启动路径：执行宿主未就绪时，编排包在当前服务进程组合发布版 DSH 的只读 JSONL 持久化服务，用域 schema 校验临时索引快照的权限，读取已结束回合；无需等待 loader 或 Flow 恢复。索引的兼容引导只在可丢弃的副本中进行，真实 `.aura/` 索引和日志保持原样。未结束回合及不可用快照继续交给原宿主确认；宿主就绪后始终走实时读取。分页游标沿用原日志序号，可与两条路径互接，HTTP 取消向下传递。该只读组合不包含 Agent、模型 provider 或执行恢复能力。

对话请求由 Hono 完成路由、body limit 与 JSON 解析，再通过共享协议校验输入；随后交给长驻的 `aura-flow` 编排宿主（`OrchestrationHost.chat`），在其中复用持久化 DSH session（preset `coder-v1`）；旧 `/chat/*` 请求仅做协议转换。用户消息可带最多 4 个已上传图片的内容 ID；Codex 模式下编排宿主按 ID 读取并校验哈希后，把最近的最多 4 张作为图片内容交给模型，演示模式只传文字标记。图片经 `POST /flows/assets/images` 上传，`GET /flows/assets/images/:id` 只按内容 ID 返回已上传图片。响应使用 Hono streaming helper 输出 NDJSON，事件为 `delta`、`workflow`（含 flowId、标题、runId、参数摘要）、`error`、`done`；宿主把流式事件作为 `chat/event` JSON-RPC 通知回传，客户端断开会发送 `chat/cancel`，180 秒超时兜底。内部演示模型使用 Hono SSE helper 提供 OpenAI-compatible 流。

Codex 登录由用户交互触发。HTTP 路由只转发 DSH notice、manual prompt 和脱敏状态；OAuth grant 由 DSH credentials service 写入 `.aura/dsh/.credentials.yaml`。Runtime、前端响应和日志均不得读取或输出 access token、refresh token 或 API key。

Tripo 由独立的 `@aura/tripo` 后端包调用官方 v3 SDK，不进入 DSH 的 LLM provider
链路。Key 从忽略目录 `.aura/tripo/api-key` 或后端部署环境读取；HTTP 只返回是否配置、
task ID 与经过白名单投影的任务状态。文本/图片生成使用显式 DTO，不能把任意付费 Tripo
payload 作为通用代理透传。完整配置见 [Tripo 3D 接入](../features/tripo.md)。

本机客户端经 `/services` 使用插件发布的服务 Flow（`service: true`）。Runtime 启动时把地址和每进程 token 写入 `<root>/.aura/service.json`；Run 按客户端自己的 `requestId` 幂等启动，准入、视图和带输入的恢复由提供该 Flow 的插件 provider 负责，响应只含状态、进度、输出和有界错误码。

## 5. 生命周期与失败策略

启动顺序为：解析配置与网络设置 → 校验插件配置 → 创建授权服务与 Tripo adapter → 启动 loopback 演示模型 → 创建编排宿主并绑定插件激活器 → 启动 API。编排宿主在独立子进程中调用 DSH 公开的 `runProfile()` 预热常驻的 `aura-flow`，通过 stdio RPC 等待握手。

`GET /health` 是就绪检查：只有 DSH 完成 Aura `initialize` 握手，并且当前 JSON-RPC `ping` 在 500ms 内成功，才返回 HTTP 200 和 `status: "ready"`。启动中返回 `starting`，启动失败、进程退出或 RPC 无响应返回 `unavailable`，关闭中返回 `stopped`，这些状态均为 HTTP 503；响应包含 `dsh.status`，使用 `Cache-Control: no-store`，不包含本机路径、错误栈或凭据。健康探测不触发 DSH 启动，也不等待最长 120 秒的冷启动。

桌面和 Web 启动器通过响应中的 `service: "aura-runtime"` 识别已经监听的 Aura API，即使其就绪状态为 503，也不会再抢占端口。自有 runtime 的 `ready()` 和独立服务的 `AURA_READY` 标记都必须等 DSH 握手成功；Web 启动器为冷启动预留 130 秒，遇到明确失败立即停止启动。

DSH 的 Cordis 日志 exporter 会提取插件导入/激活错误及有界 cause 链，将错误类型、受支持的原因、错误码、源文件行号和缺失服务写到终端及 `<root>/.aura/dsh/logs/aura-host.log`。日志文件以 0600 创建，达到 1MiB 后轮换到 `aura-host.log.1`。原始 stderr、源代码片段、环境变量和 provider payload 不会转发或落盘；HTTP 只返回就绪状态。Aura 插件明确导入失败或等待缺失服务时，启动握手会提前终止，避免只留下一个存活但不处理 RPC 的 DSH 进程。

关闭操作幂等：先停止编排宿主中的活动会话，再关闭 API、演示模型和授权上下文。对话并发暂限为 2；超过限制返回 503。协议或模型错误以稳定的客户端消息结束流，完整诊断仅写入本机服务终端，且不得包含凭据。

SiteRunner 在打开预览前确认监听端口属于自己启动的进程树，不能接管同端口的外部服务。Windows 通过系统目录下的 `netstat.exe -ano -p tcp` 读取数值监听表，再用 `Get-CimInstance Win32_Process` 校验父子关系；开预览前的两次归属检查和每次10秒查询上限不变。已明确支持英文/UTF-8与简体中文/GB18030表头，未知表、无效IP/端口/PID和无法读取时拒绝。IPv4/IPv6同端口的所有监听PID都必须属于该树。端口选择仍先查监听表再实际尝试独占loopback bind，macOS/Linux查询路径不变。

## 6. TypeScript 与发布约束

Runtime 以 Node.js 24 为最低运行环境，workspace 直接导出 `.ts` 源码并使用 Node 原生 type stripping；因此只使用可擦除的 TypeScript 语法，不使用依赖编译变换的 enum、namespace 或参数属性。`tsc --noEmit` 是类型门禁，仓库不使用 `.mjs` 源码，也不维护容易漂移的 JavaScript 与手写声明双份实现。

包是私有 workspace library，不是独立发布物。若未来需要 npm 发布或兼容 Node 22，应新增统一构建产物和 exports 条件，而不是恢复手写声明文件。

## 7. 验证与演进

变更至少执行 Runtime 与授权包的类型检查和单元测试，再执行根 `pnpm run check`。涉及进程、profile 或流协议时还必须执行 `pnpm run test:runtime`；涉及桌面嵌入时验证 Electron 启动与退出后的端口回收。

当前对话复用编排宿主的 DSH 进程，每次请求创建短期 session；Flow 的步骤 session 与 durable Run 则保持稳定映射与恢复记录。后续公网部署仍需要用户身份、配额和服务端权威对话历史。模块职责与全部包边界见 [模块边界](module-boundaries.md)，本轮结果见 [当前验证](../verification.md)。

### 统一对话与控制边界

首页和项目对话均通过 `/coding/turn` 使用同一驱动；未传 `projectId` 时由后端选择运行时预建的默认工作空间（默认 `<用户主目录>/Documents/Aura`，可由 `defaultWorkspace` 选项或 `AURA_DEFAULT_WORKSPACE` 覆盖；不放在 Aura 根目录下，清理临时文件不会影响对话）。运行时临时目录默认 `<root>/local/runtime`，可由 `tempDir` 选项或 `AURA_TEMP_DIR` 覆盖，插件后端经 `host.tempDir` 取得私有子目录。自然语言不经过额外意图分类；当前请求和上下文由同一 Agent 处理。停止、引导、回答、显式工作流启动和目录选择仍走明确的控制接口，宿主负责输入校验、目录和权限边界。

会话索引在原 `aura_coding_conversations` v1 记录上增加可选模型配置、导入历史和来源 ID，已有记录无需重写。旧历史仅在无 DSH 日志时进入首轮上下文，后端重放会隐藏上下文封装、保留用户原请求；导入不伪造工具调用。跨项目 `branchFrom` 校验来源后以 DSH seed fork，继承已完成上下文，自己的时间线只显示分叉后的轮次。`forkFrom` 继续专用于受父记录约束的旁支，两者不能同时传入。模型选择在后端保存、每轮固定，Flow 的模型配置独立。

编排根据索引中的旁支身份挂载 DSH 系统提示段。继承的主对话内容用于理解背景，当前任务以旁支用户消息为准。首次创建旁支会话时，编排通过 DSH 在旁支关闭继承的计划模式。恢复已有会话时使用该会话已保存的状态。

`POST /coding/sessions/:id/permission` 接受 `{ permission }`，可选 `read-only`、`workspace-write`、`danger-full-access`。草稿通过首轮 `POST /coding/turn` 携带选择。索引保存可选权限字段，未单独选择的旁支读取主对话的值，新分叉在首轮保存来源的选择。编排使用 DSH 的 `permissionPresets` 写入会话事件，活跃会话及其继承权限的旁支在下一次受限调用时使用新预设。没有会话选择时沿用 DSH 会话权限。新会话的部署默认值为 `workspace-write`，可由 `DSH_PERMISSION_MODE` 覆盖。

`GET /coding/sessions/:id/collaboration` 读取 DSH 的计划和目标状态，`POST` 切换已有会话的 Plan 或清除目标。首轮模式、目标启动及继续通过 `POST /coding/turn` 的可选 `intent` 提交。目标续跑使用 DSH 的同会话驱动，多个轮次共用 Aura 的流、问答、停止与请求账本。计划状态和目标进度存入 DSH 会话日志，已保存的目标需要用户明确继续才会在新连接上重新启动。

侧栏同步恢复按服务地址缓存的工作空间和对话目录，后台用只读元数据列表校验，不等待 DSH 冷启动或历史状态扫描才展示已有标题。缓存仅含目录字段，实际会话历史和运行状态仍由后端读取；首次没有快照时显示加载中，失败提供重试，后端确认空列表后才显示为空。移除工作空间同步清理其客户端目录缓存。默认空间以当前运行时的 `isDefault` 标记为准；默认目录变化后留下的旧注册只由用户明确移除，不在启动或升级时自动删除、迁移用户数据。

发送或引导附带图片时，若 DSH 在接收消息前拒绝不支持图片的模型，编码驱动转换为安全的 422 错误，界面明确提示更换视觉模型或移除附件后自行发送；不再显示通用服务或登录错误。该拒绝不启动模型回合，也不触发自动重试或模型切换。
