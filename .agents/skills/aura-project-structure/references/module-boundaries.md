# Package 模块职责

应用保持薄宿主，跨包使用 package 名与显式 `exports`。下表描述当前实现；frontend 不依赖 backend；shared 不依赖平台 API；应用不能被其他 workspace 依赖。

| Package               | 模块边界                                                                                                                                                            | 公共接口与限制                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `@aura/protocol`      | `types.ts` 为 DTO；`models.ts` 为模型选择规则                                                                                                                       | shared，无 React、Node 服务或凭据                                     |
| `@aura/core`          | `workspace.ts` 创建默认状态和选择模式；`storage.ts` 恢复持久化数据；`endpoint.ts` 校验服务 origin；`state.ts` 仅汇集公共导出                                        | 继续使用存储 v1，不依赖 DOM 或 React                                  |
| `@aura/demo`          | 确定性的离线回复                                                                                                                                                    | 不执行网络或模型请求                                                  |
| `@aura/i18n`          | `runtime.ts` 为语言控制、消息引用、资源注册与格式化；`react.ts` 为 Provider/Hooks；`catalogs.ts` 为词库校验与审计 | frontend；宿主与插件共用运行时，业务词库归各自所有者 |
| `@aura/ui`            | `web.tsx` 为 DOM 原语；`components.tsx` 为共享组件；`theme.ts` 为主题                                                                                               | UI 无业务存储，应用提供 React 运行时                                  |
| `@aura/workbench`     | 通用对话、Flow、设置、工作区与宿主适配；通过公开 plugin/transport 入口提供共享控件和传输                                                                            | 业务界面由外部插件提供；Site 页面与运行后端在 `plugins/site-launcher` |
| `@aura/dsh-auth`      | `codex-auth.ts` 为授权生命周期；`codex-token.ts` 为令牌读取/刷新；`codex-profile.ts` 为 provider 配置；`ai-services.ts` 为模型设置；`index.ts` 为公共导出           | 组合 DSH 服务，不包含 HTTP 路由                                       |
| `@aura/plugin-manager`    | `schemas.ts` 校验；`configuration.ts` 原子读写；`discovery.ts` 校验目录、引擎与 SDK；`manager.ts` 管理串行应用/回滚；`types.ts` 为包内接口                          | 发现只读，不执行或安装插件                                            |
| `@aura/plugin-sdk`    | 公开 Action/Flow/provider、backend、storage、media、browser、errors 契约                                                                                            | 外部插件不导入宿主私有模块                                            |
| `@aura/plugin-ui`     | 插件工作台页面契约：`definePage`、页面 props 与 `auraWorkbench` 服务类型                                                                                            | frontend；运行时由工作台作为种子模块提供，插件不打包                  |
| `@aura/agent-runtime` | 持久化 Agent 会话、工具权限、索引、历史、协作和自动化 | 宿主注入工作区与 Flow 工具 |
| `@aura/workspace` | DSH 工作区注册、目录绑定校验及 PTY 生命周期 | 提供目录与终端服务 |
| `@aura/orchestration` | Action 与 Flow 执行、恢复、注册、工作流产物及插件后端能力 | 以工作流服务接入 DSH 宿主 |
| `@aura/runtime` | `index` 组合服务，`*-routes` 提供 HTTP 边界，`dsh/` 管理进程与 RPC 装配 | 通过各能力包的公开接口调度 |

`apps/web`、`apps/mobile`、`apps/desktop` 和 `apps/server` 只拥有运行、构建与平台生命周期。独立服务的 `src/launch.ts` 经过构建生成 `dist/launch.js`，先安装 TS loader，再加载安装包内的 `server.ts`；生成产物不进入 Git。

非基础业务以独立插件发布（如 aura-studio），站点插件在 `plugins/site-launcher`。Tripo 的 HTTP、Actions、账本和供应商适配在 `plugins/tripo`。HTTP 路由负责解析与投影，library 负责项目/版本的存储规则，production 负责 Flow/Action 的业务协调；通用执行引擎不因某个页面需求新增领域状态。类型校验和现有领域测试验证兼容性，工作区检查验证包依赖方向。
