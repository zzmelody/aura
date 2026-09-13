# 验证记录

日期：2026-09-11，Windows 本地环境。自动验证不使用真实 Codex 账号或 API Key。

## 当前 Monorepo 回归

- pnpm 10.17.1 完成依赖安装并维护唯一的 `pnpm-lock.yaml`；可运行输出位于 `apps/*`，可复用库位于 `packages/frontend/*`、`packages/backend/*` 与 `packages/shared/*`。
- 工作区检查覆盖 app/library 元数据、平台依赖方向、`workspace:*`、显式导出、未声明依赖、跨包相对导入、应用被依赖和依赖环。
- 12 个 Aura app/library 类型检查目标纳入严格类型检查；Aura 自有应用、包、脚本和测试统一使用 TypeScript 源码。
- `pnpm run check` 通过，共 59 项自动测试，覆盖协议校验、工作区规则、源码约束、会话恢复、Hono API、Origin/body limit/NDJSON/SSE、Runtime 配置、DSH Codex OAuth flow，以及真实 DSH 代码 Flow/Action 的发现、独立 session、辅助模块 HMR、失败回滚与前端节点图解析。
- 后端运行时通过真实 `dsh --profile aura-sdk` 进程完成两轮流式演示，并拒绝非法请求。该测试验证 Aura 沿 DSH SDK、agent loop 和 session events 工作，不代表真实 Codex 模型调用。
- `pnpm run build` 通过；浏览器、Electron renderer 与 Capacitor 三个入口均由 Vite 从同一套 React Web 工作台构建，本地字体随各端产物输出。

## Web、Electron 与 Capacitor 验证

- 浏览器实际打开首页、Codex 连接弹窗、设置页和 Flow v2 页面；深浅主题可切换，Flow catalog 可加载，控制台无 warning 或 error。
- Electron 原生窗口实际启动并显示 Aura 工作台；关闭后 Electron 与内嵌 runtime 均已退出。
- Capacitor Android 平台已生成并完成 `cap sync`，`assembleDebug` 构建成功。
- `output/android/aura-preview.apk` 已验证包含 Capacitor Web 资源、Aura 应用代码、4 个本地字体、`classes.dex`、有效 APK 签名与预期网络权限。SHA-256：`19C762CE1C6494A67D27A4608F5D16EE3005384ECA096333C7638A1A023F8E19`。
- 前次迁移验证结束后，4311、4173、8081 和 8082 均无监听，未保留 Aura Node 或 Electron 后台进程。

Codex 架构固定为 `Aura → DSH authorization/agent loop → dsh-llm-pi-ai → openai-codex`。Aura 后端没有直接实例化 pi-ai 客户端，前端响应与存储不包含 OAuth token。真实订阅调用仍需用户在界面完成 OpenAI 登录后验收；自动测试不会代替用户授权或消耗订阅额度。

## 迁移说明与边界

- 原生 Expo/React Native 入口、配置和依赖已从源码及 lockfile 移除；旧的忽略目录 `apps/mobile/android` 已移动到可恢复的 `.aura/legacy-expo-android`，当前位置由 Capacitor Android 工程替代。
- 工作区存储键仍为 `aura.workspace.v1`，因此浏览器端已有数据保持兼容。旧 Expo 应用沙箱内的 AsyncStorage 数据不会自动迁移到 Capacitor WebView 的 `localStorage`。
- Android 产物仍使用开发签名；iOS 已配置 Capacitor 入口，但本次 Windows 验证不包含 Xcode、IPA 或真机记录。
- 当前服务定位于本机或可信局域网使用，尚未包含生产级用户认证、多租户隔离与公网防护。

## 紧凑 Flow 工作台回归（2026-09-10）

