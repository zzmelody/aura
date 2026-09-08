# DSH 模型接入

核对日期：2026-09-08。Aura 锁定 DSH `0.1.2-rc.1`，模型能力必须通过 DSH provider 与授权 seam 接入。Bedrock 保持未配置。

## Codex 订阅

当前实现保留 DSH 作为执行层。ChatGPT 订阅登录不是一个通用 API Key；Aura 使用 DSH `dsh-llm-pi-ai` 已提供的 `openai-codex` OAuth flow：

```yaml
- id: llm-pi-ai
  config:
    providers:
      openai-codex:
        reasoning: medium
        transport: sse
        cacheRetention: short
```

右上角登录按钮调用 Aura 后端，再由 DSH `ctx.authorization.begin()` 启动 `llm-pi-ai/openai-codex` flow。浏览器环境优先使用本机回调，手机和局域网页面使用设备码。成功的 grant 由 DSH 凭据服务写入 `.aura/dsh/.credentials.yaml`；模型请求在同一 DSH home 下读取记录并自动刷新。Aura 不读取 Codex 应用缓存，不把 token 复制到另一种格式，也不直接实例化 pi-ai 模型客户端。

对话使用 provider `openai-codex` 和默认模型 `gpt-5.6-terra`。模型、凭据或配额错误由 DSH 路径返回，不能静默切到本地演示。OpenAI 官方将 ChatGPT 登录和 API Key 登录区分为不同方式；API Key 使用单独的按量计费。参见 [OpenAI Codex 认证说明](https://learn.chatgpt.com/zh-Hans/docs/auth?surface=app)。

当前自动测试证明 DSH 注册了该 OAuth flow、脱敏状态可读取、完整 DSH profile 能运行两轮流式演示；没有代替用户完成 OAuth，也没有消耗订阅额度。因此第一次真实请求需要你点击登录并完成账号页面后验收。

## 自定义 API

后续自定义模型仍使用官方 `dsh-llm-pi-ai`，不新增一套 Aura 模型客户端。自定义网关需要明确协议、地址、凭据引用和真实模型 ID，例如：

```yaml
- id: llm-pi-ai
  config:
    providers:
      personal-api:
        displayName: 我的 API
        api: openai-completions
        baseURL: https://your-gateway.example/v1
        apiKeyEnv: AURA_MODEL_API_KEY
        models:
          - id: replace-with-real-model-id
```

支持 Responses 的网关改用 `openai-responses`。`apiKeyEnv` 保存的是 DSH 凭据引用名称，不是密钥；密钥由后端凭据服务解析，不能进入客户端或仓库。目录中已有的 provider 可以继承官方目录，再用 `modelOverrides` 调整个别模型；`models` 会替换整份目录，不应与 `modelOverrides` 同时使用。

本地实现依据是已安装的 [DSH pi-ai 插件说明](../node_modules/@deepseek-ai/dsh-llm-pi-ai/README.md)、[DSH 授权服务说明](../node_modules/@deepseek-ai/dsh-authorization/README.md) 和 [DSH 本地凭据说明](../node_modules/@deepseek-ai/dsh-credentials-local/README.md)。这些是只读安装依赖，不属于 Aura 源码。
