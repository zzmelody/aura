# @aura/runtime

运行时测试会启动真实 DSH 子进程，包级测试文件并发限制为 2，避免多实例启动争抢资源而耗尽诊断测试的原有时限。超时、断言及付费测试的环境门控保持不变；浏览器回归单独串行运行。

HTTP 校验与访问限制携带稳定显示码，包括对话/模型目录、编码设置、功能与语音、插件页面、模型配置与授权结果。原正文和状态码保留；`AiConfigurationError` 与 Codex 状态仅投影受限详情，不暴露原因对象、凭据或输入值。前端保存语义引用，语言切换不重发请求。`api-server.test.ts`、`ai-services.test.ts` 与授权测试验证边界和拒绝后数据不变。

`/ai/services` 通过可选 `checkDetails` 返回模型列表同步与实际模型请求各自的结构化结果，同时保留原 `checks` 文本。`model-probe.ts` 只投影受控失败原因，模型 ID、耗时和成功回复保留原值。检查结果仅在运行时内存中保存，不写配置；模型请求仍经过 DSH，仅由原有显式操作触发，语言切换不重试。`model-connection.test.ts` 使用真实 DSH 与本机合成服务验证成功、拒绝、空回复、请求次数及凭据隔离，不调用付费服务。

插件静态 `localization` 只在宿主向界面返回 Flow catalog 时附加。DSH 子进程环境、动态 `plugins/configure` 参数与执行目录不包含翻译资源，避免大词库超过 Windows 环境变量限制，也不把界面资源传给模型或持久化身份。目录 ETag 包含这份显示资源；语言切换无需重新读取。`host-health.test.ts` 用真实 DSH 子进程验证初次加载、动态替换与执行边界，不调用外部模型。

Runtime 的 `src/dsh/` 启动并管理一个长驻 DSH 进程。进程内装配 [Agent 会话](../agent-runtime/README.md)、[工作区与终端](../workspace/README.md) 和 [Flow 服务](../orchestration/README.md)。

界面错误通过 `CodedFlowError` 增量提供稳定 code 和限定参数。DSH RPC 与 Flow、编码、会话、终端、集成和插件调用的 HTTP 错误投影保留这些字段及既有 message/status；未接入的旧错误继续按原文返回。编排启动/断连、Flow HTTP 校验和图片上传限制已接入。错误详情不改变执行、取消、幂等或重试策略，未知码和未声明参数不跨边界透传。`api-error-routes.test.ts` 验证合成端口的投影与原始异常隔离；`host-health.test.ts` 验证真实 DSH 子进程中的错误码往返，不调用外部模型。

旧 chat/coding NDJSON 错误保留允许公开的稳定码，沿用原有安全过滤与 message。拒绝准入的纯文本 HTTP 响应保持原正文和状态，在 `X-Aura-Error-Code` 响应头附加受控码，并通过既有 CORS 策略向允许的来源公开此头。`api-server.test.ts` 覆盖兼容响应、流式投影和非公开异常遮蔽，不触发外部请求。

Aura 的编排子进程通过 DSH 的公开 `runProfile()` 启动 `aura-flow`。环境分层、profile 合并、Cordis 服务装配和退出清理由 DSH 处理。父子进程通过 stdio RPC 通信，启动异常通过 Aura 的脱敏诊断输出。

DSH 启动阶段耗时写入终端和 `.aura/dsh/logs/aura-host.log`，`event: "startup"` 的记录按 `startupId` 关联一次启动。`stage` 包括 profile 准备、进程创建、DSH 加载、插件 preset/backend 激活、各 domain 打开、工作空间、Action 恢复、Flow/Action 发现、Loader 等待、Flow 恢复和握手。`status` 为 started/completed/failed；`durationMs` 是本阶段耗时，`elapsedMs` 是从本次启动开始的累计耗时。total、handshake、dsh-load 和 orchestration-setup 包含子阶段，不能相加。启动失败会保留最后开始的阶段和已完成阶段；日志只接受固定阶段、UUID 与数值，不记录配置、凭据、原始错误或上游响应。

