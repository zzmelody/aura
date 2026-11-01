# 当前验证

本文件记录 2026-10-08 的模块整理与代码规范清理。[历史记录](verification/history.md) 保留过去的实现和环境结果。

已完成的聚焦验证：

- 插件配置包：类型检查及 7 项测试通过。
- 图片响应解析与 Pi Action：13 项测试通过，包含 malformed JSON 事件形状。
- 工作区依赖、显式导出与 TypeScript 源码约束通过；分发启动器不再使用 `.mjs` 源码。

最终全仓验证使用 Node.js 24.21.0 和 pnpm 12.5.1：

| 检查                                           | 结果                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------ |
| `pnpm run format:check:strict`                 | 通过，全仓符合 Prettier                                            |
| `pnpm run lint:strict` / `pnpm run lint:prune` | 通过，无剩余违规或历史豁免                                         |
| `pnpm run check`                               | 通过，包含格式、Lint、依赖边界、全部类型检查与测试                 |
| 全部测试                                       | 379 项中 373 项通过、6 项按平台或环境条件跳过、0 失败              |
| `pnpm run build`                               | Web、Electron renderer/preload、Capacitor Web 与服务启动器全部通过 |
| 文档本地链接                                   | 72 个目标均存在                                                    |
| PowerShell 启动辅助脚本                        | 语法通过；独立目录实测使用 pnpm 12.5.1 原生入口                    |
| `git diff --check`                             | 通过                                                               |

`format-baseline.json` 和 `eslint-suppressions.json` 已清空。构建仍提示主界面和按需加载的模型查看器 chunk 超过 500 kB；未修改此提示阈值。本轮未重新生成 Android APK/iOS 包，也未执行依赖真实账号或付费模型的测试。历史环境结果留在历史记录中。

## 2026-11-01 多旁支对话与侧栏关闭

本轮使用 Node.js 25.0.0、pnpm 12.5.1。多旁支沿用已发布 DSH 的 fork/resume；测试使用合成模型服务与独立临时存储，没有发送真实付费请求，也没有迁移或改写工作区 `.aura/` 配置与存储。

| 检查                                                               | 实际结果                                                                                                                                                                              |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@aura/protocol` 类型检查、测试                                    | 通过；7 项测试通过，含旧旁支元数据的只读兼容与显式空列表                                                                                                                              |
| `@aura/workbench` 类型检查、测试                                   | 类型检查通过；105 项通过，1 项 Chrome 布局回归因未设置 `CHROME_BIN` 跳过；最终界面调整后再次通过类型检查和相关文件 Lint                                                               |
| `@aura/orchestration` 类型检查、旁支聚焦测试                       | 通过；5 项旁支测试通过，含同级旁支上下文隔离、重启恢复、独立模型设置、旧记录读取和关闭后拒绝访问                                                                                      |
| Playwright 合成界面检查                                            | 13 项通过；包含多旁支切换与独立草稿、创建、单独关闭、失败后保留、关闭成功后列表刷新失败、网络失败时立即收起、重新打开、键盘焦点恢复、最后一项关闭后的空态；390px 窄屏堆叠且无横向溢出 |
| `pnpm run typecheck`、`pnpm run lint`、`pnpm run check:workspaces` | 全部通过                                                                                                                                                                              |
| `pnpm --filter @aura/orchestration run test`                       | 192 项中 184 项通过、4 项跳过、4 项失败；失败均涉及媒体测试中的 FFmpeg 临时文件写入，不属于旁支改动                                                                                   |
| `pnpm run format:check`                                            | 失败，指出其他工作区改动中的两个文件，见下方实际输出                                                                                                                                  |
| `pnpm run check`                                                   | 已执行，在产品插件格式检查阶段失败；该次全仓入口没有继续执行后续阶段。类型、Lint、依赖边界与受影响包测试另行执行，结果如上                                                            |
| `git diff --check`                                                 | 通过                                                                                                                                                                                  |

格式检查的实际失败输出：

```text
Format these new or changed files with pnpm exec prettier --write:
  packages/backend/orchestration/src/plugin-backends.ts
  packages/backend/runtime/test/runtime-config.test.ts
