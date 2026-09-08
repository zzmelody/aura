# @aura/demo

供移动端离线模式与服务端模拟模型共同使用的规则回复，公开入口为 `@aura/demo`。依赖 `@aura/protocol` 的类型，不发网络请求、不读取凭据，也不代表真实 AI 能力。

`streamDemo` 支持 AbortSignal 和可配置的分块间隔。`pnpm --filter @aura/demo typecheck` 检查 JS/JSDoc；`pnpm --filter @aura/demo test` 验证多轮上下文、流式拼接与取消。
