# Aura 架构

Aura 使用自己的代码、命名空间和发布流程，以固定版本的官方 DSH 包作为后端 agent harness。项目不会复制 DSH 仓库，不修改依赖源文件，也不会绕过 DSH 直接调用 pi-ai。

## 运行链路

离线模式只在客户端调用 `@aura/demo`。服务端演示和 Codex 模式都经过 Aura runtime 与 DSH：

```text
离线：客户端 → @aura/demo
演示：客户端 → Aura runtime → DSH SDK profile → 本地模拟模型
Codex：客户端 → Aura runtime → DSH SDK profile → dsh-llm-pi-ai → openai-codex
登录：客户端 → Aura runtime → DSH authorization → dsh-llm-pi-ai OAuth flow
3D：客户端 → Aura runtime → @aura/tripo → Tripo v3 API
图片：客户端 → Aura runtime → image-generate Action → Codex 订阅 image_generation（优先）或本机 Qwen-Image
```

`@aura/dsh-auth` 是 Aura 对 DSH authorization/credentials seam 的后端适配层。包名描述稳定职责，不绑定当前供应商；其中 `CodexSubscriptionAuth` 组合 DSH 的 `dsh-credentials-local`、`dsh-authorization`、`dsh-llm` 和 `dsh-llm-pi-ai` 服务。它只把 notice、设备码、手动回调提示和最终状态投影到客户端；浏览器回调监听使用与 OpenAI redirect URI 一致的 `localhost`。OAuth grant 由 DSH 写入 `.aura/dsh/.credentials.yaml`，不会进入 HTTP 响应、前端存储或日志。

`@aura/runtime` 是 TypeScript 编写的后端组合根，只负责解析配置、创建服务并按顺序关闭资源；HTTP API、Codex 授权路由、Tripo 路由、开发演示模型和 HTTP 基础设施分别位于独立模块。Tripo 不是 LLM provider，由 `@aura/tripo` 使用官方 v3 SDK 提交异步 3D 任务；Key 只从后端环境或已忽略的 `.aura/tripo/` 读取。图片生成由 `image-generate` Action 统一：已登录 Codex 时优先经订阅后端（`chatgpt.com/backend-api/codex/responses` 的 `image_generation` 工具）生成，复用对话的同一份 DSH 授权与令牌刷新，消耗 Codex 订阅额度而非按张计费，具体图片模型由 Codex 决定；每次调用只发一个请求，失败或结果未知时不重试也不改用其他引擎。未登录时改用本机 Qwen-Image；`image` 工作流与对话工具 `aura_image` 都经由它。插件可以贡献自己的 capability provider（见 `@aura/plugin-sdk/capability`），领域专用的外部工具由插件自己的 provider 调用，不进 Aura。所有 Aura HTTP 边界统一使用 Hono 与官方 Node 适配器，业务代码不直接创建 `node:http` server。`apps/server` 只是独立服务入口，`apps/desktop` 通过正式 workspace 依赖嵌入同一实现。运行时把 profile 复制到已忽略的 DSH home，DSH 依赖本身保持只读。详细设计见 [后端 Runtime 技术方案](development/backend-runtime.md)。

## Monorepo

pnpm workspace 收录应用输出和三层可复用库：

| 位置                  | 放置内容                                          | 允许依赖                 |
| --------------------- | ------------------------------------------------- | ------------------------ |
| `apps/*`              | web、mobile、desktop、server 可运行入口与发布配置 | 按平台使用下列 libraries |
| `packages/frontend/*` | 可复用页面、组件、交互状态、设备适配              | frontend、shared         |
| `packages/backend/*`  | HTTP 服务、凭据、DSH、进程、文件和网络能力        | backend library、shared  |
| `packages/shared/*`   | 与运行环境无关的类型、校验、存储格式和纯流程      | shared                   |

应用声明 `aura.kind: app` 与 `aura.platform`；packages 只允许 library，并声明 `aura.layer`。Web 与移动应用只能依赖 frontend/shared，服务应用只能依赖 backend/shared，桌面应用可以组合 frontend/backend/shared。`check:workspaces` 校验目录元数据、依赖方向、`workspace:*`、显式导出、未声明依赖、私有子路径、跨 workspace 相对导入、应用被依赖和依赖环。完整约束位于根 [AGENTS.md](../AGENTS.md)。

