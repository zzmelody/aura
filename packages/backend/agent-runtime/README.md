# @aura/agent-runtime

本包拥有 Aura 的持久化 Agent 会话。会话准入、工具权限、协作模式、历史投影、索引、会话搜索和自动化由包内服务处理。DSH 会话、模型路由和审批仍使用已发布的 DSH 接口。宿主注入工作区目录、图片读取与 Flow 工具，并转发事件。

`createAgentService` 处理现有 `chat`、`coding`、`automation` 和对话集成请求。`@aura/agent-runtime/history` 选择冷读或实时历史，`@aura/agent-runtime/profile` 提供 Agent preset 与插件入口。

`personalAssistant(create = false)` 读取 Aura 专属主会话与其工作空间；只有显式传入 `true` 才在缺失时创建。索引对并发打开合并处理，固定身份为协议定义的 `coding-aura-personal-assistant`，沿用现有 domain 与 DSH 日志。再次打开不改写已有记录、不触发模型、不更换目录，重启后继续原上下文和模型配置。普通会话的关闭、归档和删除接口拒绝结束此主会话；普通任务保持独立。所属工作空间不可用时返回冲突，不自动重建或迁移用户数据。

`conversations(projectId, includeStatus = true)` 默认沿用历史状态投影；启动时传入 `false` 仅返回索引元数据和当前进程的运行、等待回答状态，不逐项读取 DSH 日志。`conversations/conversation-list.ts` 拥有该投影，历史日志失败不隐藏会话，旧日志中尚未结束的回合仍在完整查询时投影为已停止；不改写任何索引或日志。

`codingHistory(id, { page: true, beforeSeq?, throughSeq? })` 使用 DSH 的 message/turn 窗口和稳定日志截面返回完整回合与向前游标。默认调用仍支持完整历史投影；分页不改写 DSH 日志或用户配置，旁支过滤继承前缀，旧导入历史只在最早一页出现。

执行宿主尚未就绪时，分页历史优先走 `conversations/cold-history.ts`：在当前进程组合已发布的 DSH JSONL 只读持久化服务与 domain 校验，直接读取已完成回合，不等待完整插件与 Flow 恢复，也不启动执行进程。索引仅在有界私有临时副本中打开（最多 2 MiB、512 个文件），旧布局的自动引导只作用于副本；原索引和日志不迁移、不写入。每次读取都重新检查当前索引权限，关闭的会话、已解除关联或父会话已归档的旁支仍不可读取；JSONL 只使用 `read` 句柄，保留 DSH 的版本、修订与断尾校验。响应只包含现有历史 DTO，不输出原始日志事件。

只读窗口每页最多十个完整回合，沿用原日志的 `beforeSeq` / `throughSeq`，可以与宿主就绪后的分页互接；继承前缀和最早一页的导入历史规则一致。未完成日志、索引过大、格式暂不可读等情况回退原宿主路径；存在非空的 home 级 `cordis.patch.yml` 时也回退，避免忽略用户对存储根或编码的覆盖。运行状态始终由执行宿主确认；已就绪的宿主继续提供包含内存状态的实时读取。HTTP 请求取消会传递到只读加载；该优化不预热、恢复或重发模型请求。`@aura/dsh-auth/agent-failure` 提供相同的安全错误投影，读取历史无需加载 Agent 执行适配器。

对话的 `skills(projectId)` RPC 通过 DSH skill registry 读取已注册工作空间的用户可调用技能，只返回名称与描述。文件系统 provider 与技能加载器沿用 DSH 组合，对话工具白名单允许 `skill` 并支持原生 `/name` 显式调用。Flow Agent 的工具白名单保持不变，DSH 按实际工具可见性发布技能目录。HTTP 边界为 `GET /coding/projects/:id/skills`，客户端不能提交任意扫描路径。

工作空间对话按 DSH 会话头中绑定的目录读取根级 `AGENTS.md`，并通过该 Agent 自身的 DSH 提示词作用域加载。旁支及同目录的会话子 Agent 沿用这一边界。读取限于 64 KiB 的 UTF-8 正文，文件缺失、不可访问或指向符号链接时跳过。跨工作空间分叉按目标会话目录重新装配规则。宿主级指令加载器保持禁用，Flow Agent 不参与此加载过程。

