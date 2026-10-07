# @aura/core

客户端共用的会话类型、存储 v1 恢复与服务地址校验。运行函数从 `@aura/core` 导入，类型从 `@aura/core/types` 导入。依赖 `@aura/protocol`，不依赖 React、浏览器 DOM、Capacitor、Electron、Node 或 DSH。

`workspace.ts` 负责默认状态和 provider 模式，`storage.ts` 负责数据恢复，`endpoint.ts` 负责服务 origin 校验；`state.ts` 保留原公共导出。移动模块不改变 `aura.workspace.v1` 存储键、60 个会话与每会话 200 条消息限制。`pnpm --filter @aura/core typecheck` 检查 TypeScript；`pnpm --filter @aura/core test` 验证恢复和地址校验。
