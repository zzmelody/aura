# @aura/desktop

Aura 的 Windows/macOS/Linux Electron 桌面入口。Vite renderer 复用 `@aura/workbench` 的 React Web 界面；主进程提供受限本地静态服务器，并通过正式 workspace 依赖嵌入 `@aura/runtime`。退出桌面应用时会回收由它启动的服务。

在仓库根运行 `.\scripts\aura.ps1 run desktop`。命令先生成桌面 renderer，再打开原生窗口。Codex OAuth 始终交给 DSH；桌面壳只把授权页交给系统浏览器，不接触 token。

`package.json#main` 指向 Electron 的 `src/main.ts`；renderer 入口是 `src/renderer.tsx`，只由 Vite 构建。两者不得互相导入，确保 Node/DSH 后端依赖不会进入浏览器 bundle。

`pnpm desktop` 和 `pnpm desktop:preview` 都会先将 `src/preload.ts` 编译为 `dist-host/preload.cjs`，再由沙箱窗口加载。Electron 的沙箱 preload 不经过主进程的 TypeScript loader，不能直接加载 `.ts`/ESM。产物由 `build:preload` 生成并忽略提交；更改 preload 后需要完全退出并重启桌面应用。桥接加载失败时页面会提示「桌面连接未就绪」，不会误判成 Web 版。

侧栏 Site 使用桌面 preload 暴露的最小 IPC 能力选择本机目录、启动前端项目脚本和打开本地预览窗口。`pnpm desktop` 启动后，进入 Site →「选择目录」，选中包含 `package.json` 的目录，确认脚本和预览地址，再点击「运行项目」。主进程仅负责 Electron 对话框、IPC 和窗口；`@aura/runtime/site` 负责绝对目录、已存在脚本、本机 HTTP(S) 地址校验及进程生命周期。项目脚本是具有当前用户权限的受信任代码，请只运行可信项目；不会自动安装依赖。

启动前同时检查 IPv4/IPv6 loopback 端口。直接调用 `vite`、`next dev/start`、`ng serve`、`vue-cli-service serve` 的简单脚本会剥掉脚本里原有的 `--host`/`--port`，由 Aura 先从系统监听表选择可用端口，再把这个明确端口传给开发服务器并使用严格端口模式。复合命令、环境变量包装器及自定义脚本不盲目改写；冲突时拒绝启动，需同时调整脚本监听端口和预览地址。

识别输出中的本机 `Local:` / `listening` 地址以跟随开发服务器实际监听的端口；端口预检会把 `127.0.0.1`、`0.0.0.0` 和 IPv6 通配监听都视为占用。预览前同时要求 HTTP 响应成功和请求地址对应的监听端点属于本次启动的进程树；不接管、更不会结束已有的其他服务。手动打开也重新校验归属。macOS 使用 `ps` + `lsof`，Linux 使用 `ps` + `lsof`（缺失时回退 `ss`），Windows 使用 PowerShell 的 `Get-NetTCPConnection` 与进程查询；工具不可用时不会冒险打开。就绪超时保留「停止项目」，运行中禁止修改配置。停止/重启按顺序执行，POSIX 先结束进程组、必要时强制回收；退出应用等待清理完成。修改这些主进程逻辑后需完全退出，再运行 `pnpm desktop`。
