# @aura/protocol

定义诊断的参数限于公开 ID、工具列表、源码行号、已知操作及有界数值，`readErrorDetails` 投影时丢弃其他字段。`FlowCatalogEntry.errorDetails` 仅用于显示目录，不进入模型执行目录。`plugin_failure` 携带插件自有的字面译文（英文必需，每种语言最多 2,000 字符），不包含上游原始消息或输入值；`PluginFailure` 保留旧 message/status。

`SiteStatus` 可携带插件拥有的 `messageDetails`、`portDetails` 显示描述符；此处只定义线上的 `code`/`params` 形状。业务码、校验与翻译位于 Site 插件，旧字符串字段与项目存储格式继续兼容。

`@aura/protocol/model-checks` 定义临时模型检查结果、受控失败原因和字段投影。计数、耗时、模型 ID 与短回复有边界，未知状态或无效字段不推断含义；任意错误对象、凭据或上游诊断不作为插值参数。

`@aura/protocol/localization` 定义插件 manifest 的静态显示词库及校验器：支持六语言、英文回退、贡献 ID 与 JSON Pointer 到显示键的映射。词库只附加在 `AuraPluginStatus`，不进入持久化使用的 `AuraPluginIdentity`。声明不能修改 Schema、枚举值、默认值或执行参数；无 React、Node 或密钥依赖。

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

`@aura/protocol/native-ui` 定义桌面私有 UI 桥接的 `NativeFailure`、错误码校验和 `NativeHost<Api>` 类型。失败 DTO 只有固定类型标记和错误码，不携带路径、原始系统异常、凭据或业务状态；成功值保持原形。renderer 在公开 UI 适配边界恢复可读异常。此协议不改变 Flow/Agent 的持久化格式。

`@aura/protocol/errors` 的 `CodedFlowError` 在既有 `FlowError` 上携带宿主错误码；`flowErrorBody` 投影可读的兼容 `message` 和经过 `readErrorDetails` 校验的 `code`/`params`。参数只允许各错误码声明的有界数值、HTTP 状态（100–599）、订阅拒绝的模型标识（`[\w.-]`，最多 80 字符）和模型解析原因码（`[A-Z0-9_]`，最多 100 字符）。不转发任意对象、路径、凭据、cause 或上游响应。未知码不推断含义，旧错误继续只返回 message；这些字段只用于临时 RPC/HTTP 展示，不改变持久化记录或插件 SDK 的旧 FlowError 构造参数。

`ChatEvent` 的错误分支允许可选 code/params；`ConversationReceipt`、`ConversationExecution` 和 `CodingHistoryTurn` 允许可选 `errorDetails`。这些字段只用于运行时显示投影，命令账本 schema 和 DSH 历史格式不增加字段。读取端应使用 `readErrorDetails` 校验；原错误文本仍是旧客户端和未知码的回退。

`CodingSubagent` 可提供独立的 `executionErrorDetails` / `recordErrorDetails`，分别描述执行失败与记录读取失败；`roleKind` 标识宿主生成的 review/research/agent 角色，`defaultLabel: true` 仅标识缺少名称时的宿主默认文案。原 label/role/error 字段继续兼容，用户或外部名称不按句子推断和翻译。

`FlowRun`、`FlowStep` 和 `FlowAttempt` 可在显示副本中携带 `FlowFailureDetails`：一个经过校验的 API 失败原因和可选的 Agent 外部结果不确定标识。`readFlowFailureDetails` 丢弃其他字段，未知原因继续使用原错误。字段不进入运行记录的持久化 schema。

`FlowRecoveryEvent.reasonDetails` 是可选 API 错误详情，用于恢复说明的显示投影；`reason`、事件时间与持久化 schema 保持原格式。未知详情继续显示原说明。

`validation_failed` 参数只含已声明的校验上下文、最多 32 条结构化字段错误及剩余数量。字段路径最多 200 字符，类型标识、原因与上下限经过白名单和数值界限校验；不复制输入值、校验器消息、枚举值或 cause。标准校验类型可在界面翻译，任意自定义/未知原因继续使用旧诊断。`json_not_serializable` / `json_too_large` 仅投影已知上下文和字节上限。兼容 `message` 与状态码保持原样。
