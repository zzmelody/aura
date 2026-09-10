# @aura/desktop

Aura 的 Windows/macOS/Linux Electron 桌面入口。Vite renderer 复用 `@aura/workbench` 的 React Web 界面；主进程提供受限本地静态服务器，并通过正式 workspace 依赖嵌入 `@aura/runtime`。退出桌面应用时会回收由它启动的服务。

在仓库根运行 `.\scripts\aura.ps1 run desktop`。命令先生成桌面 renderer，再打开原生窗口。Codex OAuth 始终交给 DSH；桌面壳只把授权页交给系统浏览器，不接触 token。

`package.json#main` 指向 Electron 的 `src/main.ts`；renderer 入口是 `src/renderer.tsx`，只由 Vite 构建。两者不得互相导入，确保 Node/DSH 后端依赖不会进入浏览器 bundle。
