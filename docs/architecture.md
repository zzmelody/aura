# Aura 架构

Aura 使用自己的代码、命名空间和发布流程，以固定版本的官方 DSH 包作为后端 agent harness。项目不会复制 DSH 仓库，不修改依赖源文件，也不会绕过 DSH 直接调用 pi-ai。

## 运行链路

离线模式只在客户端调用 `@aura/demo`。服务端演示和 Codex 模式都经过 Aura runtime 与 DSH：

```text
离线：客户端 → @aura/demo
演示：客户端 → Aura runtime → DSH SDK profile → 本地模拟模型
Codex：客户端 → Aura runtime → DSH SDK profile → dsh-llm-pi-ai → openai-codex
登录：客户端 → Aura runtime → DSH authorization → dsh-llm-pi-ai OAuth flow
```

`@aura/dsh-codex` 在 Aura 后端组合 DSH 的 `dsh-credentials-local`、`dsh-authorization`、`dsh-llm` 和 `dsh-llm-pi-ai` 服务。它只把 DSH 授权 flow 的 notice、设备码和最终状态投影到客户端；OAuth grant 由 DSH 写入 `.aura/dsh/.credentials.yaml`，不会进入 HTTP 响应、前端存储或日志。

对话由 Aura 自有的 `aura-sdk` profile 启动。该 profile 叠加官方 `dsh-base` 与 `dsh-sdk-app` bundle，配置 `openai-codex` provider，并通过官方 SDK JSON-RPC 读取 session events。可复用的 HTTP/DSH 实现与 profile 位于 `packages/backend/runtime`；`apps/server` 只是独立服务入口，`apps/desktop` 通过正式 workspace 依赖嵌入同一实现。运行时把 profile 复制到已忽略的 DSH home，DSH 依赖本身保持只读。

## Monorepo

pnpm workspace 收录应用输出和三层可复用库：

| 位置 | 放置内容 | 允许依赖 |
| --- | --- | --- |
| `apps/*` | mobile、desktop、server 可运行入口与发布配置 | 按平台使用下列 libraries |
| `packages/frontend/*` | 可复用页面、组件、交互状态、设备适配 | frontend、shared |
| `packages/backend/*` | HTTP 服务、凭据、DSH、进程、文件和网络能力 | backend library、shared |
| `packages/shared/*` | 与运行环境无关的类型、校验、存储格式和纯流程 | shared |

应用声明 `aura.kind: app` 与 `aura.platform`；packages 只允许 library，并声明 `aura.layer`。移动应用只能依赖 frontend/shared，服务应用只能依赖 backend/shared，桌面应用可以组合 frontend/backend/shared。`check:workspaces` 校验目录元数据、依赖方向、`workspace:*`、显式导出、未声明依赖、私有子路径、跨 workspace 相对导入、应用被依赖和依赖环。完整约束位于根 [AGENTS.md](../AGENTS.md)。

移动、桌面和服务入口分别位于 `apps/mobile`、`apps/desktop` 与 `apps/server`。客户端导航和 React 状态属于 `packages/frontend/workbench`，基础组件属于 `packages/frontend/ui`，DSH 授权适配属于 `packages/backend/codex`，协议、存储与规则演示属于 shared。新增小程序时创建独立的 `apps/miniprogram`，复用 frontend/shared 库，不在 packages 中伪装成应用。

Web 开发与静态预览命令通过 `scripts/run-with-runtime.mjs` 同时启动前端和 Aura runtime，解决页面存在但 4311 服务缺失的问题。Electron 主进程也会先检查并启动 runtime，再显示 renderer；所有由入口启动的子进程在入口退出时回收。移动原生应用不能内嵌 Node/DSH，真机通过设置中的局域网地址连接电脑端 runtime。

## 当前取舍

每个联网对话请求暂时启动一个 DSH SDK 进程，客户端历史作为带标记的完整输入交给 DSH，响应结束或连接断开后回收进程。这保留了 DSH agent loop、provider、事件与取消链路，但还不是长期运行的服务端权威会话。开始开发带工具的正式工作流前，应改为稳定的 Aura session 到 DSH session 映射和恢复协议。

Codex 默认模型是 `gpt-5.6-terra`，推理档位为 medium，输出上限为 4096，传输为 SSE。部署可以通过 `AURA_CODEX_MODEL` 选择同一锁定 DSH/pi-ai 目录中存在的其他模型；未知模型在 DSH 初始化时直接失败，不回退到演示。

客户端继续使用 `aura.workspace.v1` 本地存储。增加 `codex` provider 不改变现有会话格式；恢复时会保留已选择的模式，并把中断中的回复标为已停止。

服务只有开发期同源/同主机 Origin 限制，没有用户认证、多租户隔离或公网防护。手机不保存个人订阅 token，只调用运行在电脑上的 Aura 服务。Bedrock、图片生成、云同步和生产账号系统仍未接入。
