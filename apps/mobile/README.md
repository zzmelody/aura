# @aura/mobile

Aura 的 Capacitor 移动应用壳。Vite 构建与浏览器、Electron 相同的 `@aura/workbench` React Web 界面，Capacitor 只提供 Android/iOS 容器和系统浏览器能力。

运行 `pnpm --filter @aura/mobile sync` 同步 Web 产物到原生工程；`android` 和 `ios` 命令会打开对应 IDE。移动真机不能内嵌 Node/DSH，需要在设置页连接电脑上的 Aura runtime。