- `pnpm --filter @aura/workbench typecheck`、`pnpm --filter @aura/ui typecheck`、`pnpm --filter @aura/workbench test`、`pnpm run check`、`pnpm run build` 通过。Workbench 的 9 项测试覆盖完整 Flow 代码提取、最后一次修订选择、生成上下文与协议长度限制，以及 Flow 节点图静态解析。
- Playwright 在独立 Edge 浏览器会话中验证 1440×900 深浅主题，以及 1024、768、390、320px 宽度；代码区、消息输入和发送操作均保持在视口内，小屏会话抽屉支持搜索、选择后关闭与 Escape 关闭。
- 使用真实 DSH demo 运行已注册的研究报告 Flow，验证三个步骤完成、步骤会话切换和输出恢复；无效 JSON 禁止运行，参数和代码草稿在切换页面后保留，代码草稿在刷新后恢复。
- 使用受控 HTTP 回复验证两段普通会话同时生成、切换保留各自草稿、停止一段不影响另一段、后台完成、搜索筛选、发送当前 Flow 代码作为上下文、应用助手代码与撤销。该测试不调用真实 Codex 模型。
- 文件导入、导出和撤销替换通过，导出内容与导入内容 SHA-256 一致。截图与浏览器检查脚本位于忽略目录 `output/playwright/`。
- 节点图验证输入/输出、并行 Agent、工具、`if` 条件和循环回边；普通变量处理、格式化、日志与辅助函数不会生成节点。节点详情可定位到相应代码行，语法不完整时显示可恢复的代码入口。Edge 实际检查 1280、390 与 320px 视口，窄屏画布可横向滚动，详情面板排列在画布下方。
- Flow 目录栏通过真实 `/flows/catalog` 验证，能同时展示本地草稿、两个已注册 Flow 及可用状态；点击目录项会切到运行页并选中同一个 Flow。目录轮询与运行页共享控制器，390px 下可横向滚动且不会挤出刷新操作。
- 本轮验证为共享 Web UI 与构建验证，不代表已更新上面记录的 Android APK 或执行原生真机回归。

复查路径：打开 Flow 工作台 → 在流程图选择节点并跳到代码 → 修改代码后返回流程图 → 切换设置再返回 → 新建两段会话并切换草稿 → 助手代码放入编辑器/撤销 → 运行与记录 → 填写 task → DSH 演示运行 → 查看各步骤会话。缩小窗口后复查侧栏抽屉、节点画布和编辑器/助手切换。

## Flow 浏览与运行布局（2026-09-11）

- Flow 目录改为可搜索、筛选、独立滚动的纵向列表，去掉运行页重复目录；按需加载选中 Flow 的入口源码，节点图和只读代码对应同一已注册版本。节点详情默认关闭，画布按空间缩放，窄屏保留可读尺寸并允许横向滚动。
- 新增源码快照回归：源文件变更而尚未成功热加载时仍返回旧版本，成功注册后切换版本；未知/已移除 ID 返回错误。Hono 定向测试覆盖源码路由转发与不存在处理。
- `pnpm run check`、`pnpm run build` 通过；Playwright 验证真实 Action 示例的 DSH 演示运行完成、输出、当前 Flow 的运行记录过滤和跨 Flow 输入保留。
- 使用浏览器端受控 catalog 验证 30 条长名称 Flow 的独立滚动、搜索、可运行筛选及无结果提示。1440、1024、900、768、390、320px 页面均无整体横向溢出；小屏整页列表选择、Escape 返回与焦点恢复通过。
- 检查只读源码、节点详情关闭、键盘切换视图、复制到草稿与撤销，以及深浅主题。浏览器检查脚本和截图位于 `output/playwright/verify-flow-*.ts` 与 `output/playwright/flow-layout-*.png`；这些是共享 Web 界面验证，未重打包 Android APK。

## 工作流卡片与会话运行（2026-09-13）

