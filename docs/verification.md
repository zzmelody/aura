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

## 2026-11-01 对话输入框恢复

在合成工作空间列表移除 `isDefault` 标记后，先复现了点击旧对话进入「新建工作空间」空态、历史和输入框消失的问题。修复统一了初次加载与新建对话的工作空间选择；没有工作空间时保留历史和可编辑输入框，暂停发送，工作空间恢复后保留草稿。

- workbench 类型检查通过；116 项测试中 115 项通过、1 项因未设置 `CHROME_BIN` 跳过。新增 3 项选择回归覆盖缺少默认标记、保留有效选择、优先默认空间和空列表。
- Web 生产构建与全仓 Lint 通过；构建仍有既存的大 chunk 提示。
- Playwright 合成接口验证通过：无默认标记时打开旧对话、新建对话、空列表时历史可读与草稿可编辑、禁止发送及 Enter 不清空草稿、创建入口、延迟列表恢复后草稿与历史保留、窄屏输入框、503 错误提示及历史恢复。没有发送模型请求，没有读取或改写真实用户存储。
- `pnpm run format:check` 未通过，仍为以下两个既存文件；本次修改文件另行格式检查。未重跑全仓 `pnpm run check`、后端测试或安装包构建。

```text
Format these new or changed files with pnpm exec prettier --write:
  packages/backend/orchestration/src/plugin-backends.ts
  packages/backend/runtime/test/runtime-config.test.ts
```

## 2026-11-01 输入卡片布局

主对话和侧边对话改为独立加载的两层输入卡片；原有在线页面未稳定加载演示页的输入框样式，可导致布局和手动缩放角回退。服务选择并入模型菜单，工作空间并入卡片操作行，图片与快捷工具从「＋」进入。

- workbench 类型检查通过；116 项测试中 115 项通过、1 项浏览器宽度回归因未设置 `CHROME_BIN` 跳过。
- Playwright 使用合成目录、图片上传、运行历史、引导及停止接口，通过附件与移除、快捷入口、Skill 补全、模型服务切换保留草稿、思考强度选择、自动增高、主副两栏与 390px 窄屏、320px 长模型名、生成中停止与引导、空工作空间和模型目录 503 恢复入口等检查。另行验证原生文件选择器能从「＋」打开。合成模型名称只用于布局测试，不代表真实模型可用；未发送真实模型请求或写入真实用户数据。
- Web 生产构建、全仓 Lint 通过；构建保留原有大 chunk 提示。本次文件格式与 `git diff --check` 另行通过。
- 全仓 `pnpm run format:check` 仍未通过，输出与上一节相同，指出 `plugin-backends.ts` 和 `runtime-config.test.ts`；未改动这些文件。未重跑全仓 `pnpm run check`、后端测试或安装包构建。

## 2026-11-01 DSH 对话呈现对齐

对照 DSH 源码的授权卡片、工具行和输入区尺寸规则，修正 Aura 时间线渲染、授权卡片位置及输入输出内容宽度。DSH 继续使用已发布依赖，未复制或修改其源码。

- `@aura/workbench` 类型检查通过；设置 `CHROME_BIN` 使用本机 Edge 后，117 项测试全部通过，无跳过。布局回归覆盖 48 组分屏宽度、旧宽度偏好、长代码、宽表格和 diff，正文与输入文字边界误差不超过 2px，审批卡片与输入卡片同宽。
- Playwright 在合成接口下验证工具与 AI 文字交错顺序、用户引导、完成与刷新回放、授权卡片独立于输出区、等待时保留草稿并暂停发送、允许一次、输入法防误确认、审批失败后重试、Esc 拒绝、展开图标及单栏/分屏/390px 窄屏/短窗口布局。未发送真实模型请求或改写真实用户存储。
- 全仓格式检查、全仓 Lint、Web 生产构建与 `git diff --check` 通过；构建仍提示既存的大 chunk。未重跑全仓 `pnpm run check`、后端测试或安装包构建。

## 2026-11-01 输入区置底与工具组折叠

移除新会话输入区的居中布局，统一空白和已有对话的输入高度与底部间距；旁支结论入口移到输入卡片上方。连续工具调用保留在 AI 文字之间，以折叠摘要展示，可单组或统一展开，失败与中断状态不随折叠隐藏。

- workbench 类型检查通过。设置 `CHROME_BIN` 使用本机 Chromium 后，120 项测试全部通过、无跳过，包含 48 组真实浏览器宽度回归。新增 3 项工具组摘要测试覆盖并行执行、失败、中断、全部成功与空组。
- Playwright 合成接口检查通过：新对话置底、主旁支上下边对齐、多行草稿保持底边、窗口变化、390px 单栏、旁支结论入口位置、空白间隔合组、AI 文字与工具顺序、默认折叠、独立/统一展开与收起、键盘展开及文件差异。独立的合成 NDJSON 流进一步验证新步骤到达及完成后保留展开选择、失败摘要可见，并验证本地演示输入区置底；共 25 项检查通过。
- 全仓 Lint、全仓格式检查、Web 生产构建和 `git diff --check` 通过；构建保留既存的大 chunk 提示。未重跑全仓 `pnpm run check`、后端测试或安装包构建。
- 本轮仅使用合成历史、浏览器内合成流与隔离界面存储，没有调用真实模型、重新执行历史工具或改写真实用户存储。

## 2026-11-01 工具摘要视觉精简

折叠工具组改为扳手图标加动作短句，同类操作去重，次数留在提示中；移除正常完成时重复的勾选和完成标签，轮次顶部仅显示用时。保留运行、失败和中断信息，失败的文件修改使用尝试措辞。

- workbench 类型检查通过；设置本机 Chromium 的 `CHROME_BIN` 后，123 项测试全部通过、无跳过。新增 3 项描述回归覆盖活动合并、工具别名、顺序、失败措辞、未知工具和空组。
- Playwright 合成界面通过原有 18 项置底/折叠检查、7 项流式及本地演示检查；额外确认箭头默认隐藏、键盘聚焦可见，次数保留在提示中。没有调用真实模型或改写真实用户存储。
- 全仓格式检查、全仓 Lint、Web 生产构建通过；构建仍有既存的大 chunk 提示。相关 Markdown 格式和 `git diff --check` 另行检查；未重跑全仓 `pnpm run check`、后端测试或安装包构建。
