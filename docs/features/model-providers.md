# DSH 模型接入

核对日期：2026-09-24。Aura 锁定 DSH `0.1.5-rc.3`，模型能力必须通过 DSH provider 与授权 seam 接入。Bedrock 保持未配置。

DSH SDK 的 `session.event` 现在以 `assistant/message` 提供完整助手消息。Aura 的 `/chat` 仍返回 NDJSON `delta` 事件，但当前每条助手消息只发出一次文本事件，而非逐 token 输出。

## Codex 订阅

### 会话内切换

聊天输入区提供「模型」与「思考」选择器。`GET /chat/models?mode=codex|demo` 从实际执行聊天的 DSH 宿主读取可用模型及各自档位，不依赖前端硬编码列表。选择按会话、模式分别保存在原有工作区记录中，新会话默认继承运行时设置；生成中禁用切换，后续消息使用新选择。切换模型时保留兼容的显式档位，不兼容则改为新模型默认；已有配置失效时显示错误，不静默换模型。

`POST /chat` 和 `POST /chat/codex` 接受可选的 `modelConfig: { model?, reasoningEffort? }`，不接受 provider、endpoint 或凭据。后端通过 DSH 精确能力校验后，在新建聊天 Agent 的会话事件中记录选择，仍由 DSH Session Controller 接收 prompt、取消和持久化。聊天不调用会写入全局默认值的 `selectModel()`；结束后释放自己持有的 DSH Agent handle。选择不会传给手动或工具启动的 Flow，`defineFlow.agentDefaults`、步骤覆盖和持久化运行配置完全独立。

当前实现保留 DSH 作为执行层。ChatGPT 订阅登录不是一个通用 API Key；Aura 使用 DSH `dsh-llm-pi-ai` 已提供的 `openai-codex` OAuth flow：

```yaml
- id: llm-pi-ai
  config:
    providers:
      openai-codex:
        reasoning: xhigh
        transport: sse
        cacheRetention: short
```

右上角登录按钮调用 Aura 后端，再由 DSH `ctx.authorization.begin()` 启动 `llm-pi-ai/openai-codex` flow。浏览器环境优先使用 `http://localhost:1455/auth/callback` 本机回调，Aura 回到前台后也会立即刷新登录状态；若浏览器或代理无法访问回调端口，界面会接住 DSH 的 manual-code prompt，允许粘贴最终回调地址。手机和局域网页面使用设备码；若 OpenAI 账号未启用该方式，界面会明确提示改用浏览器。成功的 grant 由 DSH 凭据服务写入 `.aura/dsh/.credentials.yaml`；模型请求在同一 DSH home 下读取记录并自动刷新。Aura 不读取 Codex 应用缓存，不把 token 复制到另一种格式，也不直接实例化 pi-ai 模型客户端。

Aura 后端优先采用进程已有的 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 与 `NO_PROXY`。Windows 上没有显式代理环境时，runtime 会读取当前用户启用的手动系统代理，使浏览器登录后的令牌交换和 DSH 模型请求走同一路径；Flow DSH 子进程在首次模型调用前单独安装代理 dispatcher，以兼容 Electron 内嵌 Node 的网络环境。`localhost`、`127.0.0.1` 与 `::1` 始终绕过代理。代理配置只用于后端网络调度及子进程环境，不进入客户端响应或日志。

