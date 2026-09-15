# @aura/runtime

Aura 的可嵌入后端组合根。`apps/server` 将它作为独立服务启动，`apps/desktop` 在 Electron 主进程内复用同一个生命周期；应用入口只负责宿主行为，不复制服务实现。

Runtime 使用 TypeScript 源码并按职责拆分：

- `index.ts`：创建和关闭依赖，不承载路由或业务细节；
- `runtime-config.ts`：解析并校验运行配置，安装 Aura 自有 DSH profile；
- `api-server.ts`：Hono HTTP 边界、并发准入和对话路由；
- `codex-auth-routes.ts`：DSH 授权状态的脱敏 HTTP 投影；
- `tripo-routes.ts`：Tripo 异步生成任务的校验、提交与状态查询；
- `plugin-settings-routes.ts`：仅在 loopback runtime 上开放受信任插件目录的读取与替换；
- `dsh-session-runner.ts`：DSH SDK 子进程、JSON-RPC、事件流与取消；
- `demo-model.ts`：仅监听 loopback 的开发演示模型；聊天历史与结构化 Flow
  输入使用各自的内部标记，代码 Flow 传入普通自然语言提示时返回确定性的通用演示结果；
- `http-server.ts`：Hono Node 适配器生命周期与本地 Origin 策略；
- `validation.ts`：运行时无关的基础类型守卫。

所有 HTTP 路由、body limit、CORS、静态资源和 NDJSON/SSE 流均使用 Hono 及其官方 Node 适配器。Aura 业务代码不直接创建 `node:http` server。

本包通过端口接口依赖 `@aura/dsh-auth`，并只消费发布的 DSH 包和 Aura 自有 profile；不修改 DSH/pi-ai 源码。完整边界、失败策略与演进约束见 [后端 Runtime 技术方案](../../../docs/backend-runtime.md)。

Tripo 3D 是独立的后端网络 provider，不属于 LLM/DSH 模型路由。Runtime 通过
`@aura/tripo` 使用官方 v3 SDK，并把 `/tripo/*` 接口挂在相同的 Origin 策略后；配置、
接口和凭据规则见 [Tripo 3D 接入](../../../docs/tripo.md)。

流程执行委托给 [`@aura/orchestration`](../orchestration/README.md)：本包仅创建/关闭流程宿主、在 Origin 检查后转交 `/flows/*`，并为演示模式提供本地模型端点。代码 Flow 的发现/HMR、执行、不同 preset/session 的关联与汇总均不放在 runtime 或前端。

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

相对路径以 `plugins.json` 所在目录为基准。`AuraRuntimeOptions.pluginConfigPath` 可为嵌入式宿主或测试指定其他配置文件。插件必须提前安装自己的依赖并能解析兼容的 `@aura/plugin-sdk`；Aura 的发现过程只读，不运行包管理器、构建或下载。修改配置、启用或禁用插件后需要重启 runtime；已启用贡献的 JavaScript 内容继续由现有 HMR 处理。

设置页通过 `GET/POST /plugins/config` 管理同一个固定配置文件。浏览器不能指定配置文件路径，后端会补全 `trust: "local"`、预校验目录并原子替换 JSON。由于启用插件等同于授予本机 Node.js 代码执行权限，这组接口仅在 runtime 绑定 `localhost`、`127.0.0.1` 或 `::1` 时可用；绑定局域网地址时返回 403，手机端不能远程启用宿主机代码。保存时会先把有效的 Action/Flow 根动态应用到编排宿主，再持久化配置；加载或保存失败会回滚到上一组注册根。已有运行继续使用创建时锁定的贡献版本，新运行立即使用新配置，无需重启 Aura。若配置文件被外部程序修改，接口返回 `applyRequired`，在设置页重新保存即可应用。
