# @aura/dsh-codex

Aura 后端对 DSH 授权 seam 的薄封装。它组合官方 `dsh-credentials-local`、`dsh-authorization` 和 `dsh-llm-pi-ai` 插件，由 DSH 的 `openai-codex` flow 完成 ChatGPT Plus/Pro OAuth。Aura 不直接调用 pi-ai，也不会读取 Codex 应用的登录文件或把 OAuth 凭据返回给前端。

授权记录由 DSH 的凭据服务写入 `.aura/dsh/.credentials.yaml`；同一 DSH home 下的 SDK profile 在模型请求时读取并自动刷新它。模型默认为 `gpt-5.6-terra`，可通过后端环境变量 `AURA_CODEX_MODEL` 更改。登录必须由用户点击触发；测试不发起 OAuth 或真实模型请求。
