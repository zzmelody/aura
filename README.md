# Aura · 个人工作台

Aura 是独立应用项目，不是 DeepSeek Harness 源码副本。项目采用 Web-first 架构：同一套 `packages/frontend/workbench` React Web 界面分别由浏览器、Electron 和 Capacitor 输出。服务端把官方 DSH npm 包组合成应用自有 profile，不修改 DSH 或 pi-ai 源码。

## 当前能力

- 本地会话、历史恢复、逐字回复、停止、复制、失败重试，以及深浅色和减少动态效果。
- 工作流卡片浏览与内联节点预览、独立流程图/代码详情；运行在绑定工作流的会话中进行，步骤记录与结果随会话保存，支持拖拽节点和画布。
- 离线规则演示，以及通过官方 DSH profile 运行的服务端演示。
- 桌面版 Site 菜单：选择本机前端项目目录，识别开发脚本并在独立窗口运行本地预览。
- 右上角「登录 Codex」入口：由 DSH 的授权与凭据服务完成 OpenAI OAuth，登录后对话通过 DSH 的 `openai-codex` provider 使用 ChatGPT Plus/Pro 订阅。
- Vite 浏览器构建、Electron 桌面窗口、Capacitor Android/iOS 容器和 Android 内测包脚本。

当前未接入 Bedrock、日历、云同步和生产用户系统。

## 启动

需要 Node.js 24+。项目使用根 `packageManager` 固定的 pnpm 12.5.1 和一份根锁文件；Windows 辅助脚本会选择可用的 Node 24，并使用已忽略的 `.tools/pnpm` 本地工具。

首次安装 pnpm 工具与项目依赖：

```powershell
cd F:\aura
npm install --prefix .tools/pnpm pnpm@12.5.1
.\scripts\aura.ps1 install
```

启动浏览器开发应用：

```powershell
.\scripts\aura.ps1 run dev
```

该命令会同时启动 Aura runtime 与 Vite（`http://127.0.0.1:8081`），右上角登录按钮可以直接使用。单独调试服务时仍可运行：

```powershell
.\scripts\aura.ps1 run runtime
```

服务默认监听 `http://127.0.0.1:4311`。右上角点击「登录 Codex」，浏览器会进入 OpenAI 登录；手机或非本机页面使用设备码登录。桌面浏览器回到本机后会自动刷新状态；若本机回调被代理或浏览器拦截，可把浏览器最后停留的完整地址粘贴回登录窗口继续完成 DSH 授权。成功后 Aura 自动选择 Codex 模式，新对话采用 `gpt-6.1-sol`，可在启动服务前设置 `AURA_CODEX_MODEL` 更改。

启动桌面应用：

```powershell
.\scripts\aura.ps1 run desktop
```

桌面命令默认进入开发模式：启动 Vite（`http://127.0.0.1:8082`）、DSH runtime 并打开 Electron 窗口；应用退出时会回收它启动的本地服务。Web 与 Desktop 都会监听共享 React、CSS 和前端依赖，修改后自动更新。正常连接使用 React Fast Refresh；若内嵌浏览器的 Vite WebSocket 无法连接，开发客户端会通过同源 HTTP 每秒检查版本并自动刷新，隐藏标签页在切回时检查。自动整页刷新会从已保存的会话和草稿恢复，组件临时状态可能重置。

运行 `pnpm run desktop:preview` 可构建并查看静态桌面产物；它与 `pnpm run preview` 一样不监听源码。Electron 主进程、启动脚本和后端 TypeScript 修改仍需重启对应进程，工作流/Action 文件继续使用后端已有的热加载。Web 与 Desktop 固定使用 8081/8082；端口占用时明确报错，避免浏览器停留在另一个旧服务。

移动端在 `apps/mobile` 使用 Capacitor：

```powershell
.\scripts\aura.ps1 run mobile:sync
.\scripts\aura.ps1 --filter @aura/mobile run android
```

首次同步前可运行 `pnpm exec cap add android` 或 `pnpm exec cap add ios` 创建原生工程；Android 内测包脚本会在缺少工程时自动创建。真机连接需要在设置页填写电脑的局域网服务地址。

