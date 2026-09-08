# @aura/desktop

Aura 的 Windows/macOS/Linux Electron 桌面入口。渲染层复用 `@aura/workbench`，主进程提供受限本地静态服务器，并通过正式 workspace 依赖嵌入 `@aura/runtime`；退出桌面应用时会回收由它启动的服务。

在仓库根运行 `.\scripts\aura.ps1 run desktop`。命令先生成桌面 renderer，再打开原生窗口。Codex OAuth 始终交给 DSH；桌面壳只把授权页交给系统浏览器，不接触 token。
