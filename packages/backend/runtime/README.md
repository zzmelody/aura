# @aura/runtime

`GET /coding/sessions/:id/history?page=1` 在编排宿主初始化期间可由编排包的 DSH 只读历史路径响应已完成会话，仍按原会话索引验证权限并返回相同的分页 DTO。执行和模型请求保持原有就绪门槛；HTTP 请求的 `AbortSignal` 传递到历史读取，切换会话或超时后不继续排队读取。

`GET /coding/assistant` 只读返回 Aura 固定主会话与已注册工作空间，未创建时为 `null`；`POST /coding/assistant` 表达用户显式打开意图，缺失时创建、已存在时返回同一身份。路由不接受客户端指定目录，不发送模型请求，身份与持久化由编排宿主持有。

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
- `ai-services.ts` / `ai-services-routes.ts`：模型与 Tripo 设置、可选模型目录和本机受控测试入口；
- `model-probe.ts`：经 DSH 的简短真实模型请求，复用已保存的 provider 与凭据，脱敏失败结果；获取模型目录不视为测试成功；
- `tripo-routes.ts`：Tripo 异步生成任务的校验、提交与状态查询；
- `plugin-settings-routes.ts`：仅在 loopback runtime 上开放受信任插件目录的读取与替换；
- 编排适配：通过 `@aura/orchestration` 的宿主端口转交 JSON-RPC、事件流与取消；DSH 子进程实现属于编排包；
- `demo-model.ts`：仅监听 loopback 的开发演示模型；聊天历史与结构化 Flow
  输入使用各自的内部标记，代码 Flow 传入普通自然语言提示时返回确定性的通用演示结果；
- `http-server.ts`：Hono Node 适配器生命周期与本地 Origin 策略；
- `validation.ts`：运行时无关的基础类型守卫。

所有 HTTP 路由、body limit、CORS、静态资源和 NDJSON/SSE 流均使用 Hono 及其官方 Node 适配器。Aura 业务代码不直接创建 `node:http` server。

本包通过端口接口依赖 `@aura/dsh-auth`，并只消费发布的 DSH 包和 Aura 自有 profile；不修改 DSH/pi-ai 源码。完整边界、失败策略与演进约束见 [后端 Runtime 技术方案](../../../docs/development/backend-runtime.md)。

Tripo 3D 是独立的后端网络 provider，不属于 LLM/DSH 模型路由。Runtime 通过
`@aura/tripo` 使用官方 v3 SDK，并把 `/tripo/*` 接口挂在相同的 Origin 策略后；配置、
接口和凭据规则见 [Tripo 3D 接入](../../../docs/features/tripo.md)。

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
