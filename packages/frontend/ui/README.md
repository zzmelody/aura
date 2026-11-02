# @aura/ui

Aura React Web 的基础组件、DOM 原语和主题。组件从 `@aura/ui/components` 导入，颜色、字体、间距和动效参数从 `@aura/ui/theme` 导入；保留现有的紧凑布局词汇，但最终只渲染标准 HTML/SVG。应用负责提供 React、React DOM 和 Lucide peer dependencies。

深浅主题统一使用 Aura 紫色系：强调色用于链接与当前状态，紫色主按钮搭配白色文字，悬停、选中、用户气泡与光晕沿用柔紫色。参照外部产品调整布局时，保留这套品牌配色。

深色主题的正文、次级与辅助文字依次使用柔和灰白与两级灰色，适合长时间阅读；这些色阶由 `palettes.dark` 统一提供给宿主与插件。正文、小字与标签的基础字重为 400，界面的默认强调与标题为 600，具体组件可使用 500 等中间层次；系统字体在 macOS 使用灰度抗锯齿。`tooltipText` 为两种主题中的深色提示气泡提供同一档柔和灰白，输入框占位文字默认使用 `muted`。

`Button` 与 `IconButton` 提供明确的主题样式类，工作台据此统一原生与共享按钮的悬停、按下、选中及焦点效果。`Switch` 的轨道颜色保留为背景色，让主题渐变可以叠加；禁用、`aria-checked` 和滑块位置继续由原组件持有，不更改切换行为。

图标样式从公开入口 `@aura/ui/icons.css` 导入。Aura 宿主已经加载一次，插件页面与结果视图自动继承；独立使用本包的界面在入口导入该 CSS。Lucide 和 `svg.aura-icon` 默认使用 1.6 描边、圆端点和圆连接，颜色跟随父级；普通按钮沿用 `secondary`，辅助图标使用 `aura-icon--muted`，选中和进度使用 `aura-icon--accent`。`aura-icon--emphasis` 为主要操作提供 1.8 描边，`aura-icon--display` 为大号占位图标提供 1.25 描边，`aura-icon--filled` 使用零描边。显式的 `aura-icon--custom` 保留自有图形参数。

尺寸类 `aura-icon--xs/sm/md/lg` 分别为 12/14/16/20px，已有 `size` 属性可继续用于其他尺寸。颜色类还包括 `--secondary`、`--text`、`--danger`、`--success` 和 `--on-primary`（均带 `aura-icon` 前缀）。这些工具类与 `--aura-icon-*` 变量的完整约定、插件示例和例外见 [图标规范](../../../docs/development/design-system.md#图标)。

本包不访问会话存储、不调用模型，也不引用 backend。公开 TS/TSX 源码由客户端编译器处理，不能当作 Node 服务模块运行；小程序需要单独的界面适配。检查入口为 `pnpm --filter @aura/ui typecheck`，视觉规范见 [主题规范](../../../docs/development/design-system.md)。
