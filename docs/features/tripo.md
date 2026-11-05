# Tripo 3D 接入

Aura 默认发现随产品发布的 `aura.tripo` 插件。插件声明并接管 `/tripo`，其后端负责调用 Tripo v3 SDK、持有凭据和记录付费阶段。

## 配置与连接检查

在 Aura 的「设置 → 插件 → Tripo 3D」打开设置页，也可从「工作台」进入。连接设置和预算分别保存。测试连接使用已经保存的配置，仅查询账户余额。

- `GET /tripo/status` 返回地区、能力、配置状态及设置 revision。
- `POST /tripo/settings` 只接受本机请求。提交当前 `revision` 和 `region`，可用 `key` 保存密钥或用 `clearKey: true` 清除密钥。提交后返回新 revision。仍有已提交且待结算的 HTTP 任务时，先查询任务状态。
- `POST /tripo/check` 只接受本机请求，通过查询账户余额检查连接。
- 部署可用后端环境变量 `TRIPO_API_KEY` 提供密钥。环境变量优先并使设置只读。尚未保存地区时，`AURA_TRIPO_REGION=china` 使用国内站，默认 `global` 使用海外站。

配置写入忽略目录 `.aura/plugins/aura.tripo/settings.json`。HTTP 响应、日志和模型上下文中都没有 API Key。迁移后需要重新配置插件的 Key、地区和预算。

## 预算与恢复

在插件设置页可调整总额度、单组上限和各阶段额度，也可选择不限额度、继续记账。修改预算会保留已有的预留和付费记录。

付费任务先在插件目录读取用户配置的 `budget.json`，再向 `paid.json` 写入预留。HTTP 提交和插件 Actions 共用账本。可以按以下格式在 `.aura/plugins/aura.tripo/budget.json` 配置额度，示例数字是用户设定的上限。

```json
{
  "schemaVersion": 1,
  "accountingUnit": "tripo_credits",
  "maxCredits": 200,
  "maxScopeCredits": 80,
  "imageStageCredits": 10,
  "modelStageCredits": 40,
  "cloudStageCredits": 10
}
```

任务提交结果未知时，账本阻止后续付费请求，直到用户核对上游并结算。已知任务 ID 可以继续查询。同一个 HTTP 幂等键和相同输入返回原任务 ID，输入变化需要新键。

## HTTP API

文生 3D 任务提交示例。

```http
POST /tripo/tasks/text-to-model
Content-Type: application/json
Idempotency-Key: compass-001

{
  "prompt": "a low-poly brass compass",
  "model": "v3.1-20260211",
  "texture": true,
  "pbr": true,
  "faceLimit": 3000
}
```

提交成功返回 `202` 和 `{ "taskId": "..." }`。图生 3D 使用 `POST /tripo/tasks/image-to-model`，在同样的请求头下提供 Tripo 可访问的 HTTPS 图片 URL 或已有的 file token。

```json
{ "image": { "url": "https://example.com/reference.png" }, "texture": true }
```

使用 `GET /tripo/tasks/:taskId` 轮询并结算终态任务。返回值包含任务状态、进度和已知模型或预览 URL。上游下载 URL 有效期较短，成功后应及时读取或持久化文件。

## Flow Actions

| Action ID               | 用途                                                                        |
| ----------------------- | --------------------------------------------------------------------------- |
| `aura.tripo/game-asset` | 生成四张一致的 GPT Image 2.5 视图，经 P1 生成 GLB，登记模型、视图和预览产物 |
| `aura.tripo/image`      | 生成单张图片，返回受管产物，可同时登记为会话附件                            |
| `aura.tripo/ledger`     | 只读查看一个 `scope` 的付费记录及待结算状态                                 |

调用方可用不透明的 `scope` 分组，`noNewPaidWork` 仅允许复用已付费结果。两个生成 Action 都使用手动恢复语义。

已声明 `aura.tripo.game-asset` 权限的插件可以继续调用 `generate`、`image` 和 `ledger`。这些调用转交已启用的 Tripo 插件，并使用插件的设置和账本。

[Tripo 官方 JavaScript SDK](https://github.com/VAST-AI-Research/tripo-js-sdk) · [Tripo v3 API 文档](https://developers.tripo3d.ai/en/docs/introduction)
