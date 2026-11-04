# 外部系统接入方案：邮件、飞书、GitHub

状态：方案，未实现。本文用于评审接入路径与边界，不描述当前能力，也不改动运行时代码、配置或凭据。

核对日期：2026-11-03。

适用范围：`packages/backend/orchestration`（DSH profile 组合、Agent 工具白名单、插件后端）、`packages/backend/plugin-sdk`（公开插件契约）、`plugins/*`（随产品发布的产品插件）。

## 结论

能接，且几条主路径的成本差一个数量级。建议把"通用连接能力"和"渠道业务"分开：

- 通用连接用 DSH 官方的 `@deepseek-ai/dsh-mcp-client` 做一层 MCP 底座，一次性投入，之后 GitHub、飞书、邮件的第三方 MCP server 都能以配置方式接入。
- 渠道业务用产品插件（`plugins/*`）承载需要审计、需要产物、需要自定义凭据与失败文案的操作，尤其是飞书邮箱与发信类操作。
- 不把"shell 里跑 CLI"作为产品路径，只当验证手段。

写操作边界按只读 + 草稿设计：可以读邮件、Issue、消息、文档，可以建草稿、加评论；发信、合并 PR、发群消息、删除等不可逆操作必须由用户显式确认。

## 现状核对

以下是本机实测与源码事实，不是推测。

| 事实                                                                     | 证据                                                                                                                      |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| 对话 Agent 已具备 shell，可跑任意本机 CLI                                | `packages/backend/orchestration/src/coding/session.ts:70`（`shellTools` 取 `bash` 或 `pwsh`）                             |
| Agent 只能用显式白名单内的工具，继承工具会被过滤                         | 同文件 `:698` 的 `agent.ctx.tools.restrict({ allow })`；`codingTools` 在 `:50`                                            |
| 直接注册在 Agent 作用域的工具不受该白名单影响                            | `@deepseek-ai/dsh-tools` README：mask 取交集，scoped registration 保持可见                                                |
| DSH 有官方 MCP client，Aura 未挂载                                       | `dsh@0.2.1-alpha.2` 依赖 `dsh-mcp-client`；`dsh-base` 的 `cordis.patch.yml:480` 只挂 `mcp-resources`；`profile.ts` 无该行 |
| `gh` 2.98.0 已登录 `zzmelody`（scopes: `gist`, `read:org`, `repo`）      | `gh auth status`                                                                                                          |
| `lark-cli` 1.0.93 已登录，user/bot 双身份，含 `mail:*`、`im:*`、`docs:*` | `lark-cli auth status`；`lark-cli mail --help`；`lark-cli event consume`                                                  |
| runtime 默认只绑 loopback，且没有生产鉴权                                | `runtime-config.ts:39`；README「当前服务没有生产鉴权」                                                                    |
| 出站网络走系统代理，loopback 直连                                        | `packages/backend/runtime/src/network-proxy.ts`                                                                           |
| 对话里插件能贡献给模型的只有「启动 Run」形状的工具                       | `chat-tools.ts:333` 把 `PluginTaskTool.start` 映射为一次 durable Run + 运行卡片                                           |

关键含义：`gh` 与 `lark-cli` 现在就能被模型调用，但这条路绕过了所有结构化约束；而一旦要把工具做成产品能力，Aura 现有的入口只有"插件 chatTool = 一次 Flow Run"和"MCP 工具"两种，前者重、后者缺。

## 接入路径

| 路径               | 入口                                                   | 模型看到什么                          | 改动量              | 主要问题                                |
| ------------------ | ------------------------------------------------------ | ------------------------------------- | ------------------- | --------------------------------------- |
| A 现成 CLI         | 对话 Agent 的 `bash`                                   | 任意命令，无 schema                   | 0                   | 依赖用户机器 PATH；输出吃上下文；无护栏 |
| B MCP 底座         | `profile.ts` 插 `dsh-mcp-client` + 白名单放行 `mcp__*` | `mcp__<server>__<tool>`，原生工具形态 | 1–2 天，一次性      | MCP server 质量参差；alpha 版本需锁定   |
| C 插件 Action/Flow | `plugins/<id>` 的 backend + `actions/` + `chatTools`   | 一次 Run + 运行卡片，或 Flow 内 Agent | 每渠道 2–4 天       | 每次调用都是 durable Run，轻操作偏重    |
| D 插件自带 preset  | `contributes.presets` 里挂 MCP client                  | 同 B，但只对使用该 preset 的 Agent    | 先要改会话选 preset | 见下文，当前没有入口                    |

