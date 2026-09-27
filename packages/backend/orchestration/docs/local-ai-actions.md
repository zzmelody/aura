# 本地图片、视频和语音 Actions

这是五个独立的 Action，不包含新的 Aura Flow。未来的 Flow、指定 Agent 和本地后端调用复用相同 Action；生命周期管理在 `src/local-ai/`，不放进 Flow 或前端。`comfy-workflow` 执行的是 **ComfyUI 自己的 workflow**。

| Action ID          | 用途                                                      | 部署 / 默认端口                                  |
| ------------------ | --------------------------------------------------------- | ------------------------------------------------ |
| `local-image`      | Qwen-Image-2512 文生图，返回 PNG 路径及图片资产 ID        | `D:/workflow/AI/qwenimage/ComfyUI` / 8190        |
| `local-video`      | MiniMax H3 文生视频或首末帧图生视频（含音频）             | `D:/workflow/AI/minimaxh3/ComfyUI` / 8188        |
| `local-tts`        | Qwen3-TTS 预设音色、声音设计、参考音频克隆，返回 WAV 路径 | `D:/workflow/AI/qwen3tts` / 8000                 |
| `local-ai-service` | 查看、启动、停止上面三个服务                              | 服务 ID：`qwen-image`、`minimax-h3`、`qwen3-tts` |
| `comfy-workflow`   | 执行自定义 ComfyUI API workflow，返回动态输出和文件       | 选择 `qwen-image` 或 `minimax-h3`                |

模型目录可以通过**后端环境变量** `AURA_LOCAL_AI_ROOT` 调整（例如 `D:/workflow/AI`）。请求不能指定可执行文件、服务 URL 或启动参数。当前只支持 Windows x64，使用现有虚拟环境、已下载权重和各部署的 4080 启动参数；不安装依赖、不下载模型、不启动浏览器，也不修改模型安装目录的代码。ComfyUI 的生成输出目录改为 Aura 的 `.aura/local-ai/outputs/`。

## 调用

通常直接调用生成 Action，不需要先调用 start：

```js
// 未来 Flow 的 run(ctx, input) 中：
const image = await ctx.action({
  id: "illustration",
  action: "local-image",
  input: { prompt: "雨夜中的未来城市，电影光影", width: 1024, height: 1024 },
});
// image.output = { service: "qwen-image", seed: 123, files: ["...png"], imageAssetId: "64位SHA-256" }

const video = await ctx.action({
  id: "clip",
  action: "local-video",
  input: { prompt: "镜头缓慢掠过海岸，伴随海浪声", frames: 39 },
});

// 后续镜头可用上一步图片作为首帧；也可以传 lastFrameAssetId。
const guided = await ctx.action({
  id: "guided-clip",
  action: "local-video",
  input: {
    prompt: "镜头缓慢推进",
    firstFrameAssetId: image.output.imageAssetId,
    frames: 39,
  },
});

const speech = await ctx.action({
  id: "narration",
  action: "local-tts",
  input: {
    text: "欢迎来到今天的故事。",
    language: "Chinese",
    speaker: "Vivian",
  },
});
```

也可以本地调用：

```ts
const run = await host.invokeAction("local-tts", {
  mode: "demo", // 不调用语言模型；本地模型 Action 在两种 mode 下均执行真实生成。
  input: { text: "你好，Aura。", language: "Chinese" },
  signal,
});
// run.status === "completed" 时读取 run.output；否则检查 run.error。

const status = await host.invokeAction("local-ai-service", {
  mode: "demo",
  input: { service: "qwen3-tts", operation: "status" },
});
```

授权 Agent 使用时，在已有 `ctx.agent()` 参数中设置 `actions: ["local-image", "local-video", "local-tts"]`；工具调用仍由 DSH 调度和记录。没有新增通用 HTTP Action 执行接口。

`local-ai-service` 的 `operation` 为 `status | start | stop`：start 等到 HTTP 就绪，同服务重复 start 复用进程并续期；stop 只停止 Aura 自己拥有的指定服务。stop 与生成共享队列，不会中断已执行的 Action；立即中断需取消正在运行的 Action / Flow。status 不占用 GPU 队列。

### 受管图片资产

`POST /flows/assets/images` 接受请求体为原始 PNG、JPEG 或 WebP 字节（设置对应 `Content-Type`），最大 32 MiB，成功返回 `{ assetId, mimeType, width, height, bytes }`。此端点可供 Web 或移动端上传用户选定的参考图；不通过 DSH JSON-RPC 传二进制。后端解码校验后按内容哈希保存在 Aura 受管资产区。`local-image` 生成的图片也会登记到同一资产区，并在原有 `{ service, seed, files }` 之外返回 `imageAssetId`。Flow 后续只传图片资产 ID，不传用户文件路径或 base64。

图片资产保留供后续运行复用；上传端点不启动模型，也不占用 ComfyUI 端口或 GPU。

## 参数与输出

