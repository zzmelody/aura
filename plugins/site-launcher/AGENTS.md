# 站点启动插件

遵循[外部插件 JavaScript 规范](../../docs/plugin-javascript-code-style.md)。迁移来的源码保留 Aura 的双引号，依赖继续使用仓库唯一的 pnpm lockfile。后端入口 `backend/index.ts` 与 runner 一起在发现之前构建为 `backend/dist/index.js`（ESM）。启动阶段不构建、不安装依赖。

职责边界：

- 项目描述、启动、端口与进程校验、清理都归本插件。Electron 只提供目录选择和预览窗口。
- 保留现有的站点存储键，不改写用户数据。
- 只停止属于本 runner 的进程。插件后端关闭时停止自己启动的项目；页面切换不停止项目。

从仓库根运行 `pnpm run check:product-plugins`。