### A. 现成 CLI

不改任何代码即可验证需求：模型在项目工作目录里跑 `lark-cli mail +messages`、`gh pr list --json`。适合判断"到底想让它做什么"。

不适合作为产品路径，原因有三个可验证的事实而非主观偏好：

- Electron 从 Finder/开始菜单启动时，`PATH` 通常不包含 `~/.nvm/.../bin` 与 `/opt/homebrew/bin`。这一点尚未在 Aura 进程内实测（见"待确认"），一旦成立，桌面版就会时好时坏。
- CLI 是面向人的文本输出，模型要么读全文，要么自己拼 `--jq`，没有 schema 约束和数量上限。
- 权限边界只靠提示词。`lark-cli` 的 write/high-risk-write 分级与 `gh` 的 scope 都不经过 Aura 的工具策略。

### B. MCP 底座

`dsh-mcp-client` 已经在依赖树里，生效只需两处改动：

1. `packages/backend/orchestration/src/profile.ts` 的 `insert:`（`:175` 起）增加若干 `name: '@deepseek-ai/dsh-mcp-client'` 行，每行一个 server：`serverName`、`transport`（`stdio` 或 `streamable-http`）、`command/args/env` 或 `url/headers`，另有 `toolCallTimeoutMs`、`failOnStartupError`、`reconnect.*`。
2. `coding/session.ts` 的 `mountCodingTools` 放行 `mcp__` 前缀的工具。当前 `restrict({ allow })` 只认 `codingTools` 里的固定名字，MCP 工具属于继承工具，会被静默过滤——模型看不到，也不会报错。

配置来源建议放在 `.aura/` 下的独立文件（与 `ai-services.json`、`service.json` 同级），由 runtime 读取并校验后写进 profile，而不是把 server 列表硬编码进 `profile.ts`。profile 的 `patchReload` 是 `startup`，配置变更需要重启 runtime，这与现有模型配置的语义一致。

这条路径的价值在于覆盖面：单个 MCP server 的接入成本是"一段配置"，不需要写 Action、Flow 或页面。风险在于稳定性——`dsh-mcp-client` 目前是 `0.2.1-alpha.2`，与其它 DSH 包同一版本线；新渠道引入第三方 server 时，进程崩溃、启动变慢、工具集合变小都是已知行为（README 有说明），需要用 `failOnStartupError: false` + 日志观察，而不是让启动整体失败。

MCP 常驻连接本身不重，真正的成本是它暴露的每个工具都会整体进入模型 schema。所以读操作应当收敛成少量带参数的查询工具（`search`、`list`、`get`），而不是每个资源一个工具；工具注册失败时模型只会看到"没有这个工具"，需要用 `failOnStartupError: false` 加日志兜住。

### C. 插件产品化

`plugins/<id>` 一个插件一个后端：backend 持有 API 客户端与凭据，`actions/<id>/*.action.js` 提供结构化能力，`contributes.pages` 提供设置页，需要的话再加 `contributes.presets`。

这里有一个必须先说清的硬约束：插件贡献给**对话**的工具是 `chatTools`，而 `PluginTaskTool.start()` 的返回值是 `{runId, flowId, title, input}`——每次调用都会创建一次 durable Flow Run、生成运行卡片、等待结算后才回答（`chat-tools.ts:99` 的 `once()`）。对"建一封邮件草稿""把消息发出去"这类需要审计和回放的操作，这个形状是对的；对"看一眼现在有几封未读"，它偏重，且会占一轮对话的运行槽位。

插件 Action 则只对 Flow 内 Agent 和 Flow 直调可见，对话 Agent 拿不到 Action，只能通过 Flow 间接使用。所以"让对话直接用上插件能力"的现实做法是：轻读操作走 MCP，重操作/写操作走插件 Run。