### 自定义 ComfyUI workflow

必须从 ComfyUI 导出 **API 格式**（节点对象包含 `class_type` 和 `inputs`），而不是含 `nodes`、`links`、坐标等信息的界面画布 JSON。支持直接节点图和 `{ "prompt": 节点图 }` 包装；不转换画布文件，也不自动安装节点或模型。

```js
const result = await ctx.action({
  id: "custom-image",
  action: "comfy-workflow",
  input: {
    service: "qwen-image", // 或 minimax-h3，选择对应的 ComfyUI 实例
    workflowFile:
      "packages/backend/orchestration/docs/examples/solid-image.api.json",
    overrides: { source: { width: 512, height: 512, color: 2250116 } },
    outputNodeIds: ["saved", "preview"], // 可省略，默认收集所有 UI 输出节点
  },
});
// result.output: { service, promptId, workflowHash, files, outputs }
```

[solid-image.api.json](examples/solid-image.api.json) 是可以直接使用的 ComfyUI API 图，仅生成纯色图片及预览，不加载大模型。换成自己的图时，`overrides` 的节点 ID 和输入名也应对应自己的节点。

也可以直接传对象：`input: { service: "minimax-h3", workflow: yourApiGraph, overrides: { "6": { prompt: "新的提示词" } } }`。`workflow` 与 `workflowFile` 必须二选一。节点参数覆盖只修改已有输入（包括连接数组），不会猜测提示词所在节点，不会修改原 JSON 对象或文件。

需要参考图的 API 图先放置 `LoadImage` 节点，再传 `imageBindings: [{ nodeId: "16", assetId: "<图片资产ID>" }]`。目标必须是已有 `LoadImage.image`；后端用受管文件名替换该输入，在启动 ComfyUI 前将校验过的图片复制到本次任务专用的 input 目录。可选的 `resize: { width, height }` 会以 cover 裁切到指定画幅。不同图片或裁切尺寸会改变固定的 workflow hash。直接写在 API 图里的普通 `LoadImage` 文件名不会自动上传或解析。

- `workflowFile` 支持绝对路径和相对 **Aura 后端工作区** 的路径，不相对 JSON 文件所在目录解析节点里的资源引用；每次调用重新读取。排队前固定图内容和 SHA-256，之后文件修改不影响正在运行的任务。
- JSON 入参、workflow 文件、合并后的图及返回值均限制在 256 KiB 内，图最多 512 个节点。ComfyUI 负责节点类型、连接、模型等语义校验。
- `outputNodeIds` 仅筛选返回结果，不裁剪执行图；其他输出节点仍会运行，但它们的中间文件不会保留。指定节点必须存在并返回 UI 输出。
- `outputs` 按节点 ID 返回原本的 UI 数据（包括文本等非文件结果）；保存或预览文件描述符额外带 `path`。`files` 是这些本地路径的去重列表，没有文件的文本 workflow 也能成功。
- 收集 ComfyUI 标准 `type: "output" | "temp"` 文件描述符，包括保存图、保存视频、音频和预览；单文件最大 512 MiB，总计最大 1 GiB、最多 64 个文件。只移动本次目录内的文件，不移动 ComfyUI input 文件或其他任务的产物。
- 每次受管 ComfyUI 实例的 input、output、temp 目录均隔离；绑定图片在执行结束或取消后删除，已登记的原始资产保留。不提供远程 ComfyUI URL、自动重试或画布 JSON 转换。
- 自定义节点是现有 ComfyUI 的受信任 Python 代码，不是沙箱。节点若忽略 ComfyUI 标准目录、写任意绝对路径或调用外部服务，其外部副作用无法由 Aura 自动撤销；标准输出目录、临时目录和受管进程树会回收。

本地后端同样可以调用 `host.invokeAction("comfy-workflow", { mode: "demo", input, signal })`。授权 Agent 时加入 `actions: ["comfy-workflow"]`。`local-image` / `local-video` 现在只是同一执行器的预置模板，保留原来的参数及 `{ service, seed, files }` 返回结构。

### 预置生成 Action

- 图片：`prompt` 必填；`negative` 可选；宽高默认 1024，范围 256–1536、16 的倍数，总像素不超过 1328×1328；`steps` 1–50、默认 30；`cfg` 1–10、默认 4。
- 视频：`prompt` 必填；可选 `firstFrameAssetId` 和 `lastFrameAssetId` 指定受管图片资产，省略两者时仍为文生视频。图片先按目标画幅 cover 裁切，接入 MiniMax H3 的首末帧输入。默认 608×352，宽高 256–608、32 的倍数，总像素不超过 608×352；`frames` 为 22、39、56、73、90、107、124，默认 39；固定 24 fps、8 步 Turbo。更复杂的引导图节点请用 `comfy-workflow`。
- TTS：`text` 必填；`mode` 默认 `custom-voice`，可改 `voice-design` 或 `voice-clone`；预设音色默认 `Vivian`，可用音色和语言由 Action Schema 列出；`instruct` 描述预设音色的情绪或语速。
- 声音设计：`mode: "voice-design"`，另传 `voiceDescription`。
- 声音克隆：`mode: "voice-clone"`，另传 `referenceAudio` 的本地绝对路径（不超过 30 MiB）和 `referenceText`；只提取音色时可省略参考文字并设 `xVectorOnly: true`。参考文件只读，不会删除。
- `maxNewTokens` 为 TTS 输出 token 上限，16–8192，默认 2048。提示词 / 文本最多 10000 字符。三种生成均支持 `seed` 0–2147483647；省略则随机，返回实际值。

