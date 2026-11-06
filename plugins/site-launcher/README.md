# 站点启动插件

插件 manifest 的 `localization` 提供中英日韩俄法名称与说明，要求 `@aura/plugin-sdk ^2.6.0`。宿主在页面 bundle 加载前或插件停用时也能显示这些文本；原插件 ID、名称字段、配置与存储不变。

独立插件 ID 为 `site-launcher`，位于 `plugins/site-launcher/`，默认加载并随 server/desktop 发布。
贡献 Site 工作台页面。项目描述、命令启动、端口选择、进程归属验证和停止清理都由插件的 `runner` provider 持有；Electron 只提供原生目录选择和沙箱预览窗口。

页面仅调用自己的 describe/start/stop/status/open 操作。预览前由后端重新核实端口归属，原生窗口只接收本机 HTTP 地址。切换页面保留站点进程，停用插件或退出所属 runtime 会停止它启动的项目，不结束其他服务。

页面文案使用 `client/src/locales` 中的中英日韩俄法资源，通过 `@aura/plugin-ui` 跟随宿主语言；计数遵循当前语言复数和数字格式。切换语言保留项目名、路径、启动脚本、预览地址、输出与运行进程。

后端运行状态通过可选 `messageDetails`、`portDetails` 提供语义码和受限参数，保留旧 `message`、`portMessage` 字段。`shared/status-messages.ts` 由插件拥有，校验端口、脚本、退出码/信号和本机预览地址，只投影声明字段；未知描述符回退原文，不把底层诊断作为翻译参数。UI 在渲染时翻译端口检查、启动/停止、退出和预览状态，不改启动命令、进程归属检查、取消、重试或持久化项目格式。词库不影响终端输出。

`test/site.test.ts` 验证真实本机测试进程、端口与兼容文本/语义码；`test/status-messages.test.ts` 验证参数边界和无效输入不启动进程。根 `plugin-language-layout.test.ts` 用合成状态检查六语言及加长文本的 320px、360px、宽容器布局，状态/端口提示翻译而原始输出、输入节点和项目存储保持不变。长状态说明允许在窄容器内换行。

页面要求 `@aura/plugin-ui ^0.3.0`；目录选择与启动/停止/预览失败保留公开 SDK 的消息引用，在渲染时翻译。目录选择失败在页面显示，用户再次选择或取消时清除旧提示。语言变化不重复执行项目操作、不重启状态订阅，也不将错误写入已保存项目。

站点列表继续使用 `aura.sites.v2`、`aura.sites.selected.v1` 并兼容 `aura.site.v1`，不用重新添加原有项目；浏览器的目录选择仍只支持 Desktop。本次不迁移或改写 `.aura/plugins.json`。

页面以自己的 `site-page` 容器宽度切换布局，窗口缩放和宿主侧栏拖宽都会响应。窄区域将项目列表、详情与配置区改为纵向排列，更窄时将概览数字放到标题下方，页面内部滚动始终贴右边缘。`test/responsive-layout.test.ts` 使用合成项目验证宽窗口内插件区域收窄、重新展开及无横向溢出，不启动站点进程。

页面图标继承宿主已加载的 `@aura/ui/icons.css`。Lucide 默认沿用共享描边，空详情使用 `aura-icon--display aura-icon--muted` 表达大号辅助图标；图标颜色和线宽跟随 Aura 的公开 CSS 变量。完整用法见 [图标规范](../../docs/development/design-system.md#图标)。

从根目录运行 `pnpm run setup:product-plugins`、`pnpm run build:product-plugins`、`pnpm run check:product-plugins`。`backend/*.ts` 在构建期编译为 `backend/dist/site-runner.js` 及生成的类型声明，provider 运行入口保持 ESM JavaScript；前端构建为 `client/dist/client.js`。发布只包含声明资产，不包含站点源码、用户数据或开发依赖。
