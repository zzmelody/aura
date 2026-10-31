# Aura 工作区规则

本仓库是 Aura 宿主：pnpm workspace（`apps/*` 与 `packages/{frontend,backend,shared}/*`）加上随产品发布、但不属于 workspace 的 `plugins/*`。个人业务插件在独立仓库 aura-studio。

Node.js 24（`>=24.0.0`）、pnpm 12.5.1，命令从仓库根执行。

## 按任务加载 skill

规则清单在 `.agents/skills/`，按任务加载对应的那份。

| 任务                                                  | skill                                                                      |
| ----------------------------------------------------- | -------------------------------------------------------------------------- |
| 新增/移动包或应用、决定代码放哪、技术选型、加依赖     | [aura-project-structure](.agents/skills/aura-project-structure/SKILL.md)   |
| 编写或审查宿主 TypeScript / TSX、处理格式与 Lint 失败 | [aura-code-style](.agents/skills/aura-code-style/SKILL.md)                 |
| 新增或修改测试、跑检查、交付前确认                    | [aura-testing](.agents/skills/aura-testing/SKILL.md)                       |
| 插件与插件宿主、Action / Flow / 插件 backend          | [aura-plugin-development](.agents/skills/aura-plugin-development/SKILL.md) |

架构背景见 [架构](docs/architecture.md)，改动包放置或依赖方向前读它。文档导航见 [文档目录](docs/README.md)。

## 不可逆约束

以下四条漏看一次就会泄露凭据或改坏用户数据，不依赖 skill 加载，任何改动都适用。

- 模型与 OAuth 凭据只由 backend 包持有，保存在被忽略的 `.aura/` 存储下。access token、refresh token 和 API Key 绝不出现在前端响应、日志、源码、客户端存储、Flow/Agent 上下文或错误消息中。
- 模型 provider 与交互式授权必须经过 DSH，不直接调用 pi-ai。DSH 和 pi-ai 作为已发布依赖使用，不复制也不修改其源码或 `node_modules` 下的文件。
- 用户数据和配置只由用户的操作改变。重构、迁移和重命名不改写 `.aura/` 下的配置或存储，不绕过 revision 检查；兼容性通过显式审查过的 compatibility 授权保留原有 ID、domain 名称和存储格式。
- 未知结果的付费请求不自动重发。付费阶段先在用户拥有的账本中预留预算。

## 本地临时文件

- Agent 的临时脚本、一次性工具、日志、截图、调试输出和下载物一律放在仓库根的 `local/` 下（按需创建，可按任务建子目录）。`local/` 已被 Git 忽略，随时可以整体删除，不存放任何需要保留的内容。
- 禁止在源码目录（`apps/`、`packages/`、`plugins/`、`docs/`、`scripts/`、`.agents/` 及仓库根）写入临时文件或工具。需要长期保留的脚本按正常改动提交到 `scripts/`。
- 源码不得引用 `local/` 下的任何路径。测试仍按 aura-testing 使用系统临时目录并自行清理。

交付前先跑受影响包的检查，再按改动范围扩大到 `pnpm run check`。验证记录只写实际执行过的结果：跳过的写明跳过，失败的贴输出，没跑的说没跑。
