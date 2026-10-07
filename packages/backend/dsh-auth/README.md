# @aura/dsh-auth

`index.ts` 汇集公共导出；`codex-auth.ts` 管理授权生命周期，`codex-token.ts` 管理令牌读取与刷新，`codex-profile.ts` 管理 provider 配置，`ai-services.ts` 管理模型设置。HTTP 投影属于 runtime。

Aura 后端对 DSH authorization/credentials seam 的适配层。包名描述的是稳定的架构职责，而不是当前接入的模型供应商；现阶段导出的 `CodexSubscriptionAuth` 组合官方 `dsh-credentials-local`、`dsh-authorization` 和 `dsh-llm-pi-ai` 插件，由 DSH 的 `openai-codex` flow 完成 ChatGPT Plus/Pro OAuth。未来其他需要交互式授权的 DSH provider 也应放在本包中，各 provider 保持独立的服务类型。

本包只负责授权编排和脱敏状态，不负责 HTTP 路由、对话进程或 UI。Aura 不直接调用 pi-ai，也不会读取 Codex 应用的登录文件或把 OAuth 凭据返回给前端。

授权记录由 DSH 的凭据服务写入 `.aura/dsh/.credentials.yaml`；同一 DSH home 下的 SDK profile 在模型请求时读取并自动刷新它。模型默认为 `gpt-6.1-sol`，运行时可通过后端环境变量 `AURA_CODEX_MODEL` 更改。`codexProviderProfile()` 提供默认 `xhigh` 思考强度，并通过 DSH 公开配置补充当前目录缺少的新型号、保留已有型号，供授权组合与编排 profile 共同使用。登录必须由用户点击触发；测试不发起 OAuth 或真实模型请求。
