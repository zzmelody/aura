# @aura/protocol

`FlowRun` 与 `FlowRunSummary` 的可选 `conversationId` 标记发起运行的持久化对话，供工作台保留原对话内的运行卡片并避免重复导入。旧记录不需要此字段，继续沿用原版本和 ID。

`PersonalAssistantInfo` 仅包含 Aura 固定主会话的 `CodingConversationInfo` 与所属 `CodingProjectInfo`。`@aura/protocol/conversations` 导出 `PERSONAL_ASSISTANT_SESSION_ID`，供前后端一致识别并从普通任务列表中排除；复用已有记录格式，不增加存储版本或迁移。

`CodingHistoryPage` 描述完整回合组成的历史窗口，携带 `hasMore`、`beforeSeq` 与 `throughSeq`，游标用于固定日志截面的向前读取；不改变持久化记录格式。

`CodingActivity` 的 `steer` 事件以 `requestId` 关联同一条追加消息。可选 `delivery: "queued"` 表示已进入 DSH inbox，`"canceled"` 表示被 DSH 明确取消；省略该字段才表示已进入模型上下文。实时流和历史使用同一形状，兼容旧版没有 delivery 字段的已读取事件。

Aura 客户端与后端的公共协议。`@aura/protocol/types` 导出 ChatMessage、ChatRequest、ChatEvent、CodexLoginRequest 与 CodexAuthStatus；`@aura/protocol` 导出 HTTP 历史校验。没有运行依赖。授权状态只包含登录阶段、模型名、验证地址和设备码，不允许携带 access token、refresh token 或 API Key。

服务端接收 1–200 条 user/assistant 文本消息，历史单条最多 12,000 字符；最后一条必须是非空 user 文本且最多 4,000 字符。响应为逐行 JSON，包含 delta、error 或 done。Node HTTP 请求体大小限制归 server，不属于跨平台协议包。

`CodingSkillInfo` 是对话快捷菜单的用户可调用技能摘要，仅包含 `name` 与 `description`；技能路径、正文、provider 和调用策略留在 DSH 后端。

`WorkspaceTerminalInfo` / `WorkspaceTerminalOutput` 描述工作区终端身份、shell 标题、工作目录、活动 / 退出状态以及有界输出分页游标。终端模型不包含凭据、启动环境或 Agent 对象；终端进程不会随对话轮次创建或重放。

`CodingConversationInfo.sideConversations` 列出同一主会话的多个独立旁支，`CodingSideConversationInfo` 只包含 ID、标题、创建时间和模型选择。`@aura/protocol/conversations` 的 `conversationSides()` 兼容旧 `sideSessionId` / `sideModelConfig` 元数据，只投影、不迁移或改写记录；显式空列表优先于旧字段。

`pnpm --filter @aura/protocol typecheck` 检查类型与 JS/JSDoc；`pnpm --filter @aura/protocol test` 验证拒绝非法请求。

`@aura/protocol/conversation-channel` 导出版本 1 的会话命令、回执、执行、快照、事件及游标类型。`CodingHistoryTurn.turnId` 可选字段由 DSH 原生回合日志位置派生，前端以它合并实时状态和历史。传输游标与历史分页游标独立，所有 DTO 不携带 provider/OAuth 凭据。
