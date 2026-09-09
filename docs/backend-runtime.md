# Aura 后端 Runtime 技术方案

状态：已采纳

最后更新：2026-09-09

适用范围：`packages/backend/runtime`、`packages/backend/dsh-auth`、`apps/server`、`apps/desktop`

## 1. 目标与边界

Aura Runtime 为桌面应用和独立服务提供同一套后端能力，负责 HTTP 接入、DSH 会话执行、模型授权适配和资源生命周期。设计目标是保持宿主无关、凭据后置、依赖方向单一，并让每个模块可以独立测试和替换。

当前方案不解决公网多租户、长期权威会话、分布式任务调度或云端凭据托管。移动端不能内嵌 Node/DSH，只能通过受信网络连接 Runtime。

## 2. 组件关系

```text
apps/server ─────┐
                 ├─→ @aura/runtime ─→ HTTP API
apps/desktop ────┘          │            ├─→ Codex auth routes ─→ @aura/dsh-auth ─→ DSH authorization
                            │            └─→ chat routes
                            ├─→ DSH session runner ─→ published DSH SDK runtime
                            └─→ loopback demo model
```

`@aura/dsh-auth` 表达“DSH 授权适配”这一稳定职责。Codex 是当前 provider，因此实现类型命名为 `CodexSubscriptionAuth`；新增 Claude 等 provider 时增加并列服务，不新增供应商命名的顶层包，也不把 HTTP 路由放进授权包。

## 3. Runtime 模块

| 模块                    | 单一职责                                          | 不应承担                     |
| ----------------------- | ------------------------------------------------- | ---------------------------- |
| `index.ts`              | 组合依赖、启动服务、统一关闭                      | 路由判断、协议解析、模型逻辑 |
| `runtime-config.ts`     | 解析 host/port/root/model，定位 DSH，安装 profile | 启动网络服务                 |
| `api-server.ts`         | CORS、健康检查、并发准入、对话路由                | OAuth 细节、子进程协议细节   |
| `codex-auth-routes.ts`  | 把授权端口映射为脱敏 HTTP API                     | 读取或保存 token             |
| `dsh-session-runner.ts` | 启动 DSH、JSON-RPC 握手、转发事件、取消和回收     | HTTP 输入校验、凭据管理      |
| `demo-model.ts`         | 提供开发期 OpenAI-compatible loopback 模型        | 对外提供生产模型服务         |
| `http-server.ts`        | Server listen/close、Origin 和 JSON 响应          | 业务路由                     |
| `validation.ts`         | 有界 JSON body 读取和基础类型守卫                 | 领域状态变更                 |

HTTP 层只依赖 `CodexAuthPort` 与 `DshSessionPort`，组合根再注入真实实现。这样路由测试不需要启动 OAuth 或 DSH 子进程，供应商实现也不会反向依赖 HTTP。

## 4. 请求与授权流程

对话请求通过共享协议完成输入校验，随后由 DSH runner 为本次请求创建隔离进程，执行 `initialize → session/prompt → session.event → shutdown`。响应采用 NDJSON 增量输出；客户端断开、60 秒超时或 Runtime 关闭都会终止子进程。

Codex 登录由用户交互触发。HTTP 路由只转发 DSH notice、manual prompt 和脱敏状态；OAuth grant 由 DSH credentials service 写入 `.aura/dsh/.credentials.yaml`。Runtime、前端响应和日志均不得读取或输出 access token、refresh token 或 API key。

## 5. 生命周期与失败策略

启动顺序固定为：解析配置 → 安装 profile → 创建授权服务 → 启动 loopback 演示模型 → 创建 DSH runner → 启动 API。任一步失败时，已创建资源必须回收。

关闭操作幂等，并同时停止 API 接入、活动 DSH 进程、演示模型和授权上下文。对话并发暂限为 2；超过限制返回 503。协议或模型错误以稳定的客户端消息结束流，完整诊断仅写入本机服务终端，且不得包含凭据。

## 6. TypeScript 与发布约束

Runtime 以 Node.js 24 为最低运行环境，workspace 直接导出 `.ts` 源码并使用 Node 原生 type stripping；因此只使用可擦除的 TypeScript 语法，不使用依赖编译变换的 enum、namespace 或参数属性。`tsc --noEmit` 是类型门禁，不再维护容易漂移的 `.mjs + .d.ts` 双份实现。

包是私有 workspace library，不是独立发布物。若未来需要 npm 发布或兼容 Node 22，应新增统一构建产物和 exports 条件，而不是恢复手写声明文件。

## 7. 验证与演进

变更至少执行 Runtime 与授权包的类型检查和单元测试，再执行根 `pnpm run check`。涉及进程、profile 或流协议时还必须执行 `pnpm run test:runtime`；涉及桌面嵌入时验证 Electron 启动与退出后的端口回收。

当前“一请求一 DSH 进程”是明确的阶段性选择。引入工具调用和长期工作流前，应将 `DshSessionPort` 替换为持久 session manager，建立 Aura session 与 DSH session 的稳定映射、恢复、背压和逐用户配额；HTTP API 与授权适配无需随之重写。