HMR 覆盖插件源码和 helper，并合并相同的 Flow/Action 监听根。DSH 的忽略匹配使用 POSIX glob，而 Windows `path.relative()` 返回反斜杠，因此生成的 profile 同时提供两种分隔符的忽略规则，避免为 `node_modules` 和隐藏目录注册大量文件监听。使用 DSH 0.2.1-alpha.2、Windows Electron 44.7.0、Node 24.21.0、相同的五个插件和独立空存储进行对照时，优化前启动 79.5 秒（DSH 加载 70.4 秒），优化后两次新进程启动分别为 13.3 秒与 22.4 秒。耗时受机器负载和文件缓存影响。

`POST /flows/assets/images` 在图片路由上执行 32 MiB 请求体限制，超出时返回图片大小错误。普通 Flow 请求的请求体上限为 256 KiB。

插件 HTTP 可在 `contributes.http.mounts` 中声明空闲的顶级路径（例如 `/example-documents`），也可使用 `/flows/<名称>`。每个挂载接收原路径及其子路径，沿用 Runtime 的 Origin 策略，由插件设定请求体上限。宿主保留内置路由的顶级路径。插件之间的挂载冲突会在注册时拒绝。

`GET /coding/sessions/:id/history?page=1` 在编排宿主初始化期间可由 Agent 会话包的 DSH 只读历史路径响应已完成会话，仍按原会话索引验证权限并返回相同的分页 DTO。执行和模型请求保持原有就绪门槛；HTTP 请求的 `AbortSignal` 传递到历史读取，切换会话或超时后不继续排队读取。

`GET /coding/channel` 直接返回会话协议版本，不启动 DSH。工作台用它区分旧后台缺少接口与会话尚未保存，避免把版本不匹配当成网络断线持续重试。

`GET /coding/assistant` 只读返回 Aura 固定主会话与已注册工作空间，未创建时为 `null`；`POST /coding/assistant` 表达用户显式打开意图，缺失时创建、已存在时返回同一身份。路由不接受客户端指定目录，不发送模型请求，身份与持久化由 Agent 会话服务管理。

`GET /coding/projects/:id/conversations` 默认包含历史状态；`?status=metadata` 用于快速恢复会话基础记录和内存中的活动状态，不触发旧会话日志扫描。只接受 `metadata` / `full`，旧调用行为保持不变。

`/coding/terminals` 提供工作区终端列表和创建，`/:id/write`、`/:id/resize`、`DELETE /:id` 转发受控操作；`/:id/events` 使用 SSE 输出 PTY 数据和状态，游标同时支持查询参数与 `Last-Event-ID`。连接断开只结束订阅，不终止 shell。所有路由沿用本机 / 同主机 Origin 策略，CORS 明确允许 DELETE 和重连游标。终端在 DSH 编排进程内持有，HTTP 边界不接收任意目录、shell 路径或环境变量，也不把 PTY 加入模型上下文。

`GET /coding/sessions/:id/history?page=1` 返回最近的完整回合窗口，后续使用响应的 `beforeSeq` / `throughSeq` 成对读取较早历史。HTTP 边界拒绝非安全整数、不完整的游标；不携带分页参数的调用保留完整历史接口。读取不会触发模型请求或改写存储。

Aura 的可嵌入后端组合根。`apps/server` 将它作为独立服务启动，`apps/desktop` 在 Electron 主进程内复用同一个生命周期；应用入口只负责宿主行为，不复制服务实现。

对话快捷菜单通过只读的 `GET /coding/projects/:id/skills` 读取已注册工作空间的技能摘要，路由转交编排宿主验证项目身份，不接受目录或文件路径。

Runtime 使用 TypeScript 源码并按职责拆分：

- `index.ts`：创建和关闭依赖，不承载路由或业务细节；
- `runtime-config.ts`：解析并校验运行配置与数据目录；
- `api-server.ts`：Hono HTTP 边界、并发准入和对话路由；
- `codex-auth-routes.ts`：DSH 授权状态的脱敏 HTTP 投影；
- `ai-services.ts` / `ai-services-routes.ts`：模型设置、可选模型目录和本机受控测试入口；
- `model-probe.ts`：经 DSH 的简短真实模型请求，复用已保存的 provider 与凭据，脱敏失败结果；获取模型目录不视为测试成功；
- `plugin-settings-routes.ts`：仅在 loopback runtime 上开放受信任插件目录的读取与替换；
- `dsh/host.ts` 与 `dsh/plugin.ts` 管理 DSH 进程、JSON-RPC 分发、事件流和取消。
- `demo-model.ts`：仅监听 loopback 的开发演示模型；聊天历史与结构化 Flow
  输入使用各自的内部标记，代码 Flow 传入普通自然语言提示时返回确定性的通用演示结果；