```

全仓入口在产品插件检查中的实际失败输出：

```text
[warn] plugins/site-launcher/client/src/site.css
[warn] Code style issues found in the above file. Run Prettier with --write to fix.
[ELIFECYCLE] Command failed with exit code 1.
```

编排包失败的测试为 `local-ai.test.ts` 的 3 项媒体 API 测试和 `video-render.test.ts` 的连续 R2V 测试。前者的合成接口返回 `本地 AI HTTP 请求失败 (500)。`，服务端 FFmpeg 输出与后者一致：

```text
Error opening output .../clip.mp4: Permission denied
Error opening output .../source.mp4: Permission denied
Error opening output files: Permission denied
```

本轮未运行真实账号、真实模型、本机 AI 服务或移动端安装包的验收。

## 2026-11-01 单行顶栏、工具标签与真实终端

使用 Node.js 25.0.0、pnpm 12.5.1。终端使用已发布 DSH 的公开 PTY 接口，前端为按需加载的 xterm.js。真实 shell 测试在独立临时目录运行，历史目录也隔离；浏览器使用合成会话 / 模型目录和真实 PowerShell 进程，没有发送模型请求或改写 `.aura/` 用户存储。

| 检查                                         | 实际结果                                                                                                                                                                               |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm run typecheck`                         | 全仓通过；验收期间另一个历史窗口改动出现空值错误，补齐检查后通过                                                                                                                       |
| `pnpm run lint`、`pnpm run check:workspaces` | 全仓通过                                                                                                                                                                               |
| `@aura/workbench` 测试                       | 113 项中 112 项通过，1 项未设置 `CHROME_BIN` 的布局测试跳过；另行用实际 Chromium 验收                                                                                                  |
| `@aura/protocol` 测试                        | 7 项通过                                                                                                                                                                               |
| `@aura/runtime` 测试                         | 44 项通过，包含终端 HTTP 边界与跨端口 DELETE / SSE 重连 CORS 回归                                                                                                                      |
| 终端与多侧边对话聚焦测试                     | 7 项通过；真实 PowerShell 输入、变量跨命令保留、调宽和关闭通过；有界输出、未知 ID、关闭确认与已回答终端查询的重放过滤通过                                                              |
| 浏览器生产构建验收                           | 9 组通过：48px 顶栏对齐、多对话草稿与结论带回、真实 shell 输出、收起 / 同工作区切换后状态保留、多 PTY 与确认关闭、网络重连、Ctrl+C 中断、390px 全宽工具视图、刷新后恢复同一 PTY 与输出 |
| Web 生产构建                                 | 通过，xterm 独立按需 chunk 约 331 kB；仍有原有主入口 / 模型查看器的 500 kB 提示                                                                                                        |
| `pnpm --filter @aura/orchestration run test` | 最近整包执行 197 项：188 通过、5 失败、4 跳过。4 项为媒体临时文件写入权限问题；另 1 项是同时调整中的历史分页断言，随后单独执行 `coding-side-dsh.test.ts` 已通过                        |
| `pnpm run format:check`                      | 失败，仅指出其他工作区改动中的 `plugin-backends.ts` 与 `runtime-config.test.ts`，实际输出见下方                                                                                        |
| `pnpm run check`                             | 已执行，停在产品插件 `site.css` 的格式检查，后续阶段通过上表中的独立命令验证                                                                                                           |
| `git diff --check`                           | 通过                                                                                                                                                                                   |

全仓检查仍未全部通过，实际失败输出为：

```text
Format these new or changed files with pnpm exec prettier --write:
  packages/backend/orchestration/src/plugin-backends.ts
  packages/backend/runtime/test/runtime-config.test.ts

[warn] plugins/site-launcher/client/src/site.css
[warn] Code style issues found in the above file. Run Prettier with --write to fix.

Error opening output .../clip.mp4: Permission denied
Error opening output .../source.mp4: Permission denied
```

整包执行期间历史分页断言的实际失败为 `true !== false`（`paged.hasMore`）；同一测试随后隔离运行通过，不将整包执行记为通过。未执行 Electron / Capacitor 安装包验收，也未使用真实付费模型或本机媒体模型。

