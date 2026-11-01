# Package 模块职责

应用保持薄宿主，跨包使用 package 名与显式 `exports`。下表描述当前实现；frontend 不依赖 backend；shared 不依赖平台 API；应用不能被其他 workspace 依赖。

| Package               | 模块边界                                                                                                                                                            | 公共接口与限制                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `@aura/protocol`      | `types.ts` 为 DTO；`models.ts` 为模型选择规则                                                                                                                       | shared，无 React、Node 服务或凭据                                     |
| `@aura/core`          | `workspace.ts` 创建默认状态和选择模式；`storage.ts` 恢复持久化数据；`endpoint.ts` 校验服务 origin；`state.ts` 仅汇集公共导出                                        | 继续使用存储 v1，不依赖 DOM 或 React                                  |
| `@aura/demo`          | 确定性的离线回复                                                                                                                                                    | 不执行网络或模型请求                                                  |
| `@aura/ui`            | `web.tsx` 为 DOM 原语；`components.tsx` 为共享组件；`theme.ts` 为主题                                                                                               | UI 无业务存储，应用提供 React 运行时                                  |
| `@aura/workbench`     | 通用对话、Flow、设置、工作区与宿主适配；通过公开 plugin/transport 入口提供共享控件和传输                                                                            | 业务界面由外部插件提供；Site 页面与运行后端在 `plugins/site-launcher` |
| `@aura/dsh-auth`      | `codex-auth.ts` 为授权生命周期；`codex-token.ts` 为令牌读取/刷新；`codex-profile.ts` 为 provider 配置；`ai-services.ts` 为模型设置；`index.ts` 为公共导出           | 组合 DSH 服务，不包含 HTTP 路由                                       |
| `@aura/tripo`         | `service.ts` 为 SDK 调度与付费提交；`task.ts` 投影公开任务；`credentials.ts` 读取忽略存储；`game-asset.ts` 为固定资产链路；`index.ts` 为公共导出                    | 不公开密钥、不自动重发未知付费结果                                    |
| `@aura/extensions`    | `schemas.ts` 校验；`configuration.ts` 原子读写；`discovery.ts` 校验目录、引擎与 SDK；`manager.ts` 管理串行应用/回滚；`types.ts` 为包内接口                          | 发现只读，不执行或安装插件                                            |
| `@aura/plugin-sdk`    | 公开 Action/Flow/provider、backend、storage、media、browser、errors 契约                                                                                            | 外部插件不导入宿主私有模块                                            |
| `@aura/plugin-ui`     | 插件工作台页面契约：`definePage`、页面 props 与 `auraWorkbench` 服务类型                                                                                            | frontend；运行时由工作台作为种子模块提供，插件不打包                  |
| `@aura/orchestration` | 根模块为执行、恢复、DSH 和注册；plugin-* 管理通用插件生命周期、存储、HTTP、preset 与兼容映射；`artifacts` 为登记、历史绑定、媒体与 HTTP 交付；`local-ai` 为进程适配 | 宿主不绑定业务库或业务 ID                                             |
| `@aura/runtime`       | `index` 组合；`*-routes` 建立 HTTP 边界；插件管理与模型能力；配置、模型测试、Hono 与服务入口各自独立                                                                | 不执行业务 Flow，也不拥有业务持久化                                   |

`apps/web`、`apps/mobile`、`apps/desktop` 和 `apps/server` 只拥有运行、构建与平台生命周期。独立服务的 `src/launch.ts` 经过构建生成 `dist/launch.js`，先安装 TS loader，再加载安装包内的 `server.ts`；生成产物不进入 Git。

非基础业务以独立插件发布（如 aura-studio），站点插件在 `plugins/site-launcher`。HTTP 路由负责解析与投影，library 负责项目/版本的存储规则，production 负责 Flow/Action 的业务协调；通用执行引擎不因某个页面需求新增领域状态。类型校验和现有领域测试验证兼容性，工作区检查验证包依赖方向。
