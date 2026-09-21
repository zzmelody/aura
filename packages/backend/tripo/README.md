# @aura/tripo

Aura 后端的 Tripo v3 适配层。它使用官方 `@vastai/tripo-sdk`，负责 Tripo 鉴权、
文本/图片生成任务提交和任务状态脱敏；HTTP 路由仍由 `@aura/runtime` 负责。

本地开发时把 API Key 作为单行文本写入仓库已忽略的
`.aura/tripo/api-key`。部署环境也可以设置后端环境变量 `TRIPO_API_KEY`。密钥不会进入
HTTP 响应、日志、前端存储或源码。

默认连接海外站。国内站账号设置 `AURA_TRIPO_REGION=china`，海外站可显式设置
`AURA_TRIPO_REGION=global`。两个站点的账号和 Key 不互通。

通用 HTTP 边界支持 text-to-model、通过 HTTPS URL 或已有 file token 的
image-to-model，以及异步任务状态查询。除此之外，后端还提供受限的
`aura.tripo.game-asset` Action capability：依次生成前、左、后、右四张 GPT Image 2.5
参考图，再用 Tripo P1 生成受面数约束、带 PBR 且按米缩放的 GLB。宿主会在短时 URL
失效前下载图片、模型与预览，并把它们和 provenance manifest 原子发布到调用方指定目录。

game-asset capability 不接受 API Key、上游 URL 或任意 Tripo payload。可选本地参考图只允许
PNG/JPEG/WebP 且不超过 20 MiB；输出目录必须是绝对路径，单个模型下载上限 200 MiB。
整条图片链路串行执行，以遵守 Tripo 默认单任务图片并发池。付费任务不自动重放。
单张图片任务最多轮询 90 秒，模型任务最多轮询 2 分钟；调用方 Action 的总超时为
10 分钟，超时或取消都会沿同一个 `AbortSignal` 停止后续等待与下载。
