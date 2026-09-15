# @aura/tripo

Aura 后端的 Tripo v3 适配层。它使用官方 `@vastai/tripo-sdk`，负责 Tripo 鉴权、
文本/图片生成任务提交和任务状态脱敏；HTTP 路由仍由 `@aura/runtime` 负责。

本地开发时把 API Key 作为单行文本写入仓库已忽略的
`.aura/tripo/api-key`。部署环境也可以设置后端环境变量 `TRIPO_API_KEY`。密钥不会进入
HTTP 响应、日志、前端存储或源码。

默认连接海外站。国内站账号设置 `AURA_TRIPO_REGION=china`，海外站可显式设置
`AURA_TRIPO_REGION=global`。两个站点的账号和 Key 不互通。

当前第一阶段支持 text-to-model、通过 HTTPS URL 或已有 file token 的
image-to-model，以及异步任务状态查询。生成接口只返回 task ID；调用方轮询任务接口，
成功后应立即消费模型 URL，因为 Tripo 返回的下载地址是短时有效的。
