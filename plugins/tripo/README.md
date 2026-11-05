# Tripo 3D

随 Aura 发布的插件 `aura.tripo` 提供 `/tripo` HTTP API、三项 Actions 和插件私有的付费账本。HTTP adapter 将请求转给同一个插件后端，后端通过官方 Tripo v3 SDK 执行并投影结果。

在「设置 → 插件 → Tripo 3D」可保存 Key、地区和预算，并测试连接。接口和 Action ID 见 [Tripo 3D 接入](../../docs/features/tripo.md)。从仓库根运行 `pnpm run check:product-plugins` 检查和构建插件。测试使用模拟上游。

ESLint 配置显式以插件目录作为 `tsconfigRootDir`，支持插件独立检查及宿主全仓检查，避免多个配置同时加载时根目录推断冲突。
