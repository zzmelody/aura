# Aura 产品插件

这里存放随 Aura 发布的产品插件。每个插件有独立目录。

| 目录             | 插件     | 说明                                                             |
| ---------------- | -------- | ---------------------------------------------------------------- |
| `site-launcher/` | 站点启动 | Site 页面、命令/端口/进程管理；Electron 仅提供目录选择和预览窗口 |

基础宿主、运行时、公共 SDK 和共享协议继续放在 `packages/*`。产品插件不直接导入宿主私有源码。

本目录不在 pnpm workspace（`pnpm-workspace.yaml` 只收 `apps/*` 与 `packages/*/*`）内，各插件自带 ESLint、Prettier 与 TypeScript 配置，依赖由下面的 `setup:product-plugins` 准备。放置与分发规则见 [项目结构 skill](../.agents/skills/aura-project-structure/SKILL.md)，编写插件代码见 [插件开发 skill](../.agents/skills/aura-plugin-development/SKILL.md)。

## 默认加载

开发态 runtime 默认递归发现 `<root>/plugins`。遇到 `aura.plugin.json` 后停止进入该插件内部，不跟随目录链接，并跳过隐藏目录及 `node_modules`、`dist`、`dist-host`、`runtime`。目录内插件是随产品交付的受信任代码，具有后端 Node.js 权限。

`.aura/plugins.json` 用于外部插件目录及默认插件的启停/设置覆盖；显式条目按路径或插件 ID 优先，禁用插件不会被默认发现重新启用。启动和发现不写配置、不安装依赖、不执行构建。

## 构建与分发

站点插件通过 `pnpm run setup:product-plugins` 准备开发链接，`pnpm run build:product-plugins` 构建，`pnpm run check:product-plugins` 检查。

- `pnpm run build:server` 构建插件并放入 `apps/server/dist/plugins/`。
- `pnpm run build:desktop` 构建插件并放入 `apps/desktop/dist-host/plugins/`。
- `pnpm run build:plugins` 单独更新上述两份插件产物。

各插件在 `package.json#files` 声明明确的相对文件或目录，不使用 glob。
