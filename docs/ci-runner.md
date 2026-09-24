# 本机 GitHub Actions runner

此配置适用于 Windows 11 上由 `zzmelody` 独自维护的私有仓库。`aura` 和 `Veya` 共用一个非管理员本地账号 `AuraCI` 和一个交互式桌面会话；GitHub 仍要求个人仓库各自注册一个 runner 实例。两个仓库分别使用标签 `zzmelody-aura-win` 和 `zzmelody-Veya-win`。

## 首次安装

1. 在管理员 PowerShell 中运行 `scripts/ci/windows/Initialize-Host.ps1`。脚本提示输入 `AuraCI` 的本地密码，不把密码写入仓库或脚本。它将账号加入普通 `Users` 组并要求密码，收紧 `F:\aura` 的 ACL，在 D/E/F 数据盘上为该账号设置拒绝访问规则，并建立 `C:\ci-runners` 与受保护的 `C:\ci-control`。原始目录 ACL 保存在后者的 `*.before.txt` 文件中。
2. 同一管理员 PowerShell 中分别运行 `C:\ci-control\Register-Repository.ps1 -Repository aura` 和 `C:\ci-control\Register-Repository.ps1 -Repository Veya`。脚本从当前 Windows 账号的 Git Credential Manager 读取 `zzmelody` 登录，核实仓库为私有且只有你一位协作者；随后下载 GitHub 官方 runner、校验发布资产 SHA-256、通过短期注册令牌配置 runner，并创建 `Aura-CI-aura`、`Aura-CI-Veya` 两个交互式计划任务。长期 GitHub 凭据不会复制到 CI 账号。
3. 重启或切换用户，登录 `AuraCI` 一次，再切回日常账号。不得为该账号设置自动登录。通过 `runas` 或 Task Scheduler 的非交互登录模式启动 Godot 图形作业并不等价于真实桌面会话。
4. `Enter-CiMode.ps1` 每次上线前都会在 `AuraCI` 的交互式会话里运行 `Aura-CI-AccessCheck`，确认该账号不是管理员，并且不能列出 `F:\aura`、`F:\aura\.aura`、D/E/F 盘和日常用户目录。检查结果保存在 `C:\ci-runners\access-check.json`；未通过时 runner 不会上线。首次登录后先查看这份结果，再执行首次 CI 作业。
5. Godot 4.7.2 的 Windows 可执行文件位于 `C:\ci-control\tools`，由日常账号管理，`AuraCI` 只有读取和执行权限。更新 Godot 时，将受信任的 `Godot_v4.7.2-stable_win64.exe` 和 `_console.exe` 复制到此目录并核对源文件与目标文件的 SHA-256；同时更新图形工作流中的版本路径。

以后加入另一私人仓库时，在已审核它仍只有你能写入的前提下运行 `Register-Repository.ps1 -Repository <name>`。每仓库有自己的 `C:\ci-runners\<name>` 工作目录和计划任务，但账号、桌面会话及 CI 模式入口相同。不要将公开仓库或有其他写入者的仓库加入此主机。

## 日常使用

在日常账号下运行 `C:\ci-control\Enter-CiMode.ps1` 上线所有 runner；运行 `Exit-CiMode.ps1` 等待作业结束并下线。两个入口调用 Windows 计划任务，可能需要管理员 PowerShell。`Enter-CiMode.ps1` 检查 Aura 默认端口 4311、ComfyUI 常用端口 8188、现有 Godot 与 Veya 进程、本机代理端口 7890 和 CI 账号的实际文件访问；其他携带凭据的本地服务也必须由操作者先关闭。`Run-Runner.ps1` 只给 runner 进程设置 `http://127.0.0.1:7890` 代理环境变量，不复制日常账号的代理配置或凭据。`Exit-CiMode.ps1` 会通过 GitHub API 确认作业不忙，停止计划任务及其残留的 runner 进程，并确认 GitHub 已显示 Offline，再允许启动这些服务。

主分支推送及手动触发都只在 `main` 上执行本机工作流。runner 离线时 GitHub 会排队，超过 24 小时会失败，需要手动重新运行。工作流使用只读 `GITHUB_TOKEN`、固定提交 SHA 的 Action，以及不保留 GitHub 凭据的 checkout。不要把个人 SSH 密钥、PAT、Aura 凭据或持久化的包仓库凭据放进 `AuraCI` 的用户目录。该账号能读到所有已注册个人仓库的 runner 工作目录和注册文件，因此这些仓库共用一个信任边界。

跨仓库 GPU 命令用 `C:\ci-control\Invoke-GpuLocked.ps1 -FilePath <program> -ArgumentList <args>` 包裹，在整个需要独占 GPU 的命令结束前持有主机级互斥锁。普通 CPU 检查不需要此锁。

## Godot 图形验收

在 GitHub 的 **Local CI → Run workflow** 中选择 `graphics_mode` 为 `switched` 或 `locked`。图形 job 进入 runner 后会等待 30 秒，然后运行 `scripts/ci/godot-probe` 的真实 Forward+ 场景。等待期间切回日常账号或锁屏。截图和报告分别写到 `C:\ci-runners\graphics-probe\<模式>.png` 与 `.json`。报告检查 640×360 像素、红蓝图案和 `NVIDIA GeForce RTX 4080` 适配器名称；切换用户和锁屏两次都通过才算后台图形验收。`foreground` 可作为前台排障基准。测试不要使用 `--headless`。若后台会话无法稳定渲染，只在 `AuraCI` 会话处于前台时运行图形作业；不要改为 Windows 服务来绕过失败。

## 故障处理

runner 默认自动更新。若怀疑工作流或依赖遭入侵，先退出 CI 模式，从对应仓库的 **Settings → Actions → Runners** 移除 runner，轮换它可能接触的凭据，清理其 Windows 用户目录及工作目录后重新注册。`C:\ci-control` 中的 ACL 备份用于调查和必要的恢复；不要直接恢复 D/E/F 盘的宽松继承权限而忽略 CI 账号访问。
