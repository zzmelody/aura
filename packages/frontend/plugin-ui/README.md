# @aura/plugin-ui

Aura 插件的公开浏览器 SDK，提供 `definePage`、`defineResult`、页面/结果 props 和 Cordis `auraWorkbench` 服务类型。由工作台作为 DSH 浏览器种子模块注入；插件 bundle 将 React、React DOM 和本包设为 external，避免加载第二份运行时。后端能力使用独立的 `@aura/plugin-sdk`。

## 页面与结果

插件入口导出 `apply(ctx)`，通过 `ctx.auraWorkbench.page(definePage(...))` 与 `ctx.auraWorkbench.result(defineResult(...))` 注册。页面和结果 ID 由宿主加上 manifest 插件 ID 前缀，注册随所属 fiber 卸载。页面只能使用 props 中的 `invoke` 调用自己的后端操作。

## 界面语言（0.2）

入口先调用 `ctx.auraWorkbench.translations(catalogs)` 注册六语言平面目录，宿主自动放入 `plugin.<manifest-id>` namespace。英文是缺项回退语言。资源与注册 fiber 一同清理，替换 bundle 不残留旧键。

```tsx
import {
  definePage,
  usePluginTranslation,
  type Context,
} from "@aura/plugin-ui";

function Settings() {
  const { t } = usePluginTranslation("example.plugin");
  return <h1>{t("settingsTitle")}</h1>;
}

export function apply(ctx: Context) {
  ctx.auraWorkbench.translations({
    en: { settingsTitle: "Settings" },
    "zh-CN": { settingsTitle: "设置" },
  });
  ctx.auraWorkbench.page(
    definePage({
      id: "settings",
      title: "Settings",
      titleKey: "settingsTitle",
      render: () => <Settings />,
    }),
  );
}
```

`titleKey`、`descriptionKey` 是插件目录内的键；`title`、`description` 保留旧插件兼容与缺项回退。`usePluginTranslation<Key>()` 可配合导出的 `CatalogKey<typeof en>` 限制键名。Hook 返回 `t`、宿主 `i18n` 与 `ready`；日期、数字可通过 `Intl` 和 `i18n.resolvedLanguage` 格式化。

语言切换更新显示文字，不重新注册页面、重新挂载组件或执行后端请求。不要按语言设置页面 key，不翻译用户标题、保存的字段、ID、路径、脚本名或 AI 内容。第三方 aura-studio 位于独立仓库，旧页面定义可继续使用，新语言 API 需要宿主提供本版本。

从仓库根执行 `pnpm --filter @aura/plugin-ui run typecheck`。资源生命周期与真实 DSH 插件 bundle 的测试位于 workbench，产品插件通过 `pnpm run check:product-plugins` 检查。

## 保留异步错误（0.3）

公开 `MessageError`、`MessageReference`、`errorMessage(error, fallback?)` 和 `messageText(text, i18n?)` 与宿主使用同一个运行时。插件捕获错误时把 `errorMessage(error)` 的结果保存在临时 UI 状态中，渲染时调用 `messageText(text, i18n)`；`i18n` 来自 `usePluginTranslation()`。这使宿主 HTTP/原生操作错误在语言变化后更新，而不重新调用操作。错误引用不进入业务存储、Flow 输入或 AI 上下文。

旧插件仍可读取抛出时的可读 `Error.message`，普通第三方错误按原文显示。现有 0.2 页面接口保持可用；采用上述新增导出的外部 aura-studio 插件需要 `@aura/plugin-ui ^0.3.0` 及对应宿主，aura-studio 是独立仓库。产品 Site 和 Tripo 已接入，包构建继续将本 SDK 设为 external。
