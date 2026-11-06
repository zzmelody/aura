# Aura 工作区规则

Aura 宿主采用 pnpm workspace：`apps/*`、`packages/{frontend,backend,shared}/*`；随产品发布的 `plugins/*` 不属于 workspace。

Node.js >=24、pnpm 12.5.1，命令从仓库根执行。

## 项目全局规范

- 调整目录、模块或依赖：[项目结构](.agents/skills/aura-project-structure/SKILL.md)。
- 编写或审查自有代码：[代码规范](.agents/skills/aura-code-style/SKILL.md)。
- 开发或调整 UI、主题、组件、布局和动效：[UI 开发规范](.agents/skills/aura-ui-development/SKILL.md)。
- 编写测试、执行检查或交付：[测试与验证](.agents/skills/aura-testing/SKILL.md)。

## 始终生效

- 规范禁止依赖项目外的内容；skills 之间不得互相依赖，支持文件保留在各自目录内。
- Agent 临时文件统一放根 `local/`；测试使用隔离临时目录并自行清理。

## 不可逆约束

- 模型与 OAuth 凭据只由 backend 包持有，保存在被忽略的 `.aura/` 存储下。access token、refresh token 和 API Key 绝不出现在前端响应、日志、源码、客户端存储、Flow/Agent 上下文或错误消息中。
- 模型 provider 与交互式授权必须经过 DSH，不直接调用 pi-ai。DSH 和 pi-ai 作为已发布依赖使用，不复制也不修改其源码或 `node_modules` 下的文件。
- 用户数据和配置只由用户的操作改变。重构、迁移和重命名不改写 `.aura/` 下的配置或存储，不绕过 revision 检查；兼容性通过显式审查过的 compatibility 授权保留原有 ID、domain 名称和存储格式。
- 未知结果的付费请求不自动重发。付费阶段先在用户拥有的账本中预留预算。
