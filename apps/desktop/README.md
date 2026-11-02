# @aura/desktop

桌面先创建窗口并加载 renderer，同时异步加载和启动本地 runtime；DSH 冷启动不阻塞窗口出现，API 自己报告就绪状态。退出时等待启动中的服务完成后统一关闭，避免在启动中关窗留下后台服务。

启动页直接写在 renderer HTML 中，使用本地 CSS 和 Canvas 显示紫色光核与轨道，不加载视频、字体或网络素材。轻量入口先启动动画，再动态加载 React 工作台；恢复本地状态并提交首屏后自动收起，不等待授权、工作空间、会话或模型请求，也不强制播放完整时长。本地服务在后台并行准备，底部显示准备状态，期间可导航和编辑在线草稿；缺少工作空间时禁止发送，演示模式在初始授权确认前禁止输入和发送，避免授权升级时误入演示。读取失败在对应区域提供错误与重试入口。可见的 Aura 侧栏图标作为收束目标，侧栏隐藏时淡出；系统和应用内「减少动态效果」设置均使用静态标记并省略退场动画。界面模块加载较慢时提供手动重新加载，模块或渲染失败时保留明确提示；退场和页面关闭都会回收画布、定时器及监听器。

Aura 的 Windows/macOS/Linux Electron 桌面入口。Vite renderer 复用 `@aura/workbench` 的 React Web 界面；主进程提供受限本地静态服务器，并通过正式 workspace 依赖嵌入 `@aura/runtime`。退出桌面应用时会回收由它启动的服务。

工作台在第一次成功读取后缓存公共模型目录和工作空间列表，之后重开窗口先恢复模型与工作空间选择，后台向服务校验。有缓存的新任务可在连接期间先提交，状态明确显示等待并支持停止；校验工作空间有效后才发出一次模型请求。首次没有缓存或已有会话的历史尚未读取时，仍需等待真实服务。该改动改善恢复与提交时间，不代表 DSH 或模型自身的冷启动已完成。

静态 renderer 的本机 HTTP 服务复用上次成功监听的端口，使 Chromium 的 origin、界面偏好与目录缓存能跨应用重启保留。端口号保存在 Electron `userData/Cache/renderer-port`，只是可丢弃的启动提示，不改写 `.aura/` 用户配置；端口占用时由系统另选空闲端口并更新提示，缓存损坏或不可写不阻止打开界面。开发模式继续使用 Vite 的固定端口。

主窗口默认 1360×860，使用 Electron 的 `titleBarStyle: hidden` 与 `titleBarOverlay` 将共用的应用菜单栏放入标题区；最小化、最大化与关闭保留原生控件。原生控件叠层使用透明底色，整条标题栏由 renderer 连续绘制，避免按钮区域与左侧顶栏出现色差或分界。macOS 使用 48px 标题区，红绿灯定位到 `{ x: 12, y: 17 }`；preload 仅将 `process.platform` 作为 `auraHost.os` 提供给界面。宽窗口将导航、当前页标题和工具页签放在同一行，侧栏收起时为原生按钮与导航预留左侧位置。其他系统保持原有标题栏尺寸。标题区留白可拖动窗口，菜单和导航按钮使用 no-drag。`window-host.ts` 仅接收主 frame 的深/浅色布尔设置，同步原生控件颜色。更改主进程或 preload 后需完全退出并重启桌面应用。实现依据 [Electron 自定义标题栏](https://www.electronjs.org/docs/latest/tutorial/custom-title-bar)。

在仓库根运行 `.\scripts\aura.ps1 run desktop`。命令先生成桌面 renderer，再打开原生窗口。Codex OAuth 始终交给 DSH；桌面壳只把授权页交给系统浏览器，不接触 token。

`package.json#main` 指向 Electron 的 `src/main.ts`；renderer 入口是 `src/renderer.tsx`，只由 Vite 构建。两者不得互相导入，确保 Node/DSH 后端依赖不会进入浏览器 bundle。

`pnpm desktop` 和 `pnpm desktop:preview` 都会先将 `src/preload.ts` 编译为 `dist-host/preload.cjs`，再由沙箱窗口加载。Electron 的沙箱 preload 不经过主进程的 TypeScript loader，不能直接加载 `.ts`/ESM。产物由 `build:preload` 生成并忽略提交；更改 preload 后需要完全退出并重启桌面应用。桥接加载失败时页面会提示「桌面连接未就绪」，不会误判成 Web 版。

侧栏 Site 使用桌面 preload 暴露的最小 IPC 能力选择本机目录、启动前端项目脚本和打开本地预览窗口。`pnpm desktop` 启动后，进入 Site →「选择目录」，选中包含 `package.json` 的目录，确认脚本和预览地址，再点击「运行项目」。主进程仅负责 Electron 对话框、IPC 和窗口；`@aura/runtime/site` 负责绝对目录、已存在脚本、本机 HTTP(S) 地址校验及进程生命周期。项目脚本是具有当前用户权限的受信任代码，请只运行可信项目；不会自动安装依赖。

启动前同时检查 IPv4/IPv6 loopback 端口。直接调用 `vite`、`next dev/start`、`ng serve`、`vue-cli-service serve` 的简单脚本会剥掉脚本里原有的 `--host`/`--port`，由 Aura 先从系统监听表选择可用端口，再把这个明确端口传给开发服务器并使用严格端口模式。复合命令、环境变量包装器及自定义脚本不盲目改写；冲突时拒绝启动，需同时调整脚本监听端口和预览地址。

识别输出中的本机 `Local:` / `listening` 地址以跟随开发服务器实际监听的端口；端口预检会把 `127.0.0.1`、`0.0.0.0` 和 IPv6 通配监听都视为占用。预览前同时要求 HTTP 响应成功和请求地址对应的监听端点属于本次启动的进程树；不接管、更不会结束已有的其他服务。手动打开也重新校验归属。macOS 使用 `ps` + `lsof`，Linux 使用 `ps` + `lsof`（缺失时回退 `ss`），Windows 使用 PowerShell 的 `Get-NetTCPConnection` 与进程查询；工具不可用时不会冒险打开。就绪超时保留「停止项目」，运行中禁止修改配置。停止/重启按顺序执行，POSIX 先结束进程组、必要时强制回收；退出应用等待清理完成。修改这些主进程逻辑后需完全退出，再运行 `pnpm desktop`。

交付文件定位支持任意本机目录中的已存在普通文件：绝对路径直接定位，相对路径按项目目录解析，支持 `..` 和文件符号链接；拒绝目录、不存在的文件和失效链接。定位只在系统文件管理器中选中文件，不会打开或执行文件，不需要按输出目录维护白名单。定位失败通过结构化 IPC 结果返回简短提示，preload 隐去 Electron 远程调用包装与底层异常。更改此逻辑后需完全退出并重启桌面应用。
