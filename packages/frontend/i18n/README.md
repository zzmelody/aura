# @aura/i18n

Aura Web、Electron renderer 与 Capacitor 共用的界面语言运行时，使用 i18next 与 react-i18next。支持 `zh-CN`、`en`、`ja`、`ko`、`ru`、`fr`；资源随构建发布，不依赖翻译服务或联网下载。

## 公共入口

- `@aura/i18n`：`LanguageProvider`、`useLanguage()`、`useMessages<Key>(namespace)`。根 Provider 更新文档 `lang`，监听系统语言与跨窗口偏好变化；切换语言不通过 React key 重建页面。
- `@aura/i18n/runtime`：`language`、`createLanguageController`、`registerCatalogs`、语言列表与匹配、`formatDate` / `formatNumber` / `formatRelativeTime`、`MessageReference`、`messageText`、`MessageError` 与 `errorMessage`。
- `@aura/i18n/catalogs`：目录类型、`CatalogKey`、结构校验、`auditCatalogs` 和 `pseudolocalize`。

`LanguagePreference` 为六个语言代码或 `system`。默认根据 `navigator.languages` 按顺序匹配；地区变体归并到上述语言，无支持项时使用英文。中文地区变体统一使用简体中文。翻译缺项回退到英文；插件页面的旧标题可另外提供 `defaultValue`。

语言偏好独立保存在 `aura.language.v1`。仅 `select()` 响应用户选择时写入；恢复、系统语言变化和初始化只读，存储失败仍允许当前窗口切换并报告 `saveError`。不迁移工作区、插件、模型配置或 `.aura/`，不改写对话正文或历史。

## 消息与格式

目录是语义键到字符串的平面映射。完整句子使用插值，避免通过连接片段组装句子。列表数量使用 i18next 的 CLDR 复数后缀，例如 `files_one`、`files_other`；俄语另有 `few`、`many`，日语和韩语仅需 `other`。调用时使用基础键与数值 `count`，显示数字可写为 `{{count, number}}`。

`useMessages` 保留 react-i18next 的语言订阅与 t 函数，同时返回控制器的稳定 `i18n` 实例，供资源所有者和 Effect 依赖使用，避免语言包装对象变化导致重复读取。需要长时间保留的通知、错误或状态保存消息引用/键，在渲染时翻译。用户标题、路径、模型名、终端输出、AI 回复保持原值。React 负责文本转义，不把翻译或插值内容作为 HTML 注入。

格式化函数默认使用当前语言，也可显式传入语言。时区、币种由调用方指定；界面语言不改变实际时刻、时区或金额。

本地异步校验可抛出 `MessageError(messageReference)`，用 `errorMessage(error, fallback)` 提取并保留消息引用。引用的插值可包含其他引用，例如“发送失败：{{reason}}”；`messageText` 在渲染时用同一个语言实例解析整句和原因。普通 `Error.message` 和用户文本保持原文。该类型用于前端展示状态，不作为后端协议或持久化格式。

`MessageError` 接受标准 `ErrorOptions`，保留 `cause`；其 `message` 是抛出时当前语言的可读文本，兼容仍只读取 `Error.message` 的调用方。需要在语言切换后更新的界面必须保存 `errorMessage` 返回的引用，而非该文本快照。错误分支依据类型、状态码或引用键判断，不匹配翻译后的句子。

`registerCatalogs` 先验证再替换整个 namespace，返回带所有权的清理函数。重新注册会移除旧键和已删除的语言；旧实例的延迟清理不会删除新资源。插件通过公开 `@aura/plugin-ui` 注册与使用资源，不自行创建 i18next 实例。

## 检查

插件后端的受限错误译文可保存在 `MessageReference.translations`。`messageText` 根据同一个 i18next 实例的当前语言选择字面文本，缺项回退英文；不执行插值或 HTML，不注册长生命周期的动态词库。引用只留在前端显示状态，后端协议验证大小和语言键。

从仓库根执行 `pnpm --filter @aura/i18n run typecheck`、`pnpm --filter @aura/i18n run test`。测试覆盖系统语言匹配、持久化边界、英文回退、俄语复数、资源替换/卸载、时间与金额、占位符检查和伪本地化。

`auditCatalogs` 用于发布前检查完整语言目录、各语言所需复数形式和插值变量一致性。它不改变运行时允许第三方插件只提供部分语言并使用英文回退的行为。
