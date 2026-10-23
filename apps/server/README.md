# @aura/server

Aura 的独立服务端应用输出。入口只负责启动 `@aura/runtime`；后者组合 HTTP API、DSH 进程和 profile，并通过 `@aura/dsh-auth` 注入授权能力。因此 Electron 桌面端也能通过正式 workspace 依赖复用同一后端，而不依赖另一个应用或私有文件路径。应用不复制或修改 DSH 源码，也不直接调用 pi-ai。

在仓库根执行 `.\scripts\aura.ps1 run runtime`，服务默认只监听 `127.0.0.1:4311`。服务运行后执行 `.\scripts\aura.ps1 run test:runtime`，验证真实 DSH 进程的两轮流式演示。

`pnpm run build:server` 从 `src/launch.ts` 生成 `dist/launch.js`。分发启动器用 `node apps/server/dist/launch.js --root=<Aura 数据目录>` 启动，固定 loopback 并默认选择空闲端口。启动器先注册 tsx，使安装在 `node_modules` 中的 TypeScript 及其 DSH 子进程可执行；构建产物不提交到 Git。

构建同时将根 `plugins/` 内的产品插件按其发布资产清单放入 `dist/plugins/`（保留类别子目录），随服务端包发布。分发启动器从安装目录加载这些默认插件，`--root` 仍只指定用户数据目录；开发启动默认使用数据根的 `plugins/`。插件启停与外部插件清单继续由 `.aura/plugins.json` 覆盖，详见 [插件目录](../../plugins/README.md)。

设置了 `service: true` 的 Flow 会出现在 `GET /flows/services`，其他应用可通过 `POST /flows/:flowId/invoke` 创建运行，再读取 `GET /flows/runs/:runId` 获取状态和结果。若可信局域网中的另一台设备需要访问，可在启动前设置 `$env:HOST="0.0.0.0"`；`PORT` 可覆盖默认端口。该监听方式不提供生产鉴权，不应直接暴露到公网。完整协议见 [编排包 API](../../packages/backend/orchestration/README.md#将-flow-发布为-http-服务)。

`/auth/codex/*` 只投影 DSH authorization 的脱敏状态；凭据由 DSH 保存在忽略目录 `.aura/dsh/`。`/chat/codex` 使用同一个 DSH 启动函数，不能静默回退到模拟模型。服务没有生产鉴权，只能用于本机或可信局域网；正式部署还需要用户认证、稳定会话映射和限流。详见 [模型接入说明](../../docs/features/model-providers.md)。

Tripo 3D 通过 `/tripo/*` 提交异步任务并查询状态。Key 放在
`.aura/tripo/api-key` 或后端环境变量 `TRIPO_API_KEY`；国内站账号需设置
`AURA_TRIPO_REGION=china`。详见 [Tripo 3D 接入](../../docs/features/tripo.md)。
