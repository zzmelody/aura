# DSH 对话能力

Aura 通过 DSH `0.2.1-rc.5` 的公开插件和服务提供上下文压缩、DeepSeek Web、只读子 Agent 与用户消息密钥遮罩，不修改 DSH 或 pi-ai 源码。

## 开启与额度

在“模型服务 → 对话能力”保存开关、DeepSeek Web Key 与累计额外请求额度。新安装默认关闭自动压缩、Web 和子 Agent，额度为零；读取设置不会创建用户配置。保存采用 revision 检查。设置在下次发送消息时更新工具列表。

每次压缩摘要、子 Agent 模型请求、单次 Search 或 Fetch 发出前，在 DSH storage domain `aura_coding_capabilities` 中预留一次额度。额度是**请求次数上限，不是金额上限**；实际计费以模型与 DeepSeek 服务为准。已预留次数不会因失败或取消退回，增加累计上限可补充额度。崩溃、取消或失败后未确认的请求阻止后续额外请求；用户核对后可在设置中确认未知结果，仅放行新请求，不重发旧请求。

Key 使用后端 DSH credentials 服务保存，配置和响应只包含是否已配置。设置界面不提供读取密钥功能。Flow 仍采用原来的显式工具授权。

## 上下文压缩

`/compact` 使用 DSH command registry 执行原生命令，仅允许空闲会话执行。没有可压缩历史时不发出摘要请求；正在压缩时可以停止。重启后可以先恢复会话再手动压缩。

自动压缩只在 Aura 对话的 step 边界调用原生 compaction policy，先使用原生工具结果裁剪，再视压力生成摘要。摘要沿用会话模型，自定义模型根据 context window 缩小摘要预留空间。摘要请求不自动重试；自动压缩失败或仍高于阈值会提示并继续当前轮次，过大的单条输入可能仍需用户拆分。

DSH 修改的是模型上下文投影，原始 JSONL 日志保留，Aura 历史仍显示原始消息。界面展示压缩进度；手动结果显示原生 token meter 估算的节省量。

## DeepSeek Search / Fetch

使用原生 `deepseek-search-api` 与 `deepseek-fetch-api`，官方 API 地址由 DSH 提供。没有启用或未配置 Key 时不向模型提供 Web 工具。每次 `web_search` 最多一个查询，以一次额度对应一次 API 请求；结果数量、Fetch 输出上限与外部不可信内容提示由 DSH 负责。

`sendOriginalQuestion: false`，不会附带原始问题。Aura 展示来源链接、截断标记和 Fetch 状态。无自动切换服务或失败重发。

## 子 Agent

原生 spawn 工具提供两个独立预设：`coding-researcher`（只读调研）和 `coding-reviewer`（只读审查）。继承父会话模型和目录，最多同时两个，深度为一。允许文件读取、搜索、问答、向父 Agent 发消息，以及已经配置的 Web；不提供写文件、Shell、工作流、定时任务或进一步委派能力。

生命周期、通知、父子关系与恢复目录由 DSH 管理。Aura 提供状态、结果和停止入口；父会话停止时同时停止其子 Agent。子 Agent 问答路由到父对话，并标注来源。原生委派权限不允许子 Agent 自行扩权，需超出只读范围时交回父 Agent 处理。

重启只恢复子 Agent 状态和结果展示，不重新提交未知任务。

## 密钥遮罩

浏览器通过现有 DSH 模块加载器加载已发布的 `dsh-client-ui-secret-mask/client`。Aura 只提供 UserText matcher、locale 与 renderer 的注册适配；识别规则、遮罩和显示/隐藏按钮均使用原生实现，没有复制识别正则。

已发送、引导和待发送回合中的用户文本默认遮罩已识别的密钥。遮罩加载失败时暂不显示用户正文，避免短暂露出明文。遮罩只影响展示，历史、模型输入与原文复制不变，不能替代凭据管理，也不保证识别所有秘密格式。

## 验证

默认测试使用本地合成模型、合成 Search / Fetch 响应及已发布的浏览器插件，不访问付费服务。覆盖额度并发、revision 冲突、未知结果恢复、原生子 Agent 权限和重启、手动与自动压缩、遮罩及 API 无重试行为。合成测试不代表真实账号已完成付费联调。
