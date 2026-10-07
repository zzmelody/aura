# Tripo 3D 接入

Aura Runtime 通过独立后端包 `@aura/tripo` 接入 Tripo 官方 v3 API。客户端只访问
Aura 的 Hono 路由，API Key 只由后端读取，不进入响应、日志或浏览器存储。

## 配置

本地开发推荐把 Tripo API Key 作为单行文本保存到：

```text
.aura/tripo/api-key
```

`.aura/` 已被 Git 忽略。部署时也可以使用后端环境变量 `TRIPO_API_KEY`；环境变量优先于
本地文件。不要使用 `VITE_*` 变量，也不要把 Key 放入前端 `.env`。

Tripo 的国内站与海外站账号、Key 不互通。Runtime 默认连接海外站：

```text
AURA_TRIPO_REGION=global  -> https://openapi.tripo3d.ai/v3
AURA_TRIPO_REGION=china   -> https://openapi.tripo3d.com/v3
```

本机客户端通过授权的 `/ai/services/tripo` 保存 Key 与地区，后续请求动态读取，无需重启 Runtime；仍有制作任务时拒绝修改。`TRIPO_API_KEY` 存在时界面只读。`POST /ai/services/check/tripo` 使用官方 SDK 查询账户余额，不提交付费任务；失败提示不透传供应商响应。`GET /tripo/status` 只返回 `configured`、区域、API 版本和能力列表，不会返回凭据。

## HTTP API

提交文生 3D 任务：

```http
POST /tripo/tasks/text-to-model
Content-Type: application/json

{
  "prompt": "a low-poly brass compass",
  "model": "v3.1-20260211",
  "texture": true,
  "pbr": true,
  "faceLimit": 3000
}
```

提交成功返回 `202` 和 `{ "taskId": "..." }`。可选字段包括 `negativePrompt`、
`textureQuality`、`geometryQuality`、`quad` 与 `generateParts`。

图生 3D 当前接受 Tripo 可访问的 HTTPS 图片 URL，或调用方已经持有的 file token：

```http
POST /tripo/tasks/image-to-model
Content-Type: application/json

{ "image": { "url": "https://example.com/reference.png" }, "texture": true }
```

```json
{ "image": { "fileToken": "existing-tripo-file-token" } }
```

轮询任务：

```http
GET /tripo/tasks/:taskId
```

返回值是稳定、脱敏的 Aura DTO，只保留状态、进度、错误和已知模型/预览 URL，不透传
Tripo 未文档化字段。Tripo 的模型下载 URL 有效期很短，状态变为 `success` 后调用方应
立即消费或持久化文件。

当前接口不代理任意 Tripo task payload，也不支持浏览器把本地文件直接上传给 Aura；
这避免把一个带付费额度的通用上游代理暴露出来。后续需要模型转换、贴图、减面、绑骨
或上传时，应在 `@aura/tripo` 增加明确的类型化能力和独立的 body/文件大小限制。

## 插件 capability

受信任插件可在 manifest 声明 `aura.tripo.game-asset`，再通过 Plugin SDK 调用唯一的
`generate`（模型）、`image`（单张图片）和 `ledger`（只读付费账本）操作。`generate` 不是通用代理，而是一条固定的付费链路：

1. 无参考图时用 GPT Image 2.5 文生前视图；有参考图时先上传受限的本地
   PNG/JPEG/WebP，再用图生图得到前视图。
2. 以该前视图为身份参考，串行生成左、后、右三个正交视图。
3. 把四张一致视图交给 `P1-20260311`，生成有面数上限、PBR、UV 和米制缩放的 GLB。
4. 立即下载四张图片、GLB 和可选预览，写入临时目录；全部验证成功后才原子改名发布，
   同目录保存不含签名 URL 和本地参考路径的 `manifest.json`。

默认图像模型由插件选择 `chat_image_2.5_sunburst`，也可显式选择速度档
`chat_image_2.5_flare`。付费任务使用 Action 的手工恢复语义；未知提交结果不会自动重试，
避免重复扣费。

每个付费阶段先在 `<root>/.aura/tripo/`（`budget.json`、`paid.json`）中预留再提交。调用方可传入不透明的 `scope` 给付费工作分组并设置单组上限；`noNewPaidWork` 只复用已付费结果，拒绝新的付费请求。被拒绝的预留不写入账本。

实现依据：[Tripo 官方 JavaScript SDK](https://github.com/VAST-AI-Research/tripo-js-sdk)、
[Tripo v3 API 文档](https://developers.tripo3d.ai/en/docs/introduction)。
