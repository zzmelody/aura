# @aura/mobile

Aura 的 Expo 移动应用入口，输出 Web、Android 与 iOS 资源。界面来自 `@aura/workbench`，本目录只保留应用清单、原生配置、图标、入口与发布脚本。

在仓库根运行 `.\scripts\aura.ps1 run mobile` 启动原生开发服务，或运行 `.\scripts\aura.ps1 run dev` 同时启动 Web 和 Aura runtime。移动真机不能直接运行 Node/DSH，需要在设置页连接电脑上的 Aura runtime。