- `http-server.ts`：Hono Node 适配器生命周期与本地 Origin 策略；
- `validation.ts`：运行时无关的基础类型守卫。

所有 HTTP 路由、body limit、CORS、静态资源和 NDJSON/SSE 流均使用 Hono 及其官方 Node 适配器。Aura 业务代码不直接创建 `node:http` server。

本包通过端口接口依赖 `@aura/dsh-auth`，并只消费发布的 DSH 包和 Aura 自有 profile；不修改 DSH/pi-ai 源码。完整边界、失败策略与演进约束见 [后端 Runtime 技术方案](../../../docs/development/backend-runtime.md)。

流程执行委托给 [`@aura/orchestration`](../orchestration/README.md)：本包仅创建/关闭流程宿主、在 Origin 检查后转交 `/flows/*`，并为演示模式提供本地模型端点。代码 Flow 的发现/HMR、执行、不同 preset/session 的关联与汇总均不放在 runtime 或前端。

## 临时目录与默认对话目录

- 运行时临时目录：`AuraRuntimeOptions.tempDir` > 环境变量 `AURA_TEMP_DIR` > `<Aura root>/local/runtime`。只放可随时整体删除的中间文件；插件后端经 `host.tempDir` 拿到其中的 `plugins/<plugin-id>/` 子目录。
- 默认对话工作目录（未选项目的对话）：`AuraRuntimeOptions.defaultWorkspace` > 环境变量 `AURA_DEFAULT_WORKSPACE` > `<用户主目录>/Documents/Aura`。它位于 Aura 根目录之外，清理 `local/` 或仓库不会影响对话文件。

## 本地 Aura 插件

Runtime 启动时默认读取 `<Aura root>/.aura/plugins.json`。只加载被显式启用且声明 `trust: "local"` 的后端插件目录：

```json
{
  "version": 1,
  "plugins": [
    {
      "path": "F:/creative/aura-plugin",
      "enabled": true,
      "trust": "local"
    }
  ]
}
```

相对路径以 `plugins.json` 所在目录为基准。`AuraRuntimeOptions.pluginConfigPath` 可为嵌入式宿主或测试指定其他配置文件。插件必须提前安装自己的依赖并能解析兼容的 `@aura/plugin-sdk`；Aura 的发现过程只读，不运行包管理器、构建或下载。设置 API 动态应用目录变化；已启用贡献的 JavaScript 内容继续由现有 HMR 处理。

设置页通过 `GET/POST /plugins/config` 管理同一个固定配置文件。浏览器不能指定配置文件路径，后端会补全 `trust: "local"`、预校验目录并原子替换 JSON。由于启用插件等同于授予本机 Node.js 代码执行权限，这组接口仅在 runtime 绑定 `localhost`、`127.0.0.1` 或 `::1` 时可用；绑定局域网地址时返回 403，手机端不能远程启用宿主机代码。保存时会先把有效的 Action/Flow 根动态应用到编排宿主，再持久化配置；加载或保存失败会回滚到上一组注册根。已有运行继续使用创建时锁定的贡献版本，新运行立即使用新配置，无需重启 Aura。若配置文件被外部程序修改，接口返回 `applyRequired`，在设置页重新保存即可应用。

Coding HTTP 适配增加能力配置、压缩与子 Agent 查询/停止路由；浏览器资源注册表提供
原生 DSH secret-mask bundle，由工作台适配公开注册接口。参见[对话能力](../../../docs/dsh-conversation-capabilities.md)。

`/integrations` 提供功能开关、MCP 服务器配置、市场浏览、语音和会话搜索及团队视图。设置写入限制在仅绑定本机的服务，由编排宿主检查配置 revision。语音上传接收至多 30 秒的 PCM WAV。

`conversation-channel-routes.ts` 提供 `/coding/sessions/:id/commands`、命令查询、`snapshot` 和可恢复 SSE `events`。命令使用短 RPC 接收，事件按游标读取；HTTP 取消只释放观察者。旧 `/coding/turn` 与 `/chat/*` 继续投影同一个后端执行服务。参见[会话连接协议](../../../docs/development/conversation-channel.md)。