登录链路是 `Aura → DSH authorization → dsh-llm-pi-ai → openai-codex OAuth`；对话链路是 `Aura → dsh --profile aura-sdk → DSH agent loop → dsh-llm-pi-ai → Codex`。Aura 不直接调用 pi-ai，也不复用或复制 Codex 应用的登录缓存。DSH 将授权记录保存在已忽略的 `.aura/dsh/.credentials.yaml`，前端只接收脱敏状态。

同一局域网手机连接时，服务需显式以 `HOST=0.0.0.0` 启动，并在设置页填写电脑的局域网地址。当前服务没有生产鉴权，只能用于本机或可信局域网，不能直接发布到公网。

## 构建与验证

项目采用 Google TypeScript Style Guide 的 Aura 适配版，具体来源、适配项与检查命令见 [代码规范](docs/code-style.md)。新增或修改的文件使用 Prettier 统一格式，ESLint 检查 TypeScript 与 React Hook；`pnpm run check` 同时执行这些检查、工作区边界检查、类型检查和测试。本轮已清空历史格式与 Lint 基线；严格检查不再依赖历史豁免。

```powershell
.\scripts\aura.ps1 run check
.\scripts\aura.ps1 run build
.\scripts\aura.ps1 run preview
```

Web 预览地址是 `http://127.0.0.1:4173`；预览命令现在会同时启动 runtime，退出时一起清理。服务运行时可在另一个终端验证真实 DSH 演示链路：

```powershell
.\scripts\aura.ps1 run test:runtime
```

Android 内测包使用 `.\scripts\build-android.ps1`，输出位于 `apps/mobile/dist-android/aura-preview.apk`。浏览器、Electron renderer 与 Capacitor Web 产物分别位于 `apps/web/dist`、`apps/desktop/dist` 和 `apps/mobile/dist`。Windows 可以生成并同步 iOS Web 资源，但仍需在 macOS/Xcode 中产出 IPA。

## Monorepo 目录

```text
apps/
  web/         @aura/web：Vite 浏览器应用输出
  mobile/      @aura/mobile：Capacitor Android/iOS 应用输出
  desktop/     @aura/desktop：Vite renderer + Electron 桌面输出
  server/      @aura/server：Aura HTTP/DSH 服务入口
packages/
  frontend/
    ui/        @aura/ui：React DOM 组件、主题与设计变量
    workbench/ @aura/workbench：浏览器、Electron、Capacitor 共用界面
  backend/
    dsh-auth/  @aura/dsh-auth：DSH 授权与凭据适配
    runtime/   @aura/runtime：TypeScript 后端组合根与服务生命周期
    orchestration/ @aura/orchestration：Flow、Action、领域业务与产物
    extensions/ @aura/extensions：插件配置、发现与激活回滚
    plugin-sdk/ @aura/plugin-sdk：外部插件公共契约
    tripo/     @aura/tripo：3D 服务、任务与后端凭据
  shared/
    protocol/  @aura/protocol：请求、流事件与脱敏授权状态
    core/      @aura/core：会话、存储恢复与地址校验
    demo/      @aura/demo：无密钥规则回复
scripts/       根级运行、构建与依赖检查
tests/         仓库级工作区规则测试
```

放置和依赖规则见 [AGENTS.md](AGENTS.md)。简要规则是：可运行入口只放 `apps/*`，可复用库才放 `packages/*`；frontend 只依赖 frontend/shared，backend 只依赖 backend/shared，shared 只依赖 shared；任何 workspace 都不能导入应用；跨 workspace 只使用显式导出和 `workspace:*`。

仓库内置 [Aura 插件开发 skill](.agents/skills/aura-plugin-development/SKILL.md)，包含插件契约、JavaScript 编码规范和调用配置，随 Git 一起维护。开发 Aura 插件或插件宿主时按该 skill 执行；在 Codex 中可使用 `$aura-plugin-development` 调用。

完整入口见 [文档目录](docs/README.md) 与 [模块边界](docs/development/module-boundaries.md)。更多信息见 [架构](docs/architecture.md)、[后端 Runtime 技术方案](docs/development/backend-runtime.md)、[模型接入](docs/features/model-providers.md)、[主题规范](docs/development/design-system.md) 和 [当前验证](docs/verification.md)。