成功输出保留 `{ service, seed, files: string[] }`；`local-image` 另带 `imageAssetId`。文件保存在 **Aura 后端机器**，不是浏览器下载 URL。运行记录仅保存路径和资产 ID，不嵌入二进制。成功产物会保留，磁盘空间需要用户按需管理；不会自动删除用户产物或模型文件。取消 / 失败会在进程退出后删除本次任务的临时产物，已有成功任务不受影响。硬崩溃可能留下该任务的未完成文件，但不会自动重放生成。

## 资源所有权

- 三种模型共享单个 GPU 队列；Flow 并行、Agent 工具和直接调用都进入该队列，避免在 16GB 显卡上同时装载多个模型。队列等待也计入 Action 的 10 分钟超时。
- 生成成功、失败、取消或超时后，均停止本次持有的服务进程树并等待退出，再释放 GPU。TTS 的 HTTP 断开不能终止 Python 推理线程，因此不是只取消 fetch。
- 单独 start 的服务最多空闲 60 秒；TTS 生成可以复用它，结束后仍回收。ComfyUI 执行使用每次独立的输出和临时目录，因此会重启受管实例应用该目录配置，不复用显式 start 的实例；通常直接调用生成 Action 即可。切换模型前先停止原来由 Aura 启动的服务。
- ComfyUI 完成后先将所选保存/预览产物移至本次任务的 `artifacts/`，停止进程后删除本次 `comfy-output/`、`comfy-temp/`。失败则删除整个本次任务目录；已有成功产物、workflow 源文件和模型部署目录不动。
- 跨 Aura 宿主使用 Windows 命名 mutex 防止同时占用 GPU；另一宿主持有时立即失败，宿主崩溃后 mutex 自动可恢复。
- 复用 DSH `subprocess` 的启动、环境变量清理、有界内存日志和正常进程树回收。在其上通过 DSH 的公开 Win32 bindings 增加 kill-on-close Job：worker 先归入 Job，再允许启动 Python。即使 DSH 被强杀，OS 也会回收其模型子孙进程；父 Aura 连接断开时也主动关闭编排宿主。
- Action HMR 只替换定义，不拥有进程。管理器由后端插件持有，不因 Action 更新或删除而丢失进程引用；运行完成仍会回收。
- 检测到三个固定端口之一已被外部进程占用时拒绝启动或生成，不接管、不全局 interrupt、不按进程名杀 Python。就绪后及复用前还会通过 DSH 执行系统端口查询，并确认监听进程属于本次 Windows Job，避免启动期间被外部服务抢占端口。外部服务请先手动停止。其他不使用这些端口的 GPU 应用不在 Aura 控制范围内。
- 所有服务仅监听 `127.0.0.1`。TTS 使用每个宿主生成的内部 API key，不写入 Action 记录。进程输出只保留有界内存尾部，不积累临时日志文件；HTTP JSON 响应上限 2 MiB，TTS 下载上限 64 MiB，单个 ComfyUI 产物上限 512 MiB。

## 验证

常规测试不加载真实模型：

```powershell
pnpm --filter @aura/orchestration exec tsx --test test/local-ai.test.ts test/local-ai-process.test.ts
pnpm --filter @aura/orchestration typecheck
pnpm --filter @aura/orchestration test
pnpm run check
```

真实部署冒烟测试显式启用，会依次调用三种 Action，消耗显存并保留小规模样本及独立测试 DSH 记录到 `.aura/local-ai/`：

```powershell
$env:AURA_TEST_LOCAL_AI = "1"
pnpm --filter @aura/orchestration exec tsx --test test/local-ai-live.test.ts
Remove-Item Env:AURA_TEST_LOCAL_AI
```

可额外设置 `AURA_TEST_LOCAL_AI_ACTION=local-image,local-video` 只验证指定生成 Action。测试参数用于验证 API、输出和生命周期，不代表最佳生成质量。

单独验证自定义 ComfyUI workflow 的真实链路（两套 ComfyUI，纯色图不加载模型）：

```powershell
$env:AURA_TEST_COMFY_WORKFLOW = "1"
pnpm --filter @aura/orchestration exec tsx --test test/comfy-live.test.ts
Remove-Item Env:AURA_TEST_COMFY_WORKFLOW
```