另补充完整 DSH 子进程 RPC 的终端创建、列表、调宽与刚启动即关闭验收，均通过。ConPTY 的退出等待调整到 3 秒，修复冷启动立即关闭时的失败；没有修改 DSH 或 node-pty 源码。

## 2026-11-01 加载、内存与渲染性能

使用 Node.js 25.0.0、pnpm 12.5.1。变更包括目录读取与扫描分离、扫描合并与降频、ETag 条件请求、diff 弱引用缓存、回合 memo 与局部计时、旁支延迟挂载及空闲回收、DSH 完整回合分页、40 轮渲染窗口与六段会话缓存、桌面窗口与服务并行启动、页面拆包，以及按 endpoint / Run ID 共享读取和取消。快速启动期间的授权状态、项目和插件目录读取可在服务就绪后自动恢复。未改写用户存储格式或工作区 `.aura/` 配置。

| 检查                                               | 实际结果                                                                                                                                                                                                                                                                    |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web 生产构建                                       | 通过；入口 JS 从 751.07 kB 降为 528.21 kB，gzip 从约 233.18 kB 降为 165.79 kB；入口 CSS 从 103.99 kB 降为 80.50 kB。入口之外仍有共享与按需 chunk，不将入口大小当作全部网络传输量。保留现有 500 kB 构建提示。                                                                |
| 重复 diff 统计合成基准                             | 100 轮、每轮 3 个 400 行 diff，预热后七次取中位数：未缓存约 330.92 ms，共享 hunk 缓存命中约 0.15 ms。仅为重复计算基准，不代表 React 帧耗时或整体响应时间。                                                                                                                  |
| `pnpm run typecheck` / `pnpm run check:workspaces` | 全仓通过；最后一批启动恢复与可见性改动后，workbench / desktop 类型检查再次通过。                                                                                                                                                                                            |
| `pnpm run lint` / `git diff --check`               | 通过；修改后的文档另行检查格式。                                                                                                                                                                                                                                            |
| workbench 测试                                     | 设置实际 Edge 的 `CHROME_BIN` 后 113 项全部通过，无跳过，包含真实浏览器宽度布局回归。                                                                                                                                                                                       |
| runtime 测试                                       | 已执行的原 42 项全部通过；新增游标 HTTP 边界测试另行通过。                                                                                                                                                                                                                  |
| 编排相关聚焦测试                                   | 扫描合并、目录 ETag / 304、HTTP 边界与旁支兼容等 14 项通过；最后修复旁支继承边界后，历史分页、DSH fork / restart 与 HTTP 游标 3 项通过。                                                                                                                                    |
| Edge / Playwright 合成接口冒烟                     | 通过：80 轮历史翻页及返回最新时最多挂载 40 轮；草稿保留；其他项目的隐藏旁支不读取历史；工作流编辑器未进入聊天启动请求；隐藏空闲旁支 61 秒后释放并恢复草稿。首次授权、项目、插件目录请求分别模拟 503，随后自动恢复，未手动刷新。                                             |
| `pnpm run check` / `pnpm run format:check`         | 已执行但未通过；前者停在已有 `site.css` 格式问题，后者指出 `plugin-backends.ts` 与 `runtime-config.test.ts`。失败输出见本文件前两节，不修改这些独立工作区改动来隐藏结果。                                                                                                   |
| 编排全量测试                                       | 已执行，未通过；一次全量为 188 通过、5 失败、4 跳过。历史响应兼容及 `hasMore` 边界随后修复并通过聚焦复验；4 项媒体失败单独复现为 8 通过、4 失败，输出为 `本地 AI HTTP 请求失败 (500)。` 和 FFmpeg `Error opening output ...: Permission denied`。未把聚焦复验当成全量通过。 |

真实进程 RSS、浏览器堆、FPS 与 Electron / Capacitor 安装包启动时间未量化。本轮浏览器使用合成接口，未调用真实付费模型或本机媒体模型。所有临时构建、基准与浏览器记录留在忽略目录，不作为运行时依赖。