浏览器、移动、桌面和服务入口分别位于 `apps/web`、`apps/mobile`、`apps/desktop` 与 `apps/server`。客户端导航和 React 状态属于 `packages/frontend/workbench`，DOM 原语与设计系统属于 `packages/frontend/ui`，DSH 授权适配属于 `packages/backend/dsh-auth`，Tripo 3D 网络与凭据适配属于 `packages/backend/tripo`，协议、存储与规则演示属于 shared。新增小程序时创建独立的 `apps/miniprogram`，复用适合小程序运行时的 shared 逻辑，不在 packages 中伪装成应用。

各包职责、领域目录和公共入口见 [模块边界](development/module-boundaries.md)，文档导航见 [文档目录](README.md)。

## Web-first 客户端

Aura 只有一套 React Web 界面。`@aura/workbench` 负责页面、状态与 transport，`@aura/ui` 直接输出标准 HTML/SVG 组件；两者不依赖 Expo、React Native、React Native Web 或 Metro。三个客户端应用保持为薄宿主：`@aura/web` 用 Vite 输出浏览器静态站点，`@aura/desktop` 用 Vite 构建 renderer 后由 Electron 承载，`@aura/mobile` 用同样的 Vite 构建交给 Capacitor 同步到 Android/iOS。

每个客户端独立构建同一个 library，而不是让应用依赖另一个应用的 `dist`。这样 workspace 依赖方向保持单向，Electron/Capacitor 的宿主能力也不会渗入公共页面。宿主只通过 `window.auraHost` 暴露最小的平台标识与打开系统浏览器能力；会话继续使用 Web Storage，OAuth token 仍只属于后端 DSH。

桌面 Site 目录选择、项目运行以及工作流图片/输出目录选择通过最小宿主桥接暴露。工作流选择器只返回用户明确选择的本机绝对路径，不读取文件内容；共享表单仍允许输入服务端路径，使 Web 与移动端不会伪造浏览器无法取得的绝对路径。`src/preload.ts` 在开发启动和静态构建时编译为独立的 CommonJS 产物 `dist-host/preload.cjs`，Electron 在启用 `sandbox` 与 `contextIsolation` 的窗口中加载它；主进程的 TypeScript 支持不适用于沙箱 preload。renderer 只在桥接缺失时补充平台标识，以便显示准确的桌面连接错误。

Site 的目录/脚本解析、端口检查、进程组和就绪验证属于 `packages/backend/runtime`，以 `@aura/runtime/site` 导出，与 Electron IPC/窗口分离。`site-project.ts`、`site-network.ts`、`site-process.ts`、`site-runner.ts` 分别管理配置、网络与进程归属、子进程和生命周期；共享类型放在 protocol。已识别的直接开发命令先检查系统监听表并尝试绑定 loopback 端口，以排除 Windows 未显示为监听者的保留端口，再把明确端口传给开发服务器并从输出同步真实地址。自定义脚本冲突拒绝启动；不能仅凭某个地址能响应就判定启动成功，必须同时验证监听者属于本次进程树。子进程在启动时退出会立即更新为错误状态并保留诊断输出。桌面退出等待 Site 进程与自有 runtime 一起完成清理。

Web 开发与静态预览命令通过 `scripts/run-with-runtime.ts` 同时启动页面服务和 Aura runtime，解决页面存在但 4311 服务缺失的问题。`scripts/dev-renderer.ts` 在根开发工具层统一启动 Web / Desktop / Mobile 的 Vite 服务（Web 固定 8081，Desktop 与 Mobile 默认 8082），应用配置继续留在各自入口。Desktop 开发模式加载 Vite URL，静态预览仍由 Electron 使用 Hono 提供构建产物。根工具的 Vite 插件只在开发期注入 HTTP 版本检查，Vite WebSocket 不可用时以整页刷新恢复；HTTP 路由通过 Hono 官方适配器接入 Vite Connect，不进入发布产物，也不引入 frontend → backend 依赖。Electron 主进程会先检查并启动 runtime，再显示 renderer；开发入口和窗口退出时回收自己启动的服务。Capacitor 原生应用不能内嵌 Node/DSH，真机通过设置中的局域网地址连接电脑端 runtime。后端 Origin 策略仅额外接受 Capacitor 固定的 `https://localhost` / `capacitor://localhost` 来源。

## 后端 Agent 流程编排