- 首页改为工作流卡片，显示用途、可用状态与编辑/运行图标。点击当前卡片展开节点预览，编辑打开流程图/代码详情；主导航返回卡片列表。节点与画布支持拖拽，连线同步，背景改为纯色。
- 运行入口打开绑定工作流的会话，输入、结果、完整 JSON 输出、步骤详情与 Agent 历史集中在会话中。原有后端记录自动进入侧栏与全部记录，均有工作流来源图标。
- `pnpm run check`、`pnpm run build` 通过。新增 6 项测试覆盖工作流绑定恢复、待确认请求保留、运行合并去重、跨服务隔离、删除记录隐藏与完整结果恢复。
- Playwright 使用真实 DSH 演示验证 Action 工作流运行、两个步骤的输入/输出与 Agent 历史、同会话二次运行、导航切换和刷新恢复。模拟响应丢失后重试，确认已接受的请求继续绑定原 run ID；Schema 拒绝后允许修改输入。受控接口验证后台切换和取消运行。
- 验证卡片搜索无结果、键盘切换详情页签、普通会话与生成助手导航；1440、1024、768、390、320px 卡片页及 1024、390、320px 编辑页无整页横向溢出，390px 运行会话无溢出。节点拖拽后位置和连线改变，画布拖拽与重置、深浅主题均已检查。
- 检查脚本与截图保存在忽略目录 `output/playwright/verify-workflow-*.ts` 和 `output/playwright/workflow-*.png`。未调用真实 Codex 模型或重新打包 Android APK；浏览器日志除已有 favicon 404 与主动模拟的失败请求外，无应用错误。

## 侧栏与画布手势（2026-09-13）

- 左侧改为单行会话与可折叠工作流分组，搜索按需展开，工作流会话使用输入任务作为显示标题；保留自定义会话标题与来源图标，已完成记录不额外占用状态行。
- 新增 5 项聚焦测试覆盖分组、跨服务隔离、任务标题、缩放锚点、双指中心移动、缩放范围和滚轮增量分类；Workbench 共 18 项测试通过。
- Playwright 检查搜索/清除、分组展开/收起、会话选择，真实浏览器滚轮缩放的指针锚点、页面缩放不变；通过 WheelEvent 模拟触摸板平移/捏合，通过 Chromium CDP 多点触摸验证双指缩放后继续单指平移，保留节点拖动与连线更新。未使用物理触摸板或触屏设备验证。
- 已检查深浅主题、1440px 桌面与 390px 会话抽屉。脚本位于 `output/playwright/verify-sidebar-gestures.ts`，截图为 `output/playwright/sidebar-gestures-*.png`。
- `pnpm run check` 与 Web、Electron renderer、Capacitor 三端构建通过。

## Web / Desktop 开发热更新（2026-09-13）

- 定位到原 Desktop 命令只加载静态构建产物；现有 Web 标签页的日志记录了 Vite WebSocket 初始连接失败。`pnpm run desktop` 现使用 Vite 开发服务，静态桌面预览迁至 `desktop:preview`。
- 新增 6 项聚焦测试覆盖正常 HMR 不强制刷新、初始连接失败的 HTTP 恢复、服务重启、隐藏标签页恢复、监听清理及真实 Vite 版本端点。端点忽略后端和产物变化，虚拟客户端输出已转译为浏览器可执行 JavaScript。
- Playwright 同时打开 Edge、Electron 和阻断 WebSocket 的浏览器。实际修改共享 CSS 与 React 侧栏组件，两个正常客户端无需导航即可更新并保留搜索状态；断连客户端通过 HTTP 自动刷新。重启 Desktop Vite 服务后，Electron 窗口自动恢复。
- 实际执行 `pnpm run desktop`，验证 Vite 8082 与 Electron `--dev` 启动；结束开发入口后窗口和 8082 服务自动退出，已存在的 Web runtime 保留。用户原有 Web 标签页已接入新服务，并记录到共享 CSS / TSX 热更新。
- `pnpm run check` 与 `pnpm run build` 通过；Web 和 Desktop 静态产物均不包含开发版本轮询。验证脚本位于 `output/playwright/verify-hot-reload.ts`，截图位于 `output/playwright/electron-hmr.png`。主进程、开发启动脚本和后端 TypeScript 修改仍需重启对应进程。