执行中的模型控制只保存当前会话的待发送选择；`steerCoding` 可附带 `modelConfig: { mode, selection }`，固定追加消息发送时的模型和思考强度。模型解析、图片校验通过后，引导与新选择一起交给 DSH Agent；DSH 的 `installModelSelection` 在后续步骤装配提示词时固定路由和思考强度，已经发出的请求保持原配置。不写入部署级默认模型。当前轮次内只允许切换同一模型服务的模型，跨服务切换需等本轮结束。无运行轮次返回 `steered: false`，校验失败不投递、不切换、不自动重试。

对话发送或引导中附带图片时，DSH 模型元数据若在接收消息前判定模型不支持图片，返回安全的 422 提示，要求用户更换支持图片的模型或移除附件后自行发送。该拒绝不启动模型回合，不自动丢弃图片、切换模型或重发请求。

追加指令还在校验时若本轮结束或停止，返回 `steered: false`。此时可通过历史接口的 `running` 字段确认服务是否已完成本轮收尾。

追加消息可携带客户端生成的 `requestId`。DSH 的 inbox 插入投影为带 `delivery: "queued"` 的 `steer` 回执，只有 `user/message` 进入模型上下文时才移除该状态。普通停止沿用 DSH `SessionController.cancel()` 的 `keepInbox: true`，不启动新模型请求；下次用户发送消息时，DSH 先读取保留的 next-step 消息，再读取新轮次的普通请求。实时流用 `rpcId` 区分两者，即使旧消息先到，也会确认原条目。

历史从原 DSH inbox 日志恢复未读条目，跨轮次读取确认归回最早的提交；首步消息批次的最后一条普通消息识别为新轮次的提问，避免把保留的追加消息误认为「继续」请求。旧日志没有 step 边界时沿用首条消息规则。显式关闭或 Agent 生命周期释放产生的取消记录投影为 `delivery: "canceled"`，不自动重投；所有处理只投影既有日志，不迁移用户存储。

工作空间对话的 `openCodingSide(parentId)` 每次显式调用都创建独立旁支，`closeCodingSide(id)` 仅关闭指定旁支。多个旁支分别通过 DSH fork/resume 继承主对话并保存自己的上下文和模型设置。关闭或归档主对话会释放它的全部旁支。索引在原 `aura_coding_conversations` domain 中添加可选 `sideConversations` 元数据，保留原 ID、domain 版本和旧字段；单旁支历史只在读取时投影，不扫描、迁移或重写用户数据。DSH 日志保持原样。

新主对话和旁支先用首条消息作为临时标题，首轮成功后由 `conversations/conversation-title.ts` 通过 DSH 提炼短标题，使用该轮选择的服务和模型、最低可用思考强度，输入最多 4000 字符、输出最多 128 tokens、超时 15 秒。请求发出前在用户额外请求账本中预留一笔 `title` 额度；无额度、失败或取消保留临时标题，不自动重试。标题只在临时值仍匹配且会话开放时写入索引，不改变最近活动时间，不进入正文或历史上下文。后续轮次、重启恢复和固定 Aura 主会话不触发标题调用，也不扫描或补写已有对话。

旁支每轮使用专属系统规则，将主对话历史作为背景，并以旁支用户消息确定当前任务。用户可在旁支明确要求继续主对话的任务。新旁支首次 fork 后通过 DSH 关闭继承的计划模式，已建立的旁支恢复自身的计划状态。

## 验证

从仓库根运行 `pnpm --filter @aura/agent-runtime run typecheck` 和 `pnpm --filter @aura/agent-runtime run test`。跨包 DSH 和 HTTP 集成测试位于 `@aura/runtime`。

会话执行由 `conversations/conversation-executions.ts` 持有，HTTP/RPC 观察取消不停止执行。命令回执在独立 `aura_conversation_commands` domain 持久化，运行时事件有界缓存；启动、追加、停止和回答通过同一执行身份处理。重启后未完成记录投影为中断或不确定，不自动重发。参见[会话连接协议](../../../docs/development/conversation-channel.md)。
