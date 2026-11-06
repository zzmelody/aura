# Tripo 3D

插件 manifest 的 `localization` 提供中英日韩俄法说明及三个 Action 的标题与说明，要求 `@aura/plugin-sdk ^2.6.0`。宿主在页面 bundle 加载前读取；品牌名、原贡献 ID、执行描述、参数和模型提示词保持不变。

随 Aura 发布的插件 `aura.tripo` 提供 `/tripo` HTTP API、三项 Actions 和插件私有的付费账本。HTTP adapter 将请求转给同一个插件后端，后端通过官方 Tripo v3 SDK 执行并投影结果。

在「设置 → 插件 → Tripo 3D」可保存 Key、地区和预算，并测试连接。接口和 Action ID 见 [Tripo 3D 接入](../../docs/features/tripo.md)。从仓库根运行 `pnpm run check:product-plugins` 检查和构建插件。测试使用模拟上游。

设置页面通过 `@aura/plugin-ui` 注册中英日韩俄法资源并跟随宿主语言，页面标题和说明使用翻译键。成功提示在显示时翻译，切换语言不重建表单、不保存凭据、不验证连接、不产生付费请求。已知错误码使用插件词条；旧后端错误暂保留原文。

页面要求 `@aura/plugin-ui ^0.3.0`，通过公开的消息提取/渲染接口保留宿主调用失败；已出现的错误随语言更新，不重新读取设置或重发保存。普通后端消息继续沿用插件词条和原文兼容。

ESLint 配置显式以插件目录作为 `tsconfigRootDir`，支持插件独立检查及宿主全仓检查，避免多个配置同时加载时根目录推断冲突。
