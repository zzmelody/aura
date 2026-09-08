# @aura/workbench

移动端与桌面端共用的 Aura 工作台界面、导航、交互状态和 HTTP transport。应用负责提供 React Native、Expo 模块与字体；本包只依赖 frontend/shared 库，不读取后端凭据，也不启动 DSH。

移动端入口位于 `apps/mobile`，桌面端入口位于 `apps/desktop`。两端复用同一个 `App` 导出，平台启动、窗口和发布配置留在各自应用中。