### D. 插件自带 preset（可选补充）

`contributes.presets` 允许插件注册自己的 `agent.cordis.yml`（`plugin-presets.ts`），preset 里的插件挂在该 Agent 的作用域下，工具属于"直接注册"，不经过 `codingTools` 白名单。理论上可以让插件自带一个 MCP server 配置，只对使用该 preset 的 Agent 可见，从而避开对全局 profile 与白名单的改动。

限制是现阶段的：对话会话固定解析 `coder-v1`（`coding/session.ts:120`），工作台没有按会话选择 preset 的入口。要走这条路，先得让会话可以选择插件的 preset，这本身就是一处产品改动。因此把 D 当作 B 的备选，不作为第一选择。

## 渠道设计

### 飞书

最容易，三个能力各自独立：

| 能力                      | 建议做法                                                                                 | 备注                                                             |
| ------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 读（消息/文档/日程/审批） | MCP 或插件 backend 直连开放平台 API                                                      | `lark-cli` 现在可用，可先做行为验证                              |
| 写（发消息/建文档/评论）  | 插件 Action + Flow，草稿或确认后执行                                                     | 复用 `lark-cli` 的 risk 分级思路：普通写直接做，高危写要二次确认 |
| 事件（新消息/审批待办）   | 开放平台长连接（`lark-cli event consume` 已验证存在），常驻订阅后作为 follow-up 注入会话 | 不需要公网入口，这是飞书相对 GitHub 的结构性优势                 |

飞书自建应用的身份与 scope 已经在 `lark-cli auth status` 里落地，可作为插件 backend 的凭据来源参考；但插件应自己持有 token（app_id/app_secret + 用户授权），不能依赖 CLI 的本地状态。

### 邮件

分两类，实现成本不同：

- 飞书邮箱：复用飞书开放平台 `mail` 能力（`lark-cli mail` 的 `+send`/`+draft-create`/`+reply`/`+messages` 已在用），归到上面的飞书插件里，不新开一套。
- 其它邮箱（Gmail/Outlook/QQ/163）：插件 backend 自己实现。IMAP + SMTP（`imapflow` + `nodemailer`）覆盖大部分个人邮箱，应用专用密码即可；Gmail/Outlook 若要走 OAuth，需要自建 OAuth 应用并处理 refresh，成本明显更高，第一版可以不碰。
- 权限建议：`mail.read`（列表/搜索/正文/附件元数据）、`mail.draft`（建草稿、改草稿）、`mail.send`（默认关闭，需要每次确认）。发信工具的 schema 里不放 `to` 之外的隐式收件人，避免模型自行抄送。

第一版明确不做：附件下载到工作区以外的路径、自动转发规则、批量删除。三条都与"不可逆 + 凭据外泄面"有关。

### GitHub

- 读：`gh` 的 JSON 输出（`gh pr list --json`、`gh issue list`、`gh run list`）已经结构化，用 CLI 包一层比手写 REST 更省事，但只适合做 MCP server 的实现细节，不适合让模型直接拼。首选 GitHub 官方 MCP server（`streamable-http` 或 stdio + PAT）。
- 写：建 Issue/评论、建分支、开 PR 可以；合并、删分支、改仓库设置属于高危，需要确认。
- 事件：GitHub **没有**长连接通道，webhook 必须有公网可达地址。Aura 当前无公网入口、无鉴权，因此第一版用轮询（`schedule_*` 定时拉 `GET /notifications` 或关注的 PR 列表），把"实时"留到有部署方案之后。
- PAT 建议只授 `repo` 与 `read:org`，不要用 `gh` 已有的 keyring 凭据做产品集成——那是用户交互式登录的产物，插件不应读取。

## 凭据与写操作边界

