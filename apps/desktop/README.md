# @aura/desktop

桌面先创建窗口并加载 renderer，同时异步加载和启动本地 runtime；DSH 冷启动不阻塞窗口出现，API 自己报告就绪状态。退出时等待启动中的服务完成后统一关闭，避免在启动中关窗留下后台服务。

启动页直接写在 renderer HTML 中，使用本地 CSS 和 Canvas 显示紫色光核与轨道，不加载视频、字体或网络素材。轻量入口先启动动画，再动态加载 React 工作台；恢复本地状态并提交首屏后自动收起，不等待授权、工作空间、会话或模型请求，也不强制播放完整时长。本地服务在后台并行准备，底部显示准备状态，期间可导航和编辑在线草稿；缺少工作空间时禁止发送，演示模式在初始授权确认前禁止输入和发送，避免授权升级时误入演示。读取失败在对应区域提供错误与重试入口。可见的 Aura 侧栏图标作为收束目标，侧栏隐藏时淡出；系统和应用内「减少动态效果」设置均使用静态标记并省略退场动画。界面模块加载较慢时提供手动重新加载，模块或渲染失败时保留明确提示；退场和页面关闭都会回收画布、定时器及监听器。

Aura 的 Windows/macOS/Linux Electron 桌面入口。Vite renderer 复用 `@aura/workbench` 的 React Web 界面；主进程提供受限本地静态服务器，并通过正式 workspace 依赖嵌入 `@aura/runtime`。退出桌面应用时会回收由它启动的服务。

启动页和原生对话框使用 `@aura/i18n` 与应用自带的六语言词库 `src/locales/`。启动页在 React 加载前读取已有 `aura.language.v1` 偏好，包含标题、无障碍标签、加载状态和重新加载按钮；工作台就绪后接管页面标题。语言切换保留启动状态、画布和焦点。HTML 在 JavaScript 尚未执行时提供英文回退，不下载词库。