`packages/backend/orchestration`（`@aura/orchestration`）统一拥有代码 Flow 的发现、Cordis Loader/HMR 注册、执行、动态步骤/session 映射、运行持久化和 `/flows/*` API。Flow 位于该包的 `flow/<flow-id>/<flow-id>.flow.ts` 或兼容的 `.flow.js` 单一入口，用 JavaScript 条件、循环和 `sequence/parallel` 回调作用域表达控制流，并通过 `@aura/orchestration/flow` 获得 `defineFlow`、Zod 与声明文件补全。作用域内的 `flow.flow()` 以规范 ID 创建持久化 child Run，固定子版本并保存父子关系；嵌套运行内联调度，不占顶层 FIFO 槽。定义设置 `service: true` 时，运行时才把它列入 `/flows/services` 并允许外部应用通过 `/flows/:flowId/invoke` 创建 durable Run；调用返回状态链接，客户端断开不取消执行。shared/protocol 仅包含通信类型，不执行 Flow 或装配 prompt。

流程使用独立、常驻的 `aura-flow` DSH profile：runtime 启动时即拉起，随 runtime 关闭而退出，异常退出后自动重启，不做空闲回收。每个 `scope.agent()` attempt 都产生独立 preset/session，复用 DSH Session Controller、领域存储、JSONL、模型路由和取消；Cordis HMR 复用 DSH 已有模块依赖图与事务回滚。运行开始时固定代码定义和贡献内容 hash（外部插件包含插件根内静态 ESM 依赖闭包），后续热更新只影响新运行。客户端断开不取消流程。Run 先持久化排队，默认最多同时执行 32 个顶层 Run；暂停、人工 checkpoint 和未知结果等待不占并发槽。重启先加载定义并校验同一 source hash，再从脚本入口重放；完成步骤按作用域路径及请求指纹返回存档输出，DSH 完成回合可认领输出，未知副作用等待人工处理。旧 active 记录缺少 durable identity 时标记 `legacy_unrecoverable`，已完成历史保持可读。Flow JS 是拥有完整 Node.js 权限的受信任后端代码。`/chat` 在同一宿主内运行，对话工具只启动显式开放的工作流；流程本身不依赖客户端对话历史。实现、恢复约束与扩展配置见 [编排包说明](../packages/backend/orchestration/README.md)。

同包的 `action/<action-id>/<action-id>.action.ts` 或兼容的 `.action.js` 单一入口 提供可热加载的工具扩展，公开 `@aura/orchestration/action` 和声明文件。Action 使用 DSH 工具 Schema DSL，复用 DSH ToolRuntime 的校验、策略、结果渲染和协作式超时；每个 Flow Agent 固定使用原生工具呈现并以空白名单屏蔽全部继承工具，`scope.agent({ actions: [...] })` 再将固定版本注册到指定 Agent scope，因此模型上下文只包含显式配置的 Aura Action，未配置时工具集合为空。`scope.action()` 直接调用时保存独立 Action step 的 input/output，Agent 内部调用继续保留在 DSH session 日志中。Flow 开始时同时固定 Action 定义快照，步骤身份为作用域路径加本地 ID，共享调用并发限制。重试由调用声明，默认不重试；仅声明 `recovery: "idempotent"` 的直接 Action 可自动重试，跨 attempt 使用同一 idempotency key。普通 Action 中断后需人工重试、提交结果或终止。Agent 已启动工具而回合未完成时同样需要人工处理。后端 `host.invokeAction()` 使用同一执行适配，独立记录写入 `aura_code_actions` domain，不提供通用 Action HTTP 执行接口。前端只渲染 catalog 和不同步骤 DTO；Action context 第一版不提供调用 Flow 的接口，完整 Node.js 权限仍按受信任代码处理。

受信任的本地外部插件由 `packages/backend/extensions` 从 `.aura/plugins.json` 中显式列出的目录加载；Aura 不扫描任意磁盘目录，也不安装依赖。插件根的 `aura.plugin.json`、ESM package、引擎范围、贡献目录、能力声明和公共 `@aura/plugin-sdk` 依赖会先经过后端校验。通过校验的多根 Action/Flow 进入同一个 Cordis Loader/HMR 与注册表，外部贡献使用 `<plugin-id>/<local-id>` 规范 ID，内置贡献继续使用原 ID。catalog 与运行记录保留插件身份、版本和贡献 hash；前端无需为注册插件重新构建。设置页可通过 runtime 固定的 `/plugins/config` 边界替换这份目录清单并查看预校验状态，但配置代码执行权限只对绑定 loopback 的本机服务开放。保存会在编排子进程内动态增删发现根和 HMR 监听，实际加载成功后再原子持久化；失败则回滚。已有运行使用创建时固定的版本，新运行立即看到新配置，无需重启 runtime。

