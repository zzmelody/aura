# Aura · 个人工作台

Aura 是独立应用项目，不是 DeepSeek Harness 源码副本。`apps/mobile` 输出 Web、Android 和 iOS 应用，`apps/desktop` 输出 Electron 桌面应用；两端复用 `packages/frontend/workbench` 的 React Native 界面。服务端把官方 DSH npm 包组合成应用自有 profile，不修改 DSH 或 pi-ai 源码。

## 当前能力

- 本地会话、历史恢复、逐字回复、停止、复制、失败重试，以及深浅色和减少动态效果。
- 离线规则演示，以及通过官方 DSH profile 运行的服务端演示。
- 右上角「登录 Codex」入口：由 DSH 的授权与凭据服务完成 OpenAI OAuth，登录后对话通过 DSH 的 `openai-codex` provider 使用 ChatGPT Plus/Pro 订阅。
- Web 导出、Electron 桌面窗口、原生 JS 资源导出和 Android 内测包脚本。

Bedrock 保持空白；当前没有图片生成、日历、云同步或生产用户系统。

## 启动

需要 Node.js 24+。项目使用 pnpm 10 和一份根锁文件；Windows 辅助脚本会选择可用的 Node 24，并使用已忽略的 `.tools/pnpm` 本地工具。

首次安装 pnpm 工具与项目依赖：

```powershell
cd F:\aura
npm install --prefix .tools/pnpm pnpm@10.17.1
.\scripts\aura.ps1 install
```

启动 Web 开发应用：

```powershell
.\scripts\aura.ps1 run dev
```

该命令会同时启动 Aura runtime 与 `http://localhost:8081`，右上角登录按钮可以直接使用。单独调试服务时仍可运行：

```powershell
.\scripts\aura.ps1 run runtime
```

服务默认监听 `http://127.0.0.1:4311`。右上角点击「登录 Codex」，浏览器会进入 OpenAI 登录；手机或非本机页面使用设备码登录。成功后 Aura 自动选择 Codex 模式，新对话采用 `gpt-5.6-terra`，可在启动服务前设置 `AURA_CODEX_MODEL` 更改。

启动桌面应用：

```powershell
.\scripts\aura.ps1 run desktop
```

桌面命令会构建 renderer、启动 DSH runtime 并打开 Electron 窗口；应用退出时会回收它启动的本地服务。移动端原生开发仍通过 `.\scripts\aura.ps1 run mobile` 启动，真机连接需要在设置页填写电脑的局域网服务地址。

登录链路是 `Aura → DSH authorization → dsh-llm-pi-ai → openai-codex OAuth`；对话链路是 `Aura → dsh --profile aura-sdk → DSH agent loop → dsh-llm-pi-ai → Codex`。Aura 不直接调用 pi-ai，也不复用或复制 Codex 应用的登录缓存。DSH 将授权记录保存在已忽略的 `.aura/dsh/.credentials.yaml`，前端只接收脱敏状态。

同一局域网手机连接时，服务需显式以 `HOST=0.0.0.0` 启动，并在设置页填写电脑的局域网地址。当前服务没有生产鉴权，只能用于本机或可信局域网，不能直接发布到公网。

## 构建与验证

```powershell
.\scripts\aura.ps1 run check
.\scripts\aura.ps1 run build
.\scripts\aura.ps1 run preview
```

Web 预览地址是 `http://127.0.0.1:4173`；预览命令现在会同时启动 runtime，退出时一起清理。服务运行时可在另一个终端验证真实 DSH 演示链路：

```powershell
.\scripts\aura.ps1 run test:runtime
```

Android 内测包使用 `.\scripts\build-android.ps1`；原生 JS 资源使用：

```powershell
.\scripts\aura.ps1 --filter @aura/mobile run export:native
```

输出分别位于 `output/android/aura-preview.apk` 和 `output/native-bundles`。移动 Web 与桌面 renderer 分别位于 `apps/mobile/dist` 和 `apps/desktop/dist`。Windows 无法生成 iOS IPA；EAS 配置在 `apps/mobile/eas.json`。

## Monorepo 目录

```text
apps/
  mobile/      @aura/mobile：Expo Web、Android/iOS 应用输出
  desktop/     @aura/desktop：Electron 桌面应用输出
  server/      @aura/server：Aura HTTP/DSH 服务入口
packages/
  frontend/
    ui/        @aura/ui：跨端组件、主题与设计变量
    workbench/ @aura/workbench：移动端与桌面端共用界面
  backend/
    codex/     @aura/dsh-codex：DSH Codex 授权组合
    runtime/   @aura/runtime：可复用 HTTP、DSH 进程与服务生命周期
  shared/
    protocol/  @aura/protocol：请求、流事件与脱敏授权状态
    core/      @aura/core：会话、存储恢复与地址校验
    demo/      @aura/demo：无密钥规则回复
scripts/       根级运行、构建与依赖检查
tests/         仓库级工作区规则测试
```

放置和依赖规则见 [AGENTS.md](AGENTS.md)。简要规则是：可运行入口只放 `apps/*`，可复用库才放 `packages/*`；frontend 只依赖 frontend/shared，backend 只依赖 backend/shared，shared 只依赖 shared；任何 workspace 都不能导入应用；跨 workspace 只使用显式导出和 `workspace:*`。

更多信息见 [架构](docs/architecture.md)、[模型接入](docs/model-providers.md)、[主题规范](docs/design-system.md) 和 [验证记录](docs/verification.md)。
