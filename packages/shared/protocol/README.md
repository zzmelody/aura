# @aura/protocol

Aura 客户端与后端的公共协议。`@aura/protocol/types` 导出 ChatMessage、ChatRequest、ChatEvent、CodexLoginRequest 与 CodexAuthStatus；`@aura/protocol` 导出 HTTP 历史校验。没有运行依赖。授权状态只包含登录阶段、模型名、验证地址和设备码，不允许携带 access token、refresh token 或 API Key。

服务端接收 1–200 条 user/assistant 文本消息，历史单条最多 12,000 字符；最后一条必须是非空 user 文本且最多 4,000 字符。响应为逐行 JSON，包含 delta、error 或 done。Node HTTP 请求体大小限制归 server，不属于跨平台协议包。

`pnpm --filter @aura/protocol typecheck` 检查类型与 JS/JSDoc；`pnpm --filter @aura/protocol test` 验证拒绝非法请求。
