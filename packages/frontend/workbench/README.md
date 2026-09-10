# @aura/workbench

浏览器、Electron 与 Capacitor 共用的 Aura React Web 工作台，包含界面、导航、交互状态、Web Storage 和 HTTP transport。应用只提供 React DOM 运行时及少量宿主能力；本包只依赖 frontend/shared 库，不读取后端凭据，也不启动 DSH。

移动端入口位于 `apps/mobile`，桌面端入口位于 `apps/desktop`。两端复用同一个 `App` 导出，平台启动、窗口和发布配置留在各自应用中。