插件 manifest 请求的宿主能力必须全部受当前 Runtime 支持，否则插件不会加载。Action 通过 Plugin SDK 的 `auraCapability()` 取得按调用取消域绑定的领域端口，不接触凭据、任意 URL 或底层进程。插件还可以在 `contributes.capabilities` 下贡献自己的 provider（`<plugin-id>/<local-id>`），由宿主在激活插件时打开，取得插件数据目录、`plugins.json` 中的 `settings`、只读的本插件 Run 视图和内置能力；领域专用的服务连接与策略都在插件 provider 内实现。`aura.tripo.game-asset` 只允许固定的 GPT Image 2.5 四视图到 Tripo P1 GLB 链路和单张付费图片，所有付费阶段先在用户拥有的账本中预留；调用方可用不透明的 `scope` 给付费工作分组。token、API Key 和上游 URL 不进入插件输入、Flow/Agent 上下文、前端 DTO 或日志。

Flow 的模型参数由 `flow.agent({model,reasoningEffort,temperature,maxTokens,timeoutMs,...})` 按步骤声明，或通过 `defineFlow.agentDefaults` 提供公共默认值；步骤覆盖 Flow 默认，Flow 默认覆盖运行时配置。provider 仍绑定 Run.mode，脚本不接触凭据或任意 endpoint。入队时固定 Run 默认参数，Agent dispatch 前保存完整 `config` 并纳入请求指纹；重试与重放不读取新的环境默认值。`sessionController.selectModel` 选择模型，DSH Agent 的官方 `agent/request` scoped waterfall 将同一配置应用到每轮模型请求并写入 DSH request header。模型与思考强度先经过 DSH 能力校验，无效配置不会启动 Agent attempt。升级前未保存参数的未结束记录安全中断为 `agent_config_unrecoverable`；已完成历史继续可读。

Flow 图片通过 `agent({images})` 的受控 DSH 附件引用传递，在 Session 边界校验并读取实际图片，不把 base64 或任意图片路径塞入 durable JSON。插件 provider 可经 `host.attachments.image` 把图片放入会话附件，经 `host.artifacts` 读写按 SHA-256 寻址的 artifact 存储。文本模型拒绝图片并返回明确错误，不退回只看路径的“视觉验收”。

## 当前取舍

`comfy-workflow` Action 从对象或本地 API JSON 文件调用所选 ComfyUI，支持节点参数覆盖、受管图片资产到 `LoadImage` 的绑定和输出节点筛选；普通界面画布 JSON 不做转换。文件内容在排队前固定并记录 hash，图片资产通过上传端点或 `local-image` 登记为内容哈希 ID；ComfyUI 执行每次使用独立 input/output/temp 目录，输入图在启动前按 ID 校验并暂存，保存/预览产物归档后删除中间目录。`local-video` 的预置模板可选择首帧、末帧图片资产；前端不解释 ComfyUI 图或调度模型。

本地媒体模型以同包 `local-image`、`local-video`、`local-tts` Action 接入已有 ComfyUI / Qwen3-TTS HTTP 服务，`local-ai-service` 负责状态与显式启停。`orchestration/src/local-ai/` 是这三套受信任 Windows 部署的后端适配：复用 DSH subprocess，并用其公开 Win32 bindings 补充 Job 崩溃回收及跨宿主 GPU lease。模型进程由后端插件持有，不属于热加载 Action fiber；详情见 [本地模型 Actions](../packages/backend/orchestration/docs/local-ai-actions.md)。这条媒体工具链不替代 Agent 的 DSH 模型路由。

内置 `short-video` Flow 先生成 TTS 并由 `short-video-audio` 检查 WAV 时长，再按需通过 `local-image` 生成首末帧或使用工作流表单已上传的受管图片资产，最后调用 `local-video` 和使用固定 FFmpeg 二进制的 `short-video-compose` 合成旁白与烧录字幕。

「工作流」首页用卡片展示用途与可用状态，点击卡片按需通过 `/flows/:flowId/source` 读取已注册入口源码，在卡片下方静态解析节点；编辑入口进入流程图/代码详情。画布与节点支持拖拽，位置只影响当前预览，不修改代码。注册时保留源码快照，热加载失败时预览与运行均继续使用最后可用版本；接口按目录 ID 查注册表，不接受文件路径，不返回辅助文件或凭据。源码预览不具备发布或修改后端代码的能力。

