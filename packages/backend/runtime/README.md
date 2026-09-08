# @aura/server

Aura 的 Node HTTP 后端应用。离线演示之外的对话都通过官方 `dsh --profile aura-sdk` 启动 DSH agent loop；Codex 模式再由 profile 中的 `dsh-llm-pi-ai` provider 消费订阅。应用不复制或修改 DSH 源码，也不直接调用 pi-ai。

在仓库根执行 `.\scripts\aura.ps1 run runtime`，服务默认只监听 `127.0.0.1:4311`。`pnpm --filter @aura/server test` 验证 HTTP 请求处理；服务运行后执行 `.\scripts\aura.ps1 run test:runtime`，验证真实 DSH 进程的两轮流式演示。

`/auth/codex/*` 只投影 DSH authorization 的脱敏状态；凭据由 DSH 保存在忽略目录 `.aura/dsh/`。`/chat/codex` 使用同一个 DSH 启动函数，不能静默回退到模拟模型。服务没有生产鉴权，只能用于本机或可信局域网；正式部署还需要用户认证、稳定会话映射和限流。详见 [模型接入说明](../../../docs/model-providers.md)。