- 凭据只由 backend 持有，落在 `.aura/plugins/<plugin-id>/`（`host.dataDir`）下 0600 文件，或 `.aura/` 内同类目录，沿用 `.aura/tripo/api-key` 的做法；不进前端、不进 HTTP 响应、不进日志、不进模型上下文。
- 插件设置（`.aura/plugins.json` 的 `settings`）只放非敏感项（开关、默认邮箱、轮询间隔）。`host.settings` 是明文，不适合放 token。
- 写操作的确认走两条现成缝隙：对话里的 `ask_user_question`（`coding/session.ts` 已接入 `user-questions/request`），以及 DSH 的 `approval/request`（`coding/questions.ts` 已把 approval 投影成 yes/no 问题卡）。不要自己发明确认协议。
- 每个写工具的 schema 必须让"影响范围"成为显式参数（邮箱地址、仓库、分支、收件人列表），而不是让模型从自然语言里推断后直接执行。

## 分期

| 阶段 | 内容                                                            | 产出                                         | 估算   |
| ---- | --------------------------------------------------------------- | -------------------------------------------- | ------ |
| 0    | 只读验证：用 `gh` / `lark-cli` 在真实对话里跑通三个渠道的读操作 | 一份"模型实际怎么用"的记录，用来定工具粒度   | 半天   |
| 1    | MCP 底座 + GitHub 只读                                          | `.aura/` 的 MCP 配置、白名单放行、GitHub 读  | 1–2 天 |
| 2    | 飞书插件：读 + 消息/文档写 + 事件长连接                         | `plugins/feishu`（backend、actions、设置页） | 3–4 天 |
| 3    | 邮件插件：IMAP 读 + 草稿，发信默认关闭                          | `plugins/mail`                               | 3–5 天 |
| 4    | 入站事件的部署方案（隧道或公网部署 + 鉴权 + 签名校验）          | 设计文档，不是代码                           | 待定   |

阶段 1 之后就该停下来评估：如果 MCP 方式已经够用，阶段 2/3 的插件化可以只做"设置页 + 凭据"，把业务逻辑继续留在 MCP server 里。

## 风险与待确认

1. **`PATH` 是否在桌面版可用**（未实测）。需要在打包后的 Electron 里打印 `process.env.PATH` 并跑一次 `gh --version`；若不可用，路径 A 在桌面版直接失效，必须在插件里给出绝对路径或改用 API。
2. **`lark-cli` 用户 token 有效期**：本机观察到 `expiresAt 2026-11-03T12:57`、`refreshExpiresAt 2026-11-10`。CLI 会自行刷新，但插件不能假设用户的 CLI 状态长期有效。
3. **MCP alpha 版本锁定**：`dsh-mcp-client` 与 DSH 其它包同版本线，升级 DSH 时必须同步验证 MCP 工具注册与白名单放行逻辑。
4. **上下文成本**：每个 MCP server 的工具列表都进入模型 schema，飞书一个 server 就可能有几十个工具。需要按 server 粒度限制暴露的工具集，而不是全量挂载。
5. **无公网鉴权的现状**：任何"入站 webhook"方案在补上鉴权之前都不应实施；也不要为了 webhook 把 runtime 直接暴露到公网。
6. **轮询成本**：GitHub 通知轮询按 15 分钟级设置，避免触发 API 限流；轮询任务本身是 durable Run，重启后要能正确恢复。

## 验收

- 阶段 1：模型能在对话里回答"我有哪些待 review 的 PR"并给出仓库、编号、标题；工具失败时给出可行动的错误而不是空结果。
- 阶段 2：能按主题搜索飞书消息、读取文档内容、在指定群发一条消息（发送前确认），且事件订阅在 runtime 重启后自动恢复。
- 阶段 3：能列出最近未读邮件、读出正文、建一封草稿；发信在没有显式确认时被拒绝，且拒绝原因可读。
- 全程：`.aura/` 之外的仓库文件不被修改；日志、HTTP 响应、前端存储中不出现 token。

## 不做什么

- 不做公网多租户、团队共享凭据、云端凭据托管。
- 不做"让模型自由执行任意 CLI"的产品化封装。
- 不把 `gh` 或 `lark-cli` 的本地登录态当作 Aura 的凭据来源。
- 不在第一版做 Gmail/Outlook 的 OAuth 应用与审核流程。
- 不为单个渠道新增常驻的宿主 facade；业务逻辑放插件。
