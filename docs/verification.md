# 验证记录

日期：2026-09-08，Windows 本地环境。自动验证不使用真实 Codex 账号或 API Key。

## 当前 Monorepo 回归

- pnpm 10.17.1 完成依赖安装并生成唯一的 `pnpm-lock.yaml`；workspace 包位于 `packages/frontend/*`、`packages/backend/*` 与 `packages/shared/*`。
- 工作区检查覆盖分层元数据、依赖方向、`workspace:*`、显式导出、未声明依赖、跨包相对导入、应用被依赖和依赖环。
- 7 个 Aura workspace 通过严格类型检查。
- 14 项自动测试通过，覆盖协议校验、工作区规则、禁止 Aura 直接依赖 pi-ai、会话恢复、离线流式回复、HTTP 请求处理，以及 DSH Codex OAuth flow 的注册与脱敏登录状态。
- 后端运行时通过真实 `dsh --profile aura-sdk` 进程完成两轮流式演示，并拒绝非法请求。该测试验证 Aura 沿 DSH SDK、agent loop 和 session events 工作，不代表真实 Codex 模型调用。
- Expo 网页构建通过，字体作为本地资源导出。
- Playwright 在 Edge 中检查 390px 与 1280px 页面，右上角 Codex 入口可见且没有布局溢出；浏览器控制台错误与警告均为 0。验证没有点击登录按钮，因此没有启动账号授权。

Codex 架构固定为 `Aura → DSH authorization/agent loop → dsh-llm-pi-ai → openai-codex`。Aura 后端没有直接实例化 pi-ai 客户端，前端响应与存储不包含 OAuth token。真实订阅调用仍需用户在右上角完成 OpenAI 登录后验收；自动测试不会代替用户授权或消耗订阅额度。

## 既有客户端验证

在目录重组前，同一客户端功能曾完成 Android release APK 构建与 v2 签名校验、Expo Android/iOS Hermes 资源导出，以及 Edge 中 320px、390px 与 1280px 布局验证。浏览器流程覆盖两轮回复、停止、重试、主题切换、刷新恢复、删除确认和错误恢复。目录重组不改变 `aura.workspace.v1` 存储格式。

这些结果不等于生产验收：Android 仍使用开发签名，iOS 没有 IPA 或真机记录，服务也没有生产用户认证、多租户隔离与公网防护。