对话使用 provider `openai-codex` 和默认模型 `gpt-6.1-sol`，默认思考强度为 `xhigh`（Extra high）。模型、凭据或配额错误由 DSH 路径返回，不能静默切到本地演示。Flow 中若 DSH 的 OAuth 续期失败，运行会显示检查网络或代理、重新登录 Codex 的指引；已失败的运行需新建运行。原始令牌服务响应可能含非文本字节，不会复制到 Flow 记录或前端。OpenAI 官方将 ChatGPT 登录和 API Key 登录区分为不同方式；API Key 使用单独的按量计费。参见 [OpenAI Codex 认证说明](https://learn.chatgpt.com/zh-Hans/docs/auth?surface=app)。

当前锁定目录尚未包含 GPT-6.1 Sol。`@aura/dsh-auth` 的 `codexProviderProfile()` 通过公开的 DSH `listModels()` 保留原目录，并用官方 `models` 配置补充该型号；授权组合与编排 profile 复用同一配置，不修改依赖源码。文本/图片输入、1,050,000 上下文和 `low/medium/high/xhigh/max` 档位依据 [OpenAI 模型文档](https://developers.openai.com/api/docs/models/gpt-6.1-sol)。128,000 输出容量仅作目录元数据，不新增请求硬上限。未来 DSH 原生收录该型号时自动使用其原生元数据。配置可在本地验证，但账号实际可用性仍由上游决定。

当前自动测试证明 DSH 注册了该 OAuth flow、脱敏状态可读取、手动回调可以提交、失败原因不会被后续轮询覆盖，完整 DSH profile 也能运行两轮流式演示；没有代替用户完成 OAuth，也没有消耗订阅额度。因此第一次真实请求需要你点击登录并完成账号页面后验收。

## 自定义 API

本机客户端可接入 Codex 订阅和自定义模型。由服务 token 保护的 `/ai/services` 负责保存非密钥配置；Key 留在 DSH credentials。支持 `openai-completions`、`openai-responses` 和 `anthropic-messages`，服务地址、模型 ID、上下文、图片输入能力及思考强度由用户明确填写。留空 Key 只继承同一地址与协议的已存密钥；更换地址不携带旧密钥。所有协议按其服务约定填写 API Key。

自定义模型继续使用官方 `dsh-llm-pi-ai`，不新增一套 Aura 模型客户端。每次保存产生不可变 provider 版本和凭据引用，并通过公开 settings seam 更新运行中的 DSH。新 Run 固定选定版本；子 Flow 继承父 Run 配置，修改设置不改变已有请求重试。经 `/services` 启动的服务 Flow 通过受控参数 `useConfiguredModel` 选择当前模式；演示模式保持独立。清除历史密钥和退出账号要求没有未完成的 Flow；失败、中断、取消不会持续锁住配置，主动清除凭据后旧任务重试需要恢复原凭据。

自定义网关对应的 DSH 配置示例：

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

本地实现依据是授权包安装的 `dsh-llm-pi-ai`、`dsh-authorization` 和 `dsh-credentials-local` README，位于 `packages/backend/dsh-auth/node_modules/@deepseek-ai/`。这些是只读安装依赖，不属于 Aura 源码。

## Lumina 网关

2026-10-04：Aura 内置 Lumina（`https://lumina.tripo3d.com/v1`，与 Claude Code 使用的同一网关）作为固定 DSH 路由 `aura-lumina`，走官方 `dsh-llm-pi-ai` 的 `openai-completions` 协议，不新增模型客户端。只需填写 API Key：工作台「设置 → 模型与账号 → Lumina」保存后写入 DSH credentials 的 `AURA_LUMINA_API_KEY`；启动环境若已设置同名变量则优先使用且界面只读。Key 不进入 `.aura/ai-services.json`、日志或前端响应。

保存 Key 或点击「同步模型列表」时，后端经 DSH `discoverModels` 读取 `/v1/models`，过滤掉 embedding、rerank、图片生成和 `sub2api-*` 等路由别名，把对话模型 ID 记入 `ai-services.json` 的 `lumina.models`，并在下一次请求前通过 settings seam 更新运行中的 DSH。输入框的模型选择器按供应商分组（Anthropic、OpenAI、Google、DeepSeek、通义千问、智谱、Moonshot、MiniMax、阶跃星辰等），分组规则在 `@aura/protocol/models`，只依据模型 ID 前缀。默认模型为 `claude-sonnet-4-6`，思考强度 `high`；Lumina 未公布模态，DeepSeek、MiniMax、Step 按纯文本声明，其余按文本加图片声明。

对话使用 `POST /chat/lumina`，工作流运行模式可选 `lumina`。2026-10-04 实测 DSH 路径可列出 40 个对话模型，`claude-sonnet-4-6` 与 `deepseek-v4-flash` 均返回正常回复。

## 工作台自定义 API

「设置 → 模型与账号 → 自定义 API」使用上文的 `/ai/services/model` 保存协议、地址、默认模型、上下文、图片能力与 Key，保存后立即检查连接并把服务列出的模型记为路由目录（`routes[*].catalog`），聊天时可在输入框按供应商切换。对话走 `POST /chat/custom`。

`/ai/services` 仍只在仅绑定本机的 runtime 上开放。服务客户端携带 `.aura/service.json` 中的 token；本机工作台与插件设置一致，依赖本机绑定和来源策略，可不带 token，但携带错误的 token 一律拒绝。

## 本地剧情模型调研

面向 RTX 3060 及以上、16GB 内存起步的游戏内剧情与任务决策，候选模型、Ollama / llama.cpp 部署路线、DSH 接入缺口及同机游戏验收方案见 [本地剧情决策器](../proposals/local-story-director.md)。当前本地演示仍是模拟模型，该文档不代表真实本地 provider 已接入。
