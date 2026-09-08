# DSH 管理 Codex 订阅

Aura 的 Codex 登录和模型请求都保留 DSH 作为执行层。后端组合 DSH credentials、authorization、LLM runtime 与 `dsh-llm-pi-ai` 插件，并启动插件注册的 `openai-codex` OAuth flow；授权记录由 DSH 写入 Aura 专用的 DSH home。HTTP 接口只返回登录阶段、验证地址、设备码与模型名，不返回 grant 内容。

Codex 对话与本地服务演示共用一个 `dsh --profile aura-sdk` 启动路径。Codex 路由只改变初始化时的 provider、model 与推理参数，仍由 DSH agent loop 接收输入、产生日志事件并处理取消。模型或授权失败会作为 DSH 错误结束，不能切换到离线演示。

Aura 不直接依赖 pi-ai 的上游包。工作区检查拒绝 `@earendil-works/pi-ai` 与旧命名 `@mariozechner/pi-ai`，防止后续功能绕过 DSH。真实账号登录必须由用户在界面完成，自动测试只验证 DSH flow 注册、脱敏状态和 keyless DSH 对话链路。
