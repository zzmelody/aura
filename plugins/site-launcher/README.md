# 站点启动插件

独立插件 ID 为 `site-launcher`，位于 `plugins/site-launcher/`，默认加载并随 server/desktop 发布。
贡献 Site 工作台页面。项目描述、命令启动、端口选择、进程归属验证和停止清理都由插件的 `runner` provider 持有；Electron 只提供原生目录选择和沙箱预览窗口。

页面仅调用自己的 describe/start/stop/status/open 操作。预览前由后端重新核实端口归属，原生窗口只接收本机 HTTP 地址。切换页面保留站点进程，停用插件或退出所属 runtime 会停止它启动的项目，不结束其他服务。

站点列表继续使用 `aura.sites.v2`、`aura.sites.selected.v1` 并兼容 `aura.site.v1`，不用重新添加原有项目；浏览器的目录选择仍只支持 Desktop。本次不迁移或改写 `.aura/plugins.json`。

从根目录运行 `pnpm run setup:product-plugins`、`pnpm run build:product-plugins`、`pnpm run check:product-plugins`。`backend/*.ts` 在构建期编译为 `backend/dist/site-runner.js` 及生成的类型声明，provider 运行入口保持 ESM JavaScript；前端构建为 `client/dist/client.js`。发布只包含声明资产，不包含站点源码、用户数据或开发依赖。
