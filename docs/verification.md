# 验证记录

日期：2026-09-10，Windows 本地环境。自动验证不使用真实 Codex 账号或 API Key。

## 当前 Monorepo 回归

- pnpm 10.17.1 完成依赖安装并维护唯一的 `pnpm-lock.yaml`；可运行输出位于 `apps/*`，可复用库位于 `packages/frontend/*`、`packages/backend/*` 与 `packages/shared/*`。
- 工作区检查覆盖 app/library 元数据、平台依赖方向、`workspace:*`、显式导出、未声明依赖、跨包相对导入、应用被依赖和依赖环。
- 11 个 Aura app/library 类型检查目标纳入严格类型检查；Aura 自有应用、包、脚本和测试统一使用 TypeScript 源码。
- `pnpm run check` 通过，41 项自动测试覆盖协议校验、工作区规则、源码约束、会话恢复、Hono API、Origin/body limit/NDJSON/SSE、Runtime 配置、DSH Codex OAuth flow，以及真实 DSH 代码 Flow 的发现、独立 session、辅助模块 HMR 与失败回滚。
- 后端运行时通过真实 `dsh --profile aura-sdk` 进程完成两轮流式演示，并拒绝非法请求。该测试验证 Aura 沿 DSH SDK、agent loop 和 session events 工作，不代表真实 Codex 模型调用。
- `pnpm run build` 通过；浏览器、Electron renderer 与 Capacitor 三个入口均由 Vite 从同一套 React Web 工作台构建，本地字体随各端产物输出。

## Web、Electron 与 Capacitor 验证

- 浏览器实际打开首页、Codex 连接弹窗、设置页和 Flow v2 页面；深浅主题可切换，Flow catalog 可加载，控制台无 warning 或 error。
- Electron 原生窗口实际启动并显示 Aura 工作台；关闭后 Electron 与内嵌 runtime 均已退出。
- Capacitor Android 平台已生成并完成 `cap sync`，`assembleDebug` 构建成功。
- `output/android/aura-preview.apk` 已验证包含 Capacitor Web 资源、Aura 应用代码、4 个本地字体、`classes.dex`、有效 APK 签名与预期网络权限。SHA-256：`19C762CE1C6494A67D27A4608F5D16EE3005384ECA096333C7638A1A023F8E19`。
- 验证结束后，4311、4173、8081 和 8082 均无监听，未保留 Aura Node 或 Electron 后台进程。

Codex 架构固定为 `Aura → DSH authorization/agent loop → dsh-llm-pi-ai → openai-codex`。Aura 后端没有直接实例化 pi-ai 客户端，前端响应与存储不包含 OAuth token。真实订阅调用仍需用户在界面完成 OpenAI 登录后验收；自动测试不会代替用户授权或消耗订阅额度。

## 迁移说明与边界

- 原生 Expo/React Native 入口、配置和依赖已从源码及 lockfile 移除；旧的忽略目录 `apps/mobile/android` 已移动到可恢复的 `.aura/legacy-expo-android`，当前位置由 Capacitor Android 工程替代。
- 工作区存储键仍为 `aura.workspace.v1`，因此浏览器端已有数据保持兼容。旧 Expo 应用沙箱内的 AsyncStorage 数据不会自动迁移到 Capacitor WebView 的 `localStorage`。
- Android 产物仍使用开发签名；iOS 已配置 Capacitor 入口，但本次 Windows 验证不包含 Xcode、IPA 或真机记录。
- 当前服务定位于本机或可信局域网使用，尚未包含生产级用户认证、多租户隔离与公网防护。
