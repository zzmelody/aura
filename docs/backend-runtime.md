# Aura 后端 Runtime 技术方案

状态：已采纳

最后更新：2026-09-14

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
                            ├─→ DSH session runner ─→ published DSH SDK runtime
                            └─→ loopback demo model
```

`@aura/dsh-auth` 表达“DSH 授权适配”这一稳定职责。Codex 是当前 provider，因此实现类型命名为 `CodexSubscriptionAuth`；新增 Claude 等 provider 时增加并列服务，不新增供应商命名的顶层包，也不把 HTTP 路由放进授权包。

## 3. Runtime 模块

| 模块                    | 单一职责                                          | 不应承担                     |
| ----------------------- | ------------------------------------------------- | ---------------------------- |
| `index.ts`              | 组合依赖、启动服务、统一关闭                      | 路由判断、协议解析、模型逻辑 |
| `runtime-config.ts`     | 解析配置，定位 DSH home 与插件配置               | 启动网络服务                 |
| `api-server.ts`         | Hono、CORS、健康检查、并发准入、对话路由          | OAuth 细节、子进程协议细节   |
| `codex-auth-routes.ts`  | 把授权端口映射为脱敏 HTTP API                     | 读取或保存 token             |
| `demo-model.ts`         | 提供开发期 OpenAI-compatible loopback 模型        | 对外提供生产模型服务         |
| `demo-chat-tools.ts`    | 演示模型按规则选择对话工作流工具，保证离线可复现  | 判断真实模型意图             |
| `tripo-routes.ts`       | 校验 Tripo 请求并投影异步任务状态                 | 保存 Key 或实现 Tripo API    |
| `http-server.ts`        | Hono Node 适配器生命周期与本地 Origin 中间件      | 业务路由                     |
| `validation.ts`         | 运行时无关的基础类型守卫                          | HTTP body 解析、领域状态变更 |

HTTP 层只依赖 `CodexAuthPort`、`ChatPort` 与 `TripoPort`，组合根再注入真实实现。Hono app 可以通过标准 Fetch `Request` 在进程内测试，不需要启动端口、OAuth、DSH 子进程或真实 Tripo 请求，供应商实现也不会反向依赖 HTTP。

## 4. 请求与授权流程

对话请求由 Hono 完成路由、body limit 与 JSON 解析，再通过共享协议校验输入；随后交给长驻的 `aura-flow` 编排宿主（`OrchestrationHost.chat`），在其中为本次请求创建短期 DSH session（preset `chat-v1`）。用户消息可带最多 4 个已上传图片的内容 ID；Codex 模式下编排宿主按 ID 读取并校验哈希后，把最近的最多 4 张作为图片内容交给模型，演示模式只传文字标记。图片经 `POST /flows/assets/images` 上传，`GET /flows/assets/images/:id` 只按内容 ID 返回已上传图片。响应使用 Hono streaming helper 输出 NDJSON，事件为 `delta`、`workflow`（含 flowId、标题、runId、参数摘要）、`error`、`done`；宿主把流式事件作为 `chat/event` JSON-RPC 通知回传，客户端断开会发送 `chat/cancel`，180 秒超时兜底。内部演示模型使用 Hono SSE helper 提供 OpenAI-compatible 流。

Codex 登录由用户交互触发。HTTP 路由只转发 DSH notice、manual prompt 和脱敏状态；OAuth grant 由 DSH credentials service 写入 `.aura/dsh/.credentials.yaml`。Runtime、前端响应和日志均不得读取或输出 access token、refresh token 或 API key。

Tripo 由独立的 `@aura/tripo` 后端包调用官方 v3 SDK，不进入 DSH 的 LLM provider
链路。Key 从忽略目录 `.aura/tripo/api-key` 或后端部署环境读取；HTTP 只返回是否配置、
task ID 与经过白名单投影的任务状态。文本/图片生成使用显式 DTO，不能把任意付费 Tripo
payload 作为通用代理透传。完整配置见 [Tripo 3D 接入](tripo.md)。

本机客户端经 `/services` 使用插件发布的服务 Flow（`service: true`）。Runtime 启动时把地址和每进程 token 写入 `<root>/.aura/service.json`；Run 按客户端自己的 `requestId` 幂等启动，准入、视图和带输入的恢复由提供该 Flow 的插件 provider 负责，响应只含状态、进度、输出和有界错误码。

## 5. 生命周期与失败策略

启动顺序固定为：解析配置 → 安装 profile → 创建授权服务与 Tripo adapter → 启动 loopback 演示模型 → 创建 DSH runner → 启动 API。任一步失败时，已创建资源必须回收。

关闭操作幂等，并同时停止 API 接入、活动 DSH 进程、演示模型和授权上下文。对话并发暂限为 2；超过限制返回 503。协议或模型错误以稳定的客户端消息结束流，完整诊断仅写入本机服务终端，且不得包含凭据。

SiteRunner 在打开预览前确认监听端口属于自己启动的进程树，不能接管同端口的外部服务。Windows 通过系统目录下的 `netstat.exe -ano -p tcp` 读取数值监听表，再用 `Get-CimInstance Win32_Process` 校验父子关系；开预览前的两次归属检查和每次10秒查询上限不变。已明确支持英文/UTF-8与简体中文/GB18030表头，未知表、无效IP/端口/PID和无法读取时拒绝。IPv4/IPv6同端口的所有监听PID都必须属于该树。端口选择仍先查监听表再实际尝试独占loopback bind，macOS/Linux查询路径不变。

2026-10-01窄诊断记录：旧TCP CIM枚举实测11,306毫秒，超过原10秒内部截止；此前双项目分别实际报端口归属无法确认，不能归结为测试等待竞争。完整netstat数值表4,293行实测116毫秒。替换后的解析2项、真实双项目与外部端口保护4项通过，测试进程自然退出；这些结果不改写过去聚合失败记录，也不代替最终全仓检查。

## 6. TypeScript 与发布约束

Runtime 以 Node.js 24 为最低运行环境，workspace 直接导出 `.ts` 源码并使用 Node 原生 type stripping；因此只使用可擦除的 TypeScript 语法，不使用依赖编译变换的 enum、namespace 或参数属性。`tsc --noEmit` 是类型门禁，仓库不使用 `.mjs` 源码，也不维护容易漂移的 JavaScript 与手写声明双份实现。

包是私有 workspace library，不是独立发布物。若未来需要 npm 发布或兼容 Node 22，应新增统一构建产物和 exports 条件，而不是恢复手写声明文件。

## 7. 验证与演进

变更至少执行 Runtime 与授权包的类型检查和单元测试，再执行根 `pnpm run check`。涉及进程、profile 或流协议时还必须执行 `pnpm run test:runtime`；涉及桌面嵌入时验证 Electron 启动与退出后的端口回收。

当前“一请求一 DSH 进程”是明确的阶段性选择。引入工具调用和长期工作流前，应将 `DshSessionPort` 替换为持久 session manager，建立 Aura session 与 DSH session 的稳定映射、恢复、背压和逐用户配额；HTTP API 与授权适配无需随之重写。
