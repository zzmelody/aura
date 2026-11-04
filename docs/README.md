# Aura 文档

本文是当前实现的文档入口。包内 README 说明该包的职责、公共接口与检查方式；此目录说明跨包架构、用户功能和部署。历史验证和未实现的设计单独保留。

## 开发与架构

- [架构](architecture.md)：应用、三层库、DSH、HTTP 和凭据边界。
- [模块职责](development/module-boundaries.md)：各 package 的目录、模块与依赖责任。
- [代码规范](code-style.md)：Google TypeScript 的 Aura 适配及实际检查命令。
- [后端 Runtime](development/backend-runtime.md)：组合根、服务路由、生命周期与失败策略。
- [界面设计系统](development/design-system.md)：共享 React DOM 组件与主题。
- [外部插件 JavaScript](plugin-javascript-code-style.md)：Airbnb 适配与公共 SDK 例外。
- [产品插件](../plugins/README.md)：随 Aura 发布的插件目录、默认加载与分发命令。

规则清单按任务拆成 skill，位于 `.agents/skills/`：[项目结构](../.agents/skills/aura-project-structure/SKILL.md)、[代码规范](../.agents/skills/aura-code-style/SKILL.md)、[测试规范](../.agents/skills/aura-testing/SKILL.md)、[插件开发](../.agents/skills/aura-plugin-development/SKILL.md)。本目录的文档提供它们背后的架构背景与完整说明；入口和始终适用的约束见 [AGENTS.md](../AGENTS.md)。

## 功能

- [模型与登录](features/model-providers.md)
- [Tripo 3D](features/tripo.md)
- [本地媒体 Actions](../packages/backend/orchestration/docs/local-ai-actions.md)

## 设计与验证

- [Agent 会话、工作区与 Flow 编排拆分方案](proposals/backend-package-boundaries.md)（待实施）
- [剧情决策器部署调研](proposals/local-story-director.md)：尚未实现的选型方案，不是当前能力。
- [外部系统接入方案](proposals/external-integrations.md)：邮件、飞书、GitHub 的接入路径、凭据边界与分期，尚未实现。
- [本轮验证](verification.md)
- [历史验证记录](verification/history.md)：按当时提交与环境记录，不代表当前全仓状态。

新增文档放入对应目录，同时更新此入口。行为和公共接口变化更新所属包的 README 及功能文档；验证记录只记实际执行的结果。

- [DSH 对话能力](dsh-conversation-capabilities.md)：压缩、Web、子 Agent、密钥遮罩与请求额度。
