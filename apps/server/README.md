# @aura/server

Aura 的独立服务端应用输出。入口只负责启动 `@aura/runtime`；后者组合 HTTP API、DSH 进程和 profile，并通过 `@aura/dsh-auth` 注入授权能力。因此 Electron 桌面端也能通过正式 workspace 依赖复用同一后端，而不依赖另一个应用或私有文件路径。应用不复制或修改 DSH 源码，也不直接调用 pi-ai。

在仓库根执行 `.\scripts\aura.ps1 run runtime`，服务默认只监听 `127.0.0.1:4311`。服务运行后执行 `.\scripts\aura.ps1 run test:runtime`，验证真实 DSH 进程的两轮流式演示。

`/auth/codex/*` 只投影 DSH authorization 的脱敏状态；凭据由 DSH 保存在忽略目录 `.aura/dsh/`。`/chat/codex` 使用同一个 DSH 启动函数，不能静默回退到模拟模型。服务没有生产鉴权，只能用于本机或可信局域网；正式部署还需要用户认证、稳定会话映射和限流。详见 [模型接入说明](../../docs/model-providers.md)。

Tripo 3D 通过 `/tripo/*` 提交异步任务并查询状态。Key 放在
`.aura/tripo/api-key` 或后端环境变量 `TRIPO_API_KEY`；国内站账号需设置
`AURA_TRIPO_REGION=china`。详见 [Tripo 3D 接入](../../docs/tripo.md)。