运行入口创建带 `workflow` 绑定的工作区会话，输入、结果和步骤记录都在会话内查看。绑定保存工作流 ID、标题、服务 origin 和输入 Schema，每个结果引用原有后端 run ID；不会把工作流输入提交到普通 `/chat` 链路。同一会话支持多次独立运行，后台轮询同步状态，原有服务端运行记录自动进入历史列表。前端按 run ID 将原有输入/结果消息配成对话轮次，不改变存储格式；用户输入右对齐，工作流步骤、状态和结果在中间输出区随轮询连续更新。富文本及结构化数据由 workbench 的浏览器组件渲染，Markdown 依赖随工作流会话按需加载。执行表单作为对话流末尾的内联编辑块按需展开，确认接收后收起，不阻塞历史浏览和页面滚动。标量 Schema 字段使用结构化控件，字符串枚举数组使用多选控件并遵守 `minItems` / `maxItems`；其他复杂嵌套输入仍回退为 JSON。待确认提交保留 requestId，网络失败后重试复用同一请求；本地删除会话记录隐藏 run ID，避免轮询重新导入。工作流回复提供暂停/继续、checkpoint 输入、未知结果处理、attempt 历史和恢复记录；图是代码的只读静态投影，运行记录另行展示实际执行路径。

普通联网对话复用长驻编排宿主的 DSH 进程，每次请求创建短期 session；客户端历史作为带标记的输入交给 DSH，响应结束或连接断开后清理 session。这保留了 DSH agent loop、provider、事件与取消链路。Flow 则保存稳定的步骤到 DSH session 映射及 durable Run；普通对话历史仍由客户端保存。

Codex 默认模型是 `gpt-6.1-sol`，推理档位为 `xhigh`（Extra high），传输为 SSE。`@aura/dsh-auth` 用公开 DSH 模型配置补充当前目录缺少的型号，并保留原有目录；授权组合与编排 profile 共享这份 provider 配置。部署可以通过 `AURA_CODEX_MODEL` 选择目录中存在的其他模型，Flow 还可按 Agent 覆盖；未知模型或不支持的思考档位报错，不回退到演示。当前锁定 Codex 适配器不向上游转发 `maxTokens`，不能把配置值当成实际输出硬上限，因此 Flow 在 Codex 模式拒绝此选项。Demo 链路支持 token 参数透传，默认 4096。温度由具体模型决定是否接受，未设置时沿用供应商默认；Agent 的 `timeoutMs` 独立限制每次 attempt 时长。

客户端继续使用 `aura.workspace.v1` Web Storage。增加 `codex` provider 不改变现有会话格式；从 AsyncStorage 迁移不会读取旧 Expo 应用沙盒的数据，已有浏览器 localStorage 数据则保持兼容。恢复时会保留已选择的模式，并把中断中的回复标为已停止。

服务只有开发期同源/同主机 Origin 限制，没有用户认证、多租户隔离或公网防护。手机不保存个人订阅 token，只调用运行在电脑上的 Aura 服务。Bedrock、云同步和生产账号系统仍未接入。

## 工作流媒体预览

工作流产物通过 `@aura/orchestration` 的 `GeneratedArtifacts` 与独立 `WorkflowArtifactIndex` 登记、生成缩略图及迁移历史记录；不修改 Action 输出和 durable 重放身份。shared/protocol 的 `WorkflowArtifact` / `WorkflowArtifacts` 只传文件 ID、可用状态、元数据和来源步骤。`/flows/runs/:runId/artifacts` 与其内容路由验证运行关联；二进制由 Hono 流式发送，不进入 DSH JSON-RPC。已生成结果不因预览登记失败而触发再次生成。

workbench 在工作流回复与步骤详情展示同一套文件卡片，使用原有轮询节奏同步产物。图片弹层支持缩放/拖动，MP4 使用浏览器原生播放器，GLB 使用按需加载的 `@google/model-viewer`，以独立卡片在对话内直接交互预览；模型卡片进入视区时加载查看器，其余图片加载缩略图，模型的参考图片默认折叠，放大操作仍打开弹层。`model-viewer` 和 Three.js 由三个应用通过 peer dependency 提供同一运行时，解码器由根构建插件统一部署到各宿主产物，无运行时 CDN 依赖。三个宿主按应用与 serve/build 隔离 Vite 缓存，开发期预优化查看器，避免并行开发或构建使懒加载依赖失效。Web、Electron 和 Capacitor 共享 DOM 与 HTTP 文件地址，不向 renderer 暴露磁盘读取能力。
