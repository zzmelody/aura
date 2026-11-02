# 站点启动插件

独立插件 ID 为 `site-launcher`，位于 `plugins/site-launcher/`，默认加载并随 server/desktop 发布。
贡献 Site 工作台页面。项目描述、命令启动、端口选择、进程归属验证和停止清理都由插件的 `runner` provider 持有；Electron 只提供原生目录选择和沙箱预览窗口。

页面仅调用自己的 describe/start/stop/status/open 操作。预览前由后端重新核实端口归属，原生窗口只接收本机 HTTP 地址。切换页面保留站点进程，停用插件或退出所属 runtime 会停止它启动的项目，不结束其他服务。

站点列表继续使用 `aura.sites.v2`、`aura.sites.selected.v1` 并兼容 `aura.site.v1`，不用重新添加原有项目；浏览器的目录选择仍只支持 Desktop。本次不迁移或改写 `.aura/plugins.json`。

页面以自己的 `site-page` 容器宽度切换布局，窗口缩放和宿主侧栏拖宽都会响应。窄区域将项目列表、详情与配置区改为纵向排列，更窄时将概览数字放到标题下方，页面内部滚动始终贴右边缘。`test/responsive-layout.test.ts` 使用合成项目验证宽窗口内插件区域收窄、重新展开及无横向溢出，不启动站点进程。

页面图标继承宿主已加载的 `@aura/ui/icons.css`。Lucide 默认沿用共享描边，空详情使用 `aura-icon--display aura-icon--muted` 表达大号辅助图标；图标颜色和线宽跟随 Aura 的公开 CSS 变量。完整用法见 [图标规范](../../docs/development/design-system.md#图标)。

从根目录运行 `pnpm run setup:product-plugins`、`pnpm run build:product-plugins`、`pnpm run check:product-plugins`。`backend/*.ts` 在构建期编译为 `backend/dist/site-runner.js` 及生成的类型声明，provider 运行入口保持 ESM JavaScript；前端构建为 `client/dist/client.js`。发布只包含声明资产，不包含站点源码、用户数据或开发依赖。
