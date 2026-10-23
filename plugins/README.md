# Aura 产品插件

这里存放随 Aura 发布的非基础能力插件。

| 目录              | 插件         | 页面与后端边界                                                                |
| ----------------- | ------------ | ----------------------------------------------------------------------------- |
| `site-launcher/`  | 站点启动     | Site 页面、命令/端口/进程管理；Electron 仅提供目录选择和预览窗口              |

基础宿主、运行时、公共 SDK 和共享协议继续放在 `packages/*`。正式产品插件不放在 `examples/`，也不直接导入宿主私有源码。

## 默认加载

开发态 runtime 默认递归发现 `<root>/plugins`。遇到 `aura.plugin.json` 后停止进入该插件内部，不跟随目录链接，并跳过隐藏目录及 `node_modules`、`dist`、`dist-host`、`runtime`。目录内插件是随产品交付的受信任代码，具有后端 Node.js 权限。

`.aura/plugins.json` 保留为外部插件目录及默认插件的启停/设置覆盖；显式条目按路径或插件 ID 优先，禁用插件不会被默认发现重新启用。启动和发现不写配置、不安装依赖、不执行构建。新插件在下次 runtime 启动或设置应用时发现；已加载插件继续沿用原有 HMR 和页面更新机制。

## 构建与分发

在根目录安装依赖，并按插件说明准备公共 SDK 等依赖。

- `pnpm run build:server` 构建插件并放入 `apps/server/dist/plugins/`，随服务端包发布；分发启动器从该目录加载插件，与 `--root` 指定的用户数据目录分开。
- `pnpm run build:desktop` 构建插件并放入 `apps/desktop/dist-host/plugins/`，随桌面包发布；开发模式继续加载源码 `plugins/`。
- `pnpm run build:plugins` 单独更新上述两份插件产物。

server/desktop 的 `pnpm pack` 会先执行应用构建，避免发布包遗漏尚未生成的插件资产。

各插件在 `package.json#files` 声明明确的相对文件或目录，不使用 glob。包含 manifest、ESM 后端及静态辅助资源、预构建页面入口。构建保留类别子目录，发布目录只复制声明资产并排除缓存、密钥、数据库、个人状态及开发依赖。SDK 由应用安装提供；插件新增其他运行依赖时也必须把可解析依赖纳入分发设计。

发布插件不会复制任何人的聊天记录或该工具运行时。

开发和检查遵循根 [AGENTS.md](../AGENTS.md)、[插件 JavaScript 规范](../docs/plugin-javascript-code-style.md) 和[插件开发技能](../.agents/skills/aura-plugin-development/SKILL.md)。
