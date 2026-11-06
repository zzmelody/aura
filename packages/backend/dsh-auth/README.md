# @aura/dsh-auth

模型配置错误通过 `AiConfigurationError.details` 提供受限显示码，保留原 message/cause；凭据、地址和配置值不进入错误参数。Codex 授权沿用原有失败分类，通过可选 `messageDetails` 显示状态读取、回调、令牌交换和确认阶段；原通知、手动输入、取消与 DSH 授权流程保持不变。分类测试使用隔离凭据目录和合成授权交互，不登录真实账号。

`index.ts` 汇集公共导出。`codex-auth.ts` 管理授权生命周期，`codex-token.ts` 管理令牌读取与刷新，`codex-profile.ts` 管理 provider 配置，`ai-services.ts` 管理模型设置。Agent 和 Flow 共用 `model-config.ts` 的模型选项校验与 provider 默认值。HTTP 投影属于 runtime。

Aura 后端对 DSH authorization/credentials seam 的适配层。包名描述的是稳定的架构职责，而不是当前接入的模型供应商；现阶段导出的 `CodexSubscriptionAuth` 组合官方 `dsh-credentials-local`、`dsh-authorization` 和 `dsh-llm-pi-ai` 插件，由 DSH 的 `openai-codex` flow 完成 ChatGPT Plus/Pro OAuth。未来其他需要交互式授权的 DSH provider 也应放在本包中，各 provider 保持独立的服务类型。

本包负责授权、模型配置和脱敏状态。对话进程与 HTTP 路由由 runtime 装配。Aura 通过 DSH provider 和凭据服务完成模型调用与授权。

`agentFailure` 复用既有安全分类，返回带显示码的 `CodedFlowError`：输出上限、额度用尽、Codex 续期失败、订阅不支持的模型、HTTP 失败及一般执行失败。旧 message、状态码和内部识别前缀保持原样；参数只含白名单模型标识或 HTTP 数字，不含上游正文或 cause。模型选项中的未配置自定义服务和 Codex 不支持的 maxTokens 也附加稳定码。描述符只在显示边界使用，不改变 DSH、请求预算、授权流程或重试规则。

模型选项的标准 Schema 校验使用共享的有界字段诊断，不复制输入值或原始校验消息到显示参数；保留旧 message/status，自定义诊断回退原文。此过程不解析凭据、不调用模型，也不保存配置。

授权记录由 DSH 的凭据服务写入 `.aura/dsh/.credentials.yaml`；同一 DSH home 下的 SDK profile 在模型请求时读取并自动刷新它。模型默认为 `gpt-6.1-sol`，运行时可通过后端环境变量 `AURA_CODEX_MODEL` 更改。`codexProviderProfile()` 提供默认 `xhigh` 思考强度，并通过 DSH 公开配置补充当前目录缺少的新型号、保留已有型号，供授权组合与编排 profile 共同使用。登录必须由用户点击触发；测试不发起 OAuth 或真实模型请求。
