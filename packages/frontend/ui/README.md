# @aura/ui

Aura React Web 的基础组件、DOM 原语和主题。组件从 `@aura/ui/components` 导入，颜色、字体、间距和动效参数从 `@aura/ui/theme` 导入；保留现有的紧凑布局词汇，但最终只渲染标准 HTML/SVG。应用负责提供 React、React DOM 和 Lucide peer dependencies。

本包不访问会话存储、不调用模型，也不引用 backend。公开 TS/TSX 源码由客户端编译器处理，不能当作 Node 服务模块运行；小程序需要单独的界面适配。检查入口为 `pnpm --filter @aura/ui typecheck`，视觉规范见 [主题规范](../../../docs/development/design-system.md)。
