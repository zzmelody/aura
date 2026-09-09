# @aura/runtime

Aura 的可嵌入后端组合根。`apps/server` 将它作为独立服务启动，`apps/desktop` 在 Electron 主进程内复用同一个生命周期；应用入口只负责宿主行为，不复制服务实现。

Runtime 使用 TypeScript 源码并按职责拆分：

- `index.ts`：创建和关闭依赖，不承载路由或业务细节；
- `runtime-config.ts`：解析并校验运行配置，安装 Aura 自有 DSH profile；
- `api-server.ts`：HTTP 边界、并发准入和对话路由；
- `codex-auth-routes.ts`：DSH 授权状态的脱敏 HTTP 投影；
- `dsh-session-runner.ts`：DSH SDK 子进程、JSON-RPC、事件流与取消；
- `demo-model.ts`：仅监听 loopback 的开发演示模型；
- `http-server.ts`、`validation.ts`：可复用 HTTP 生命周期和输入校验。

本包通过端口接口依赖 `@aura/dsh-auth`，并只消费发布的 DSH 包和 Aura 自有 profile；不修改 DSH/pi-ai 源码。完整边界、失败策略与演进约束见 [后端 Runtime 技术方案](../../../docs/backend-runtime.md)。

流程执行委托给 [`@aura/orchestration`](../orchestration/README.md)：本包仅创建/关闭流程宿主、在 Origin 检查后转交 `/flows/*`，并为演示模式提供本地模型端点。DAG 调度、不同 preset/session 的关联与 coordinator 汇总均不放在 runtime 或前端。