主进程先通过 Electron 的 [系统语言列表](https://www.electronjs.org/docs/latest/api/app#appgetpreferredsystemlanguages) 选择语言；工作台加载后通过 `language-bridge.ts` 同步有效 locale。`language-host.ts` 只接收已登记窗口、相同 origin 的主 frame，并在关窗时移除登记。语言仅保存在进程内存，不增加设置文件或改写 `.aura/`。文件选择框的自定义标题、确认按钮、图片过滤名称和应用启动/退出提示使用当前语言；操作系统提供的取消按钮等原生控件仍由系统本地化，已经打开的原生对话框在下一次打开时应用新语言。

路径选择、文件定位、站点预览和浏览器 IPC 通过 `native-errors.ts` 返回稳定错误码，preload 将失联等异常转换为安全回退码。结构化失败作为返回值穿过隔离桥接，不依赖 Electron 保留 Error 的自定义字段。renderer 的公开适配器恢复可读 Error 和实时翻译引用；未知系统异常、路径和远程调用包装不进入响应。`desktop-native-errors.test.ts` 使用合成 Electron 端口与隔离临时文件，验证错误码、来源/地址校验、标签上限与释放；`desktop-preload.test.ts` 验证沙箱 preload 不引入额外运行依赖。

根测试 `desktop-startup.test.ts` 验证启动/失败状态、保存偏好、回退和资源清理；`desktop-language.test.ts` 使用合成 Electron 端口验证桥接来源、语言值、取消和原始路径保留。`desktop-language-layout.test.ts` 使用真实 HTML/CSS/Canvas 与隔离 Chromium，在准确的 320px、360px 和宽视口中检查六语言及加长文案、焦点和文字边界，需要 `CHROME_BIN`；它不代替系统原生选择框的视觉验收。修改主进程或 preload 后需完全退出并重启桌面应用。

工作台在第一次成功读取后缓存公共模型目录和工作空间列表，之后重开窗口先恢复模型与工作空间选择，后台向服务校验。有缓存的新任务可在连接期间先提交，状态明确显示等待并支持停止；校验工作空间有效后才发出一次模型请求。首次没有缓存或已有会话的历史尚未读取时，仍需等待真实服务。该改动改善恢复与提交时间，不代表 DSH 或模型自身的冷启动已完成。

静态 renderer 的本机 HTTP 服务复用上次成功监听的端口，使 Chromium 的 origin、界面偏好与目录缓存能跨应用重启保留。端口号保存在 Electron `userData/Cache/renderer-port`，只是可丢弃的启动提示，不改写 `.aura/` 用户配置；端口占用时由系统另选空闲端口并更新提示，缓存损坏或不可写不阻止打开界面。开发模式继续使用 Vite 的固定端口。

主窗口默认 1360×860，使用 Electron 的 `titleBarStyle: hidden` 与 `titleBarOverlay` 将共用的应用菜单栏放入标题区；最小化、最大化与关闭保留原生控件。原生控件叠层使用透明底色，标题区留白可拖动窗口，菜单和导航按钮使用 no-drag。macOS 使用 48px 标题区，红绿灯定位到 `{ x: 12, y: 17 }`。宽窗口将导航、当前页标题和工具页签放在同一行，侧栏收起时为原生按钮与导航预留左侧位置。其他系统保持原有标题栏尺寸。`window-host.ts` 仅接收主 frame 的外观设置，同步原生材质外观或标题控件颜色。更改主进程或 preload 后需完全退出并重启桌面应用。实现依据 [Electron 自定义标题栏](https://www.electronjs.org/docs/latest/tutorial/custom-title-bar)。

macOS 宽窗口的会话列表使用原生 `sidebar` 毛玻璃和轻微渐变，右侧对话面板保持实色。应用切换主题时同步系统材质的外观，选择跟随系统时由 macOS 决定。最小化、隐藏或系统开启「减少透明度」时使用实色侧栏底，恢复窗口后重新附着原生材质。

在仓库根运行 `.\scripts\aura.ps1 run desktop`。命令先生成桌面 renderer，再打开原生窗口。Codex OAuth 始终交给 DSH；桌面壳只把授权页交给系统浏览器，不接触 token。

Windows 下，`pnpm desktop` 和 `pnpm desktop:preview` 首次启动会在 `dist-host/win32/` 生成并缓存 `Aura.exe` 及其运行时。可执行文件内嵌从现有 Aura 图标生成的 `assets/aura.ico`，任务管理器「进程」显示 Aura 和应用图标，「详细信息」显示 `Aura.exe`。Electron 或图标更新后会生成新的副本。实现依据 [Electron 应用品牌定制](https://www.electronjs.org/docs/latest/tutorial/application-distribution#rebranding-with-downloaded-binaries)。

macOS 下，两个命令由 `scripts/desktop-bundle.ts` 把 `Electron.app` 复制为 `dist-host/Aura.app`，修改 Dock 和应用切换器使用的 bundle 名称及 bundle ID，再本地 ad-hoc 重签。复制在 APFS 上用克隆完成，按 Electron 版本和修订号缓存。Linux 直接使用原版 Electron。Windows 和 macOS 均使用本地副本，Electron 用户数据路径仍由桌面包的 `package.json` 决定。

`package.json#main` 指向 Electron 的 `src/main.ts`；renderer 入口是 `src/renderer.tsx`，只由 Vite 构建。两者不得互相导入，确保 Node/DSH 后端依赖不会进入浏览器 bundle。

`pnpm desktop` 和 `pnpm desktop:preview` 都会先将 `src/preload.ts` 编译为 `dist-host/preload.cjs`，再由沙箱窗口加载。Electron 的沙箱 preload 不经过主进程的 TypeScript loader，不能直接加载 `.ts`/ESM。产物由 `build:preload` 生成并忽略提交；更改 preload 后需要完全退出并重启桌面应用。桥接加载失败时页面会提示「桌面连接未就绪」，不会误判成 Web 版。

桌面工具面板的浏览器标签使用 Electron 沙箱网页。主进程只允许工作台为自己的标签创建一次性网页实例。与 DSH Desktop 一致，同一工作空间目录的标签共享一个内存存储分区（Cookie 与站点数据），不同工作空间互相隔离；分区在应用退出时释放，不写入磁盘。网页实例通过 `about:blank#<lease>` 首页与一次性租约绑定，不注入 Aura 桥接，并拒绝访问 Aura 工作台和本机运行时端口。切换标签或会话保留页面；关闭标签只释放该实例，站点数据保留到应用退出。

侧栏 Site 使用桌面 preload 暴露的最小 IPC 能力选择本机目录、启动前端项目脚本和打开本地预览窗口。`pnpm desktop` 启动后，进入 Site →「选择目录」，选中包含 `package.json` 的目录，确认脚本和预览地址，再点击「运行项目」。主进程仅负责 Electron 对话框、IPC 和窗口；`@aura/runtime/site` 负责绝对目录、已存在脚本、本机 HTTP(S) 地址校验及进程生命周期。项目脚本是具有当前用户权限的受信任代码，请只运行可信项目；不会自动安装依赖。

启动前同时检查 IPv4/IPv6 loopback 端口。直接调用 `vite`、`next dev/start`、`ng serve`、`vue-cli-service serve` 的简单脚本会剥掉脚本里原有的 `--host`/`--port`，由 Aura 先从系统监听表选择可用端口，再把这个明确端口传给开发服务器并使用严格端口模式。复合命令、环境变量包装器及自定义脚本不盲目改写；冲突时拒绝启动，需同时调整脚本监听端口和预览地址。

识别输出中的本机 `Local:` / `listening` 地址以跟随开发服务器实际监听的端口；端口预检会把 `127.0.0.1`、`0.0.0.0` 和 IPv6 通配监听都视为占用。预览前同时要求 HTTP 响应成功和请求地址对应的监听端点属于本次启动的进程树；不接管、更不会结束已有的其他服务。手动打开也重新校验归属。macOS 使用 `ps` + `lsof`，Linux 使用 `ps` + `lsof`（缺失时回退 `ss`），Windows 使用 PowerShell 的 `Get-NetTCPConnection` 与进程查询；工具不可用时不会冒险打开。就绪超时保留「停止项目」，运行中禁止修改配置。停止/重启按顺序执行，POSIX 先结束进程组、必要时强制回收；退出应用等待清理完成。修改这些主进程逻辑后需完全退出，再运行 `pnpm desktop`。

交付文件定位支持任意本机目录中的已存在普通文件：绝对路径直接定位，相对路径按项目目录解析，支持 `..` 和文件符号链接；拒绝目录、不存在的文件和失效链接。定位只在系统文件管理器中选中文件，不会打开或执行文件，不需要按输出目录维护白名单。定位失败通过结构化 IPC 结果返回简短提示，preload 隐去 Electron 远程调用包装与底层异常。更改此逻辑后需完全退出并重启桌面应用。
