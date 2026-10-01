# Veya Creator 本机服务

此文档描述 Aura 宿主边界。真实世界/交互物制作、原生导出和渲染验收由 Veya 插件与打包 worker 提供；游戏 UI、CreationHost 托管和正式交付属于后续接入。协议测试不能证明真实生成成功。

## 用户接手测试（2026-10-01）

按用户要求，自动真实验收已停止。**没有 prepare 或提交第 3 轮 successor，没有新 Run。** 当前请求仍为 `efd3e2ff-86b8-45c8-9ec0-45be49103361` / 根 Run `0c0ca738-b122-48e3-b43c-40d665a2ae89`，已完成、领域结果 blocked。交接核对时，Aura 旧 PID 87480 已退出、4312 无监听；Veya worker PID 46124 仍运行，启动于 03:34:09 UTC。PID 仅是当时观察。本次未重启或提交，未改 current/identity，未操作用户 4311。

`service:true` 提供宿主服务入口，不会自动建立 Aura UI 的创作表单、worker 注册或游戏交付界面。**请使用 Creator API 或下列 CLI**；普通 Flow UI 启动不能代替 Creator 绑定。四类编排、恢复/复用、预算、候选验证及成果传输已实现；产品 UI、CreationHost 自动管理/排队、正式交付是后续接入。E2 最终视觉及普通输入往返、E3/E4/E5 完整实际验收和 macOS 运行仍未验证。

以下仅为用户手动命令，未执行。先在 PowerShell 设置变量：

```powershell
Set-Location F:/aura
$acceptRoot = 'C:/Users/15389/.codex/worktrees/wishing-altar/aura-world-e2e'
$pluginRoot = 'C:/Users/15389/.codex/worktrees/wishing-altar/creative/aura-plugin'
$identityFile = "$acceptRoot/.aura/creator-acceptance/identity-0146.json"
$workerInfo = 'C:/Users/15389/.codex/worktrees/wishing-altar/creative/build/creation-external-grants-validation/worker'
$workerDescriptor = (Get-Content -Raw -LiteralPath "$workerInfo/launch-config.json" | ConvertFrom-Json).descriptor
if (-not (Test-Path -LiteralPath $workerDescriptor)) { throw '请先恢复对应 creator worker，取得当前描述符' }

# 终端 A：4312 未监听时启动，保持运行；不会启动 Veya。
pnpm --filter @aura/runtime exec tsx test/creator-acceptance/cli.ts serve --root $acceptRoot --plugin $pluginRoot --port 4312
```

终端 B 设置相同变量。当前包/身份记录见 `$workerInfo/ready.json`，描述符含凭据，不要打印或复制其正文。catalog 应有 81 项可用贡献，交接插件版本 0.15.9。worker 若已退出，先按 Veya 打包说明恢复同 session，不猜 endpoint。

当前隔离项目为了复用旧资产，配置了新模型数量为 0。测试新的文本生成前，编辑 `$acceptRoot/.aura/world-agent-budget.json`，保留原字段，将 `maxAiAssets` 设为本次允许的数量（例如 1；宿主支持 0–6）。`maxCharacters:0`、`maxRepairRounds:3`、`maxSkyImages:0` 可以保留；现有 `unlimited:true` 是货币策略，不能代替数量配置。本文未修改该配置，也未触发付费。

另写 `$acceptRoot/user-case.json`，格式为 `{"operation":"create_prop","text":"本次需求"}`。operation 可选 `create_world`、`create_prop`、`update_layout`、`update_environment`。保留原 identity 文件；新任务选择新的稳定 UUID，回执未知时保持该 ID，只重试 submit。

```powershell
pnpm --filter @aura/runtime exec tsx test/creator-acceptance/cli.ts catalog --root $acceptRoot
$caseFile = "$acceptRoot/user-case.json"
$requestId = [guid]::NewGuid().ToString()
# 保存 $requestId；只有开始新任务才重新生成，重试不要再次运行这一行。
# prepare 会更新当前请求指针；先保留旧指针，旧 Run/绑定不会被覆盖。
Copy-Item -LiteralPath "$acceptRoot/.aura/creator-acceptance/current.json" -Destination "$acceptRoot/user-handoff-original-current.json"
pnpm --filter @aura/runtime exec tsx test/creator-acceptance/cli.ts prepare --root $acceptRoot --case $caseFile --identity $identityFile --request-id $requestId
pnpm --filter @aura/runtime exec tsx test/creator-acceptance/cli.ts register --root $acceptRoot --worker $workerDescriptor
pnpm --filter @aura/runtime exec tsx test/creator-acceptance/cli.ts submit --root $acceptRoot --worker $workerDescriptor
pnpm --filter @aura/runtime exec tsx test/creator-acceptance/cli.ts status --root $acceptRoot
```

两种 update 操作须在 prepare 命令追加 `--previous-artifact '<已核验世界成果SHA256>' --target '<实际授权JSON绝对路径>'`。目标格式为 `{worldId,baseRevision,baseHash,allowedEntityIds,allowSpawnChange}`，取自同玩家/session 的真实保存目标，宿主会核对 lineage 和玩法契约；不能猜 hash/实体或把当前 blocked E2 当成已有导出成果。详见 [目标模板](../packages/backend/runtime/test/creator-acceptance/target.template.json) 和 [CLI README](../packages/backend/runtime/test/creator-acceptance/README.md)。

status 出现真实 checkpoint 时，另写 `user-answer.json`：`{"commandId":"新的稳定UUID","checkpointRunId":"真实RunUUID","stepKey":"真实stepKey","answer":{}}`，其中 answer 必须按该 checkpoint 的 schema 填写。技术 blocked 不能用任意答案跳过。

```powershell
pnpm --filter @aura/runtime exec tsx test/creator-acceptance/cli.ts answer --root $acceptRoot --answer "$acceptRoot/user-answer.json"
pnpm --filter @aura/runtime exec tsx test/creator-acceptance/cli.ts status --root $acceptRoot
# 任务终态后，可读取费用并停止此隔离服务。
pnpm --filter @aura/runtime exec tsx test/creator-acceptance/cli.ts paid --root $acceptRoot
pnpm --filter @aura/runtime exec tsx test/creator-acceptance/cli.ts stop --root $acceptRoot
```

当前隔离项目数量策略为新模型/角色/云图 0、最多 3 轮修复，货币 unlimited；文本不会自行放宽数量限制。当前源码宿主全检查为 397 项/390 通过/7 项明确跳过，插件为 81 定义/346 测试通过。新的第 3 轮 live admission 和实际修复结果未执行。

## 本机身份与固定 worker

仅 loopback listener 挂载 `/veya/creator/v1`。`<Aura root>/.aura/veya-creator/session.json` 保存启动随机凭据，原生客户端使用 bootstrap token 注册 `{playerId,homeWorldId,workerSessionPath}`，取得独立 bearer token。CEF、Flow 和模型不接触凭据。此机制是本机可信进程边界，不是公网生产鉴权。

上述 bearer/owner 校验适用于 Creator 命名空间。Aura 原有 `/flows` 开发接口仍属于同机可信宿主接口；验收工具通过它收集 durable 树。本轮没有给整台 Aura 增加多用户或敌对本机进程隔离，不能把 Creator 路由测试表述为所有 Aura API 的生产认证保证。

worker descriptor 要求 `protocol:veya-world-http/1`、`role:creator-worker`、`creation_session_id:<32 lowercase hex>`、精确 IPv4 loopback URL 和 64 hex token。生成、交换和截图根目录继续由 worker descriptor 提供；新增 `creation_root` 仅供宿主成果传输。该 session ID 必须与 `--creator-worker=<id>` 一致，同一任务重启 worker 时复用它。

`bindings.json` 在启动 Run 前落盘，固定玩家、个人广场、请求指纹、session ID 和 descriptor 路径；启动返回后增加根 Run ID。后端沿父子 Run 找到根 `veya/veya-wish`，每次解析核对绑定身份和 descriptor session ID。缺失、换实例、角色不匹配时失败，不回退到前台。普通 World Agent 保留默认会话行为。早期没有 session ID 的试验绑定不能继续执行，须建立关联的新任务，不能猜测旧副作用。

## HTTP 接口

所有正文有 32 KiB 限制，持久任务索引有 256 KiB 容量限制。

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| POST | `/clients` | bootstrap 凭据注册原生客户端 |
| GET | `/status` | 连接及 `veya/veya-wish` service 可用状态 |
| GET | `/tasks` | 当前玩家和个人广场的任务引用 |
| POST | `/tasks` | 创建或认领稳定请求 |
| GET | `/tasks/:requestId` | 产品状态及当前 checkpoint |
| POST | `/tasks/:requestId/answer` | `{commandId,checkpointRunId,stepKey,answer}` |
| POST | `/tasks/:requestId/cancel` | `{commandId}` |
| POST | `/tasks/:requestId/resume` | `{commandId}` |
| GET | `/tasks/:requestId/artifact` | 已核验成果 manifest 的原始 JSON 字节 |
| GET | `/tasks/:requestId/artifact/blobs/:blobId` | manifest 引用的单个哈希 blob 字节 |

新请求使用 `{requestId,operation,text,targetWorldId?,target?,references?,previousArtifactId?,previousRequestId?}`。operation 为 `create_world`、`create_prop`、`update_layout`、`update_environment`。旧 `kind:world|prop` 映射到创建操作。references 只接受有界 `sha256:<hex>` 引用，previousArtifactId 为 64 hex；引用并不自动赋予读取其他任务成果的权限。

局部修改的 `target` 为 `{worldId,baseRevision,baseHash?,allowedEntityIds,allowSpawnChange}`。它只允许用于 update 操作，必须与 targetWorldId 一致。实体授权集合规范排序后纳入完整请求指纹。仅有 targetWorldId 的旧请求仍可登记，但 Wish 必须以缺少授权范围阻断修改，不能推断全世界写权限。

相同 requestId 的所有规范化字段固定；更换操作、目标 revision、权限范围、参考或文本返回 409。重复答案先登记命令及指纹，再调用既有 durable answer。回执丢失后按同一 commandId 重试，即使 checkpoint 已不显示也能由原编排宿主去重。已完成回答保存回执；不同内容复用同一 commandId 被拒绝。

同一 worker session 的另一未结束请求返回 `worker_busy`（409）；不会并行修改同一验证场景。`interrupted` 与 completed/failed/cancelled 均为 terminal，不继续占用 worker；未知付费仍由共享账本独立阻止。完整待执行队列留给后续 CreationHost。

试玩另有宿主持久租约 `playtest-leases.json`：begin 发出前记录所属根 Run、稳定 request 和 worker session；取得 operation 后，通过该 operation 的成功结果绑定精确 playtest_id。正常 end/poll 后释放。取消先保留该占用，再停止并等待 durable 执行退出，由宿主使用独立信号和原生 `playtest.end` 的精确 ID guard 清理，未依赖取消后的 Flow Action。旧 Run 的取消不能停止另一个 Run 的试玩。

清理回执丢失时先读取当前状态：确认没有试玩才释放；仍是自己的 ID 时使用稳定清理请求继续。网络不可用、身份改变或 begin 回执丢失且没有 operation ID 时保留 needs_attention 和占用，不猜测当前试玩所有权，不重发 begin。重复取消可以重新核对清理。此时即使 Aura Run 已是 terminal，创作服务仍阻止新任务并投影 cleanup:needs_attention。宿主重启会读取同一租约。

未加载或未启用 service 的 Wish 返回 503，不创建伪 Run。领域 blocked 结果不成为可交付状态；只有读取到并核验原生成果才显示 pending_delivery。游戏必须在自己的持久交付完成后显示“愿望实现”。

## Creator context capability

插件 manifest 声明 `aura.veya.creator`，Action `veya/creator-context` 调用 `context`，入参必须为 `{}`。后端从 Action durable runId 查绑定，返回：

```text
{schemaVersion:1,creationId,homeWorldId,operation,targetWorldId?,target?,previousArtifact?,artifactTarget?,recovery?,
 budget:{maxAiAssets,maxCharacters,maxRepairRounds,maxSkyImages},
 worker:{role:'creator-worker',platform:'windows'|'macos'|'unknown'}}
```

默认数量上限为 6/2/3/0，部署可降低；明确配置 maxSkyImages 为 1 才允许一次云图。平台标记来自本机宿主，不能替代实际 renderer 证据。预算路径、凭据、endpoint 不返回模型。

返回 context 前还会对固定 worker 发起只读 `veya.system.context`，核对 module.write/read、export、checkout、draft.compose、playtest.save_resume、preview.performance 的真实 canonical 工具目录。仅有 creator-worker 角色但缺少所需工具的旧包得到 `creator_worker_upgrade_required`；连接失败得到 `creator_worker_capabilities_unavailable`。这项检查发生在任何规划/付费之前，不把旧包未知工具留到生成结束后才发现。

同名工具也必须提供当前验证语义。`system.creation_verification` 需要声明 `progress_projection`、`creation_geometry`、`stable_interaction_ids`、`authored_identities`，每项均为至少1的整数版本；缺少、降级或类型不合法时同样返回 `creator_worker_upgrade_required`。`authored_identities` 保证 `world.read(include_authored_entities:true)` 能从原生 authored typed snapshot 返回 `authored_entities:[{id}]`，不从 Lua 文本猜测身份，不激活或写入目标世界。检查直接查询该 Run 绑定的进程，不使用默认前台目录或陈旧的静态工具清单；错误只包含固定能力名称，不返回endpoint或凭据。绑定测试覆盖只广告旧三版本的真实 transport 路径：在任何生产前拒绝且不访问前台。真实新包的能力声明另在实际验收记录中核对。

2026-09-30 最新宿主全仓 `pnpm run check`：工作区规则及所有类型检查通过；Orchestration 171 项中164通过、7跳过、0失败；Runtime 47 项中46通过、1失败（`site.test.ts:381` 多项目并发预览端口归属未确认）。该断言后测试自身遗留10个子进程，核对本次父子PID与创建时间后只清理这些子进程，runner随后汇总退出1；用户服务及Veya worker未动。聚合不算通过，后续根目录测试阶段未执行。完整本机记录为验收root的 `aura-final-0141-check.log` 与 `aura-final-0141-check-cleanup.json`；此前四项失败记录保留各自时间背景，不代替本轮结果。

关联新制作可以指定 `previousArtifactId`。服务先核对同 player/home、同 creationSessionId、前序 completed Run 以及不可变 manifest 字节哈希，才将 `previousArtifact:{artifactId,kind,candidateHash}` 写入绑定并返回 context。引用一个可猜测的哈希不能取得别人的成果，也不能跨 worker 读取。未知、未验收或篡改成果返回 `previous_artifact_unavailable`（409）。

以成果为基础进行局部修改时，请求额外提供 `artifactTarget:{allowedEntityIds,allowSpawnChange}`，与 target/targetWorldId 互斥；完整修订不接受 artifactTarget。context 返回该原始授权范围。新 Action `veya/creation-checkout` 对应 canonical `veya.creation.checkout`，原生入参 `{request_id,artifact_id,content_hash,mode}`。Aura 再次确认两个 hash 字段都等于绑定成果 ID：局部只能 overlay，完整只能 recompose，prop 不可走局部世界编辑。原生建立隔离副本后，调用方把实际 world/revision/hash 与既有 artifactTarget 组合；不得扩大 allowedEntityIds。普通未绑定 Flow 无权通过该工具猜 ID。

原生 canonical 工具新增 `veya.creation.module.write/read`、`veya.draft.compose`、`veya.playtest.save_resume`、`veya.creation.export`、`veya.preview.performance`。性能工具遇到 `performance_not_ready` 时在同一调用内使用相同请求轮询，最多 35 秒；截图沿用 10 秒边界。取消信号传入所有等待。

## 预算与付费恢复

所有创作子 Run 共用 `<Aura root>/.aura/world-agent-budget.json` 与 `world-agent-paid.json`，不因 worker 的输出目录变化而重置。用户最新决定将创作额度默认设为无上限。绑定 Creator Run 在没有策略文件时采用 `{schemaVersion:1,unlimited:true,accountingUnit:"tripo_credits"}`；可显式保存相同策略。没有 Infinity 数值，也不填造供应商价格。无上限账本以 `unlimited:true,reserved:0` 标记阶段，仍登记实际费用并阻止未知提交或未知实际费用。

显式有限策略仍受尊重：`maxCredits` 为项目总额度，`maxCreationCredits` 为一次创作上限；imageStageCredits、modelStageCredits、cloudStageCredits 为配置的预留上限。数量与修复轮次限制不因 monetary unlimited 放宽。旧独立模型调用在未配置策略时仍保持原有失败行为。

云图和四视图目前都由同一个 Tripo SDK/client 计费。只有部署明确声明 `accountingUnit:"tripo_credits"` 时云图才可加入该账本；不推断货币转换。其他单位、有限模式缺少阶段额度、未知费用或有限模式超额均停止新付费。未知实际费用保留记录，不能解释为零。

稳定付费身份为创作 ID 加 generationKey（可选 SHA256；没有时使用请求指纹）。模型 workspace 名称取完整身份的 hash，避免同一任务的多个资产共用目录。不同 prompt 复用同一 key 被拒绝。提交前预留并写入 submitting；供应商返回 task ID 后立即登记，再等待或下载。已知 task ID 可以继续查询，未知提交结果禁止重发。

云图原始付费字节按 hash 存在 `.aura/world-agent-cloud/`。登记/视觉附件失败后复用字节，不再请求供应商。模型继续沿用既有产物保留和恢复。Creator 模式的模型结果仅包含任务、费用、模型参数和受管资产引用，宿主实际文件路径仅留在账本；普通独立模型调用保持原结果兼容。未知提交、未知费用和有限模式超出预留都会阻止项目新增付费，需操作者核对账本；本轮未增加自动核销工具。

### 付费成功但尚未导出的交互物恢复

`previousRequestId` 是一个窄恢复入口，只接受同玩家、个人广场和 worker session 的 `create_prop`。原任务必须已经 failed，或 completed 且领域结果 blocked；操作和原始文本固定，不允许附带其他目标、参考或 previousArtifactId。它创建关联的新根 Run，保留旧 Run 的版本身份和历史，不对失败历史做原地改写。

宿主遍历原 Run 的有界子树，核对父子关系，取得已经通过输出 schema 的 CreationBrief、PropSpec、effectPlan 和 ready 资产结果；同时逐个核对供应商 task ID、实际费用和共享付费账本。缺少完整产物、未知费用、未知提交结果或仍运行的 Cooker 操作均拒绝。恢复 JSON 不接受客户端输入。

通过检查后，受信 context 增加 `{schemaVersion:1,sourceRequestId,sourceRunId,noNewPaidWork:true,brief,propSpec,assets,generationScope,repairRound,plan}`。其中 plan 是原 effectPlan，repairRound 保留原有 0–3 修复轮次，assets 保留原有费用和供应商证明。付费宿主继续使用原创作预算身份；即使 monetary unlimited，新付费阶段或 key 仍被禁止。已知任务可以查询，已经完成的资产可以重新导入、处理和验证。恢复不把原来发生的费用清零，也不把这些费用计为新 Run 的新增扣费。

如果关联恢复仍在后续安全阶段失败，下一请求可引用这次最近失败的 request。由于恢复跳过 Gameplay Design，宿主只允许已经持久化并获准的 recovery.propSpec 作为设计证明，并再次比较当前 Prop input 和资产结果；不能用任意 Flow input 代替证明。已知失败的 Cooker 结果可以继续诊断，未知或仍运行的操作必须先核对。

## 成果读取

Wish 返回的 `output.artifact` 必须是原生导出结果：`{schema_version:1,artifact_id,content_hash,candidate_hash,kind,verified:true}`。宿主从该 Run 固定 worker 的 creation_root 读取 `artifacts/<artifact_id>.json`，验证文件 SHA256、候选哈希、类型和 session ID。仅相信 Flow 顶层 verified 布尔值的旧投影已移除。

manifest 引用 `blobs/<sha256>.bin`。传输验证每个请求 blob 属于 manifest、长度和 SHA256 相符，拒绝路径逃逸。manifest 上限 2 MiB，单 blob 128 MiB，最多 512 个 blob，总引用容量 512 MiB。资源的 res:// 路径和相对封装路径可留在内容 manifest；宿主绝不把 descriptor 根路径或凭据添加到公共元数据。挂载或正式交付仍由前台原生校验负责。

## 检查与限制

窄测试：

```powershell
pnpm --filter @aura/orchestration exec tsx --test test/contribution-hash.test.ts test/discovery.test.ts test/veya-creator-bindings.test.ts test/veya-creator-lifecycle.test.ts test/tripo-budget.test.ts test/veya-cloud-image.test.ts test/action-capabilities.test.ts test/plugin-live.test.ts
pnpm --filter @aura/orchestration exec tsx --test test/veya-creator-lifecycle-live.test.ts
pnpm --filter @aura/runtime exec tsx --test test/veya-creator.test.ts test/veya-creator-artifacts.test.ts test/veya-creator-recovery.test.ts
pnpm run check
```

协议夹具覆盖隔离、请求冲突、回答回执丢失、已知云图任务恢复、付费字节复用、额度和成果篡改。真实模型生成费用、两台打包 Veya 隔离、Windows/macOS renderer、性能及完整游戏交付仍需 Veya 的实际运行记录支持。

### 2026-09-30 本机检查记录

- 全仓 `pnpm run check`：workspace 与全部 typecheck 通过；Orchestration 155 通过、7 跳过；Extensions 6 通过；Tripo 9 通过。Runtime 22 通过、5 失败，整体退出码 1。
- Runtime 失败均在未修改的 `test/site.test.ts`：备用端口归属、外部端口保留 stop handle、启动中取消/并发启动、直接开发脚本选端口、多项目并发。报告为系统进程查询工具无法确认端口归属。测试遗留进程使退出等待，检查父进程链后仅停止本次 site test 及其子服务器，保留完整失败日志。未将这些失败认定为已证实的历史基线。
- 最新创作相关窄测 24/24、Runtime Creator 2/2 通过；随后新增性能 `performance_not_ready` 同请求重试与取消检查，canonical 工具测试 8/8 通过。
- `plugin-live.test.ts` 使用真实 DSH/HMR：共享 helper 修改改变贡献 hash；进程内已固定版本仍可完成；新宿主重启后在原 checkpoint 回答时拒绝以新代码恢复，得到 `revision_mismatch`。该检查通过，不代表真实 Veya 内容已通过。
- 单独的本机 E2E Aura 实例使用隔离 root 和仅指向 Veya 重构工作区的插件配置，模型身份检查 authenticated、Tripo 配置可用；前台默认描述符故意设为不存在路径。供应商费用、候选和 renderer 结果由后续实际 Run 证据补充，不能由身份检查推断。

实际 Creator 入口首次试运行记录：请求 `369d16e8-f11e-440a-bba9-734ef1f0235d` / Run `2b87bbdf-0879-41fa-adf5-c9d51c0ebca6` 已由 `/veya/creator/v1/tasks` 创建并固定打包 worker。Run 在 `plugin/main/context` 因插件 Action 缺少 `output.render` 而失败；未进入 Agent 或付费阶段。插件侧随后修复该注册缺口。另通过实际 ActionRegistry 检查定位 `atmosphere-build` 的 `minimum/maximum` DSL 不兼容；当前记录不计为 E6 或 E1 通过。

后续真实 E6 发现直接 Action 的恢复版本检查丢失已持久化 plugin 身份，导致未改源码也被判 revision_mismatch。已修复引用构造，并使用实际 DSH 插件 Action + checkpoint/HMR/重启测试验证，仍保留版本不匹配拒绝。失败 Run `d3f8babc-62ec-4567-b4cc-1e1523cd6a30` 为终态，保留历史、费用为零。新 Run `c43a66a7-4f9f-4fbf-bbda-b1a8f778192e` 已真实进入 checkpoint，回答 reading 后继续同一 Run；重复回答返回 accepted，没有第二个理解步骤。内容制作和费用验收尚不能据此宣告通过。

当前本机完整运行证据与待补项目见 [隔离 E2E 报告](C:/Users/15389/.codex/worktrees/wishing-altar/aura-e2e/verification.md)，包括所有失败、请求/Run/answer ID、包哈希及实际制作进展。该路径是本次机器证据位置，不是运行时依赖。

随后实际 Run `b44d911b-0d1e-4bd5-9d2c-5cda7d2f5454` 完成四视图、真实模型生成和原生导入，供应商实际费用共 90 Tripo credits（四张图各 10，模型 50）；在 Prop Prepare 的无效 Cooker Lua 源路径处失败。生成字节、导入资产和全部五个供应商任务已保留。新增恢复测试及真实 durable 输出提取检查通过；尚未导出成品，不计为 E1、性能或保存恢复验收通过。

关联恢复 Run `b8f10862-06e2-4946-8684-9ad8ae83d4bc` 实际跳过理解和设计，复用同一资产及供应商记录，新增扣费为 0。它提交一个 Cooker operation 后得到确定失败：`run-recipe` 不接受 `provenance` 字段。根 Run completed/domain blocked 正确投影为 not_ready。没有修改历史或放宽验收；内容仍待专业 Flow 修复并通过真实验证。最新 Runtime 创作窄测 3/3、预算 7/7 及 typecheck 通过。

第二次全仓检查（2026-09-30 06:00 UTC）仍以 1 退出：workspace 与全部 typecheck 通过；Orchestration 168 总项中 161 通过、7 跳过、0 失败；Runtime 28 总项中 24 通过、4 个未修改的 Windows site preview 测试失败（备用端口、启动取消/并发、直接脚本端口、多项目）。外部 listener 测试本次通过。完整日志为本机 `C:/Users/15389/.codex/worktrees/wishing-altar/aura-host-check-final.log`。本次只停止已核对父链的测试子服务器来解除退出等待，不隐藏失败。新增真实 DSH checkpoint 后取消清理测试通过，但 native 接口为 loopback 夹具，不能替代打包 Veya 取消验收。

恢复过程中若旧 PropSpec 因明确语义缺陷发生一次 Gameplay Design 修订，后续关联恢复还会核对该设计子 Run 的输入、设计前后 hash、原正文以及尺寸/资源/验收等固定字段；只有完整受信证明才保留新 PropSpec。客户端仍不能提交修订 JSON。

当一次恢复仅在只读设计修订阶段被拒绝，且尚未进入制作，下一请求也可引用该最近 request。宿主要求整棵 durable 子树仅含 Wish/Specialist/Gameplay Design、已完成的 creator-context/system-context 只读 Action，以及没有任何 Action 权限的 Agent；所有输出为 blocked，原受信 context.recovery 必须与绑定一致。任何隐藏子 Run 写入、付费能力、未知步骤或未完成副作用均拒绝。原绑定与付费账本重新核对，被拒的新规格不作为恢复证明。

恢复还可保留同一个已完成 Prop Prepare 子 Run 的 `preparation` 回执与处理后资产。宿主核对原始 sourceBindings、处理后的 preparedBindings、锁定尺寸/轴心/运动包络/展示方式与资源需求哈希、recipe/pipeline 哈希及回执哈希，并要求费用记录与原 World Assets 完全一致。没有回执的已处理碰撞产物被拒绝；不把不同 attempt 的资产和回执拼接，也不将已经缩放的结果再当原始模型处理。

可复用、无机器路径与凭据的真实验收入口已纳入仓库：[creator acceptance harness](../packages/backend/runtime/test/creator-acceptance/README.md)。它包含参数化启动、稳定请求提交、状态/回答/取消/关联恢复、费用快照与manifest/blob验证，以及E1–E5夹具模板。真实身份、预算、授权实体和供应商记录由各自隔离测试root提供，不随代码分发。

对于原生 Cooker 已成功而 Flow 最终 JSON 返回失败的情况，恢复证明增加只读 `preparedOperation`：固定 Prepare Run/spec hash、原始绑定、裁剪后的 res:// 资源目录、已提交的 Luau 配方与 pipeline、已完成 operation/request ID、原生登记资产 ID/hash。真实工作目录、日志路径和凭据不进入该证明。插件必须先通过只读目录核对，使用同一可信模板重建并逐项比较原提交，再只生成 preparation 元数据；不再运行 Cooker。

宿主还拦截相同 pipeline/sources/inputs 的重复 Cooker 提交，忽略新 Run 的 request ID 和等待超时，返回 `creator_prepared_operation_reuse_required` 及已完成 opaque operation ID。实际不同配方仍须满足原有缺陷归属和有界修复规则。未知或未完成的 Cooker wait 拒绝关联恢复；不能退回原始模型路径盲目重做。

下游 compose 失败时，已完成 PropAgent 的 `retainedProp` 也可进入受信恢复上下文。宿主要求同次 durable 模块登记回执、module ID/hash、锁定 spec hash、资产/费用与 preparation 全部一致；模块仍需原生 read 和候选 compose 验证。`ready` 仅表示模块已登记，不能据此跳过验证。只有明确归属于该模块的缺陷才能消耗同一修复轮次重新 author，不重付费、不重做已完成 Cooker。

若后续 Run 仅复用该模块并再次在 compose 被明确拒绝，可继续转发同一受信证明，无需虚构新的 PropAgent 子 Run。此分支要求固定 `recovery-prop-module` 步骤的输入/输出 ID/hash 与宿主 prior 完全一致，整棵树限于 Wish/Specialist/Build 和已允许的只读/测试草稿操作；compose 仅提交该模块，异步 operation 必须有匹配终态。未知连接/超时、隐藏新 author/付费、其他模块写入均拒绝，原修复轮次不重置。

原生失败继续抛有界 ActionFailure，保留稳定 code；结构化诊断通过 `diagnostics=<JSON array>` 后缀持久化，最多三条、1400 ASCII 字节。字段白名单为 code、stage、module_id、namespace、entity_id、component、field、line；自由错误文本、文件路径、源码与堆栈均不转发。Flow 只能从明确模块身份作修复归属，未知归属应报告宿主阻断。

2026-09-30 07:10 UTC 的关联恢复 `0c76979c-0b83-456d-9ea5-76509f2ce25d` 已实际复用成功 Cooker 的只读证明：PropPrepare 仅执行 catalog，恢复 preparation receipt `bc0069d4257149752e0f109d5f44726c268ed1155bd2bc9ffb15974edb00aff9`，新增付费与 Cooker 提交均为零。PropAgent 产生并登记模块后，Build compose 被 native 422 拒绝，尚无候选验收或导出。最新 capability 窄测 9/9、恢复窄测和 Runtime typecheck 通过；全仓仍以此前明确记录的 Windows site 测试失败为准。

2026-09-30 08:01 UTC 的实际关联 Run `2eb996b5-9ad7-441e-8055-c3cb3728d37d` 已将旧模块的精确 `invalid_feedback_cue` 诊断交回同一协调者，修复轮次1后组合出候选 `72ee285b72a93cf79848830bcdd6683e2b50fafb7cb8efb77dd2ca0fc9da21e5`。新增付费和 Cooker 提交均为零；真实首读、保存卸载重建以及无特效整场景采样已执行。采样指标是 `max_viewport_cpu_gpu_ms`（排除限帧等待），752样本的p95=2.794ms、p99=3.115ms；不能据此宣称完整前台帧延迟。后台制作期间独立正常 CharacterInput 测试取得31个真实running交集样本，位移3.457m且世界/实例/epoch/revision不变。

该Run仍为blocked/not_ready：重复阅读需要的typed关闭节点未投影；实际截图虽显示可读中文对话，但铭牌不可见、画面为大型浅黄色盒，视觉验收正确失败。没有导出成品，E1/E2及整体功能仍未完成。最新完整本机证据在隔离验收root的 `verification.md`；可用上述仓库内harness复现。前述恢复路径又补充了prepared assets与原raw来源receipt的精确核对；不能因为同时保留成功operation证明而二次Cooker。

实际原生资源元数据检查确认该候选的模型已加载，但准备后的尺寸与锁定规格不符。宿主现在支持显式 `reconcile-preparation` 运维命令：核对同一失败候选、已登记模块、原 preparation 回执、原生报告 SHA、live catalog 和 raw/visual/collision 三份真实资源 SHA 后，将不可变证明存于受管目录。恢复只收到有限的 `preparationDefects`，不接收文件路径或自由报告；仍保留原修复轮次并禁止新增付费。HTTP/Flow 无权创建此证明。2026-09-30 本机请求 `3bb80796-363f-4d46-8d56-2507207e5b4e` 的证明已成功登记，round=1；这仅授权下一轮准备修复，不表示新内容已通过验收。新增证明/恢复窄测 2/2、Runtime typecheck 通过。

最近一次完整 `pnpm run check` 仍退出1：全部 workspace/typecheck 通过；Orchestration 169总项（162通过、7跳过、0失败），Runtime 28总项（23通过、5失败）。五项失败均位于未修改的 Windows `test/site.test.ts`（备用端口归属、启动取消/并发、预检后端口占用、直接脚本选端口、多项目并发）；未将它们标为已证实的历史失败。日志在本机 `C:/Users/15389/.codex/worktrees/wishing-altar/aura-host-check-current.log`。退出等待期间仅清理已核实为该次失败测试所属的子服务器进程，保留失败记录。

现有进度的局部修改可组合 `previousArtifactId` 与 `target`，仅适用于布局/环境操作。此时target必须含当前baseRevision/baseHash和明确实体范围，不能再传artifactTarget；请求指纹覆盖这些字段。creator-context从同一target派生只读artifactTarget，前序artifact仍须同owner/home/worker已验收。Flow通过配对的world.read `artifact_id`/`artifact_content_hash` 与 `expected_revision`/`expected_content_hash`取得原生lineage；宿主严格匹配绑定且拒绝此分支调用checkout。原生需验证原checkout journal、artifact和当前authored hash，允许已保存进度后的新revision，返回可信edit_context。客户端不能提交prior/context。真实保存前后进度保留仍须E4/E5实际验收，HTTP与绑定测试不替代该证据。新增组合/权限/幂等窄测与现有创作回归共5/5通过，Runtime及Orchestration typecheck通过。

受信几何修复绕过WorldAssets时，后续恢复仍可保存新准备结果：要求原host缺陷、原previousAssets/receipt、修复轮次递增和durable source catalog完全匹配，再继承已核费用。新成功Cooker拥有自己的operation证明，不能把旧recipe证明附到新receipt。宿主按同付费身份的持久绑定历史拒绝旧、新已完成提交的重复指纹；改变过的合法配方继续经过有界修复。

上述修改后的最终全仓检查（2026-09-30，`aura-host-check-post-lineage.log`）已终态退出1：全部workspace/typecheck通过；Orchestration169项为162通过/7跳过/0失败，Runtime29项为25通过/4失败，新增reconciliation及全部creator测试通过。剩余四项仍为未修改site.test的备用端口、启动取消/并发、直接开发脚本、多项目进程归属检查。Windows监听查询多次超出既有10秒超时；两棵已失败测试子服务器经父链核对后回收，测试进程自行输出终态。没有删改失败项，也未把全仓标为通过。

2026-09-30 09:35 UTC，关联请求 `199eb364-41d1-44d7-b378-c29d60d4857a` / Run `42f15d45-4a63-4726-9e61-dfde415ede16` 实际执行宿主允许的几何修复，保留原供应商五个任务及90 Tripo credits；新增付费为零。新 Cooker `cook_4fa11d0cf32d3dfef61bfd5716c52b36` 成功，准备回执 `e2494cceb48e8a2b501304c8266c5a422f707a3693b6cc7f5d4c2427d6b17a56`，候选 `fbea7177ee33322a822d213d2b5b4b12fa00b350c1eb544363e239f673687927`。实际目标近景已显示平放的黄铜、深蓝珐琅月星铭牌。真实E8取得31个running交集样本、3.457m位移且scope不变；正式性能采样在E8退出约90秒后执行，743样本的p95=2.421ms、p99=3.159ms，指标仍是排除限帧等待的viewport CPU/GPU最大值。

该Run仍未通过：验证Agent将领域 `talk` 错用于 `character-act` 的已定义角色动作名，得到 `action_missing`，没有实际执行可用的 `action-perform talk`。首次已读状态仍false、对话未打开，重复阅读因缺少active dialogue被阻断。保存重进通过只证明当时false事实被保留，不能声称已完成阅读后的状态持久化。视觉检查另要求把正文刻在模型表面，此要求与对话阅读证据的边界需进一步核对。没有导出artifact。服务已正常退出；离线恢复证明保存了repairRound=2、新准备回执与模块，后续不得重付费或重复成功Cooker。

纯模块复用后若再次验证失败，关联恢复也可保留同一模块：必须从成功Build及原生compose回执证明候选，完整核对已结束的Verify/Baseline/Interaction/Visual子树、同候选试玩begin及结束回执。子树仅允许测试域动作、截图/性能/保存恢复与只读/导航Agent；隐藏模块写入、资产/Cooker/付费、正式世界操作、不同候选、未结束试玩均拒绝。此检查只保留成果和费用，不将失败验证改为通过，也不改变worker祖先绑定。新增恢复及拒绝测试2/2、Runtime typecheck通过；全仓四项site失败结论不变。

下一真实请求 `4ba847f4-4de7-46e9-9b98-2827bacde9b9` / Run `570bab59-eeca-485b-902d-ecc4b63c9055` 复用同一候选，没有PropAgent、Cooker或付费调用。领域talk正确提交，但验证器只等到tick1502（提交tick1499），动作id1仍为elapsed=0.05、committed=false，其定义commit_time=0.55秒。后续同Run的tick4347已观察到firstRead=true和正确正文、合法关闭选项，保存重进也保留已读状态。整体视觉和性能通过（753样本，p95=2.455ms/p99=3.056ms）；首读/重复验收仍因提前观察失败，因此未导出。纯复用验证失败后的受信恢复已用此真实子树通过，round2、准备回执和原90credits保持。该运行没有再次执行E8，引用上一同包测试而不宣称本Run重叠。

已补齐现有 `veya.character.inspect` 的Aura canonical转发与恢复只读白名单；Creator在制作前检查此能力。插件可用同action_id读取完成回执，不能把submitted当完成或重新提交动作。此次12项相关窄测及Runtime/Orchestration typecheck通过；实际等待及重复阅读需下一次真实Run确认。

### 2026-09-30 10:17–10:23 UTC：真实交互物导出及复用检查

请求 `b90ad1df-4559-45a1-beba-8486ddd063e5` / Run `6bc6d3fb-d09b-44ed-88ff-2b2374e5cc13` 已在固定插件版本（81项贡献、152项测试通过）和上述 Windows Vulkan 包上完成真实验收并导出。候选仍为 `fbea7177ee33322a822d213d2b5b4b12fa00b350c1eb544363e239f673687927`，成果为 `350bf5719ff74996b348d774d9941e1ef33a51d0a1eb819079835080c238053d`。本次只复用已登记模块，没有 PropAgent、Cooker 或新增供应商调用；原五个任务、90 Tripo credits 保持不变。

- 首读与关闭后重读分别等待同 scope 的 action 1/2 到 `succeeded + committed`，随后独立观察已读状态和锁定正文；两张真实截图包含全文和关闭选项，绘制序号分别为275093→275104、275125→275144。
- 保存、卸载、重建后 instance 从 `27794c823649e493c27f6ee3eabe4eef` 变为 `e2600825d8fabb6f74d12f86fffce477`，epoch1→2；已发生的阅读进度比较通过，authored候选保持固定。
- structure、playtest、visual、performance、saveResume 均通过，effects为not_applicable。性能1459样本/10.107606秒，p50=1.463ms、p95=3.328ms、p99=8.343ms、max=15.280ms，仍是排除限帧等待的viewport CPU/GPU最大值，不是完整前台帧延迟。该次没有同时运行E8；先前同包E8证据独立保留。
- 成果manifest为50196字节，文件SHA与成果ID一致；服务实际读取9个引用blob并逐个核对SHA及长度，未引用blob被拒绝。production元数据保留原managed模型、供应商task和费用；Cooker provenance保留原始资源哈希。供应商许可证未返回，模块的`project-generated`只描述模块源码，不能充作AI模型许可证。
- 独立复查首读/重读图片时曾因并行图片呈现提出缺面板疑点；按单张原始文件及SHA重新检查后，重读图片`279252211f3dacc9d9b7e8643bbc380c.png`（SHA `189863d8f820229f89ab5f8295252ae18e38952fc45fcf82202a37175c9a1b14`）确实包含完整正文。该疑点已撤回，没有修改生产代码或图片，也不作为捕获缺陷记录。

后续E10六类篡改均被实际原生接口拒绝，但未篡改成果的正向checkout在 `pinned_asset_version_unavailable` 处失败，记录见Veya `build/creation-validation/e10-350bf/artifact-acceptance.json`。因此生成、验证、导出和受管读取已有证据，成果重新组合复用仍为阻断项，不能据此宣称完整交付或后续E2–E5通过。服务已清洁退出；所有manifest、供应商字节和运行历史保留，等待原生资源绑定问题修复。macOS、完整前台性能、20次替换及游戏内正式交付仍未验证。

随后原生修复了固定PCK内置资源的`.import/.remap`读取校验，动态生成资产的精确哈希检查不变。对同一个350bf成果重跑E10得到10/10通过：六类篡改拒绝、正向交互物checkout、保存后paired lineage、同请求重放以及活动世界/不可变字节保持；报告为Veya `build/creation-validation/e10-350bf-confirmed/artifact-acceptance.json`。旧失败记录保留。此次checkout使用新DLL `70ccab08…`、原PCK `81b3a318…`；先前E1渲染证据仍归属DLL `f270040b…`，没有冒充新包渲染。正向成果复用阻断已关闭，游戏前台正式交付仍属后续范围。

E2/E9在独立验收root执行，绑定已真实进入的个人广场，设置零新增模型/云图额度并复用原始资产。前两个真实世界Run均在只读规划/设计阶段阻断：先是WorldPlan输入遗漏完整brief，修复后实际input/output/下一层requirements逐字一致；随后玩法设计发现实体/对话引用和宿主返程验收映射冲突。没有世界写入、Cooker或供应商调用，仍不能标为完整世界生成通过。该独立项目的实际请求、源码版本和结果见 [世界验收报告](C:/Users/15389/.codex/worktrees/wishing-altar/aura-world-e2e/verification.md)。缺失的新项目账本由harness记录为`not_created`，必须结合durable树核对副作用，不能仅凭没有文件推断费用为零。

第三个E2根Run `d1603060-b66d-47ec-b612-6a051e23a0a8`（2026-09-30 11:14–11:18 UTC）通过确定性设计校验后，被设计复审越层要求硬编码个人广场ID、提前输出对话源码而阻断；仍没有制作和付费副作用。插件已收紧规划、语义设计和制作复审边界，旧Run不改写、不恢复为新代码。后续测试需等待新的干净资源目录打包Veya，不把旧PCK的资源pin问题带进下一次正式验收。

真实生成世界的正常进度往返另有参数化 [world-roundtrip测试](../packages/backend/runtime/test/creator-acceptance/README.md)：通过显式原生测试flag借用普通输入，完成实际阅读、返回profile个人广场、卸载重进和scalar恢复，再提供E4/E5的既有存档目标快照。它不改变控制器、正式author或预算，不以scratch进度代替正常存档。当前仅脚本类型检查通过，实际世界往返仍待E2成果产生后运行。

第四个E2根Run `236c1ba4-05a3-4744-a2eb-10cb5d9c6002` 使用新隔离session `a937d9c3671243a1884cf5884f939261`、真实home `08246d3f1b60e0d2d6858f43001db4a6`、干净PCK `d075841a…` 和DLL `db393b4d…`。11:48:49–11:51:31 UTC仍在只读Design停止：原draft有JSON括号错误，没有制作/供应商副作用。新增的窄 `worldDesignRecovery` 只由宿主从这类完整、无写入的终态子树提取；原text、owner、home、session、brief、Plan与原draft字节SHA全部绑定。新关联Run通过顶层受信context跳至同层设计格式纠正，不能客户端提交resume JSON、重复领取格式纠正、恢复未知写入或把未通过schema的内容当成成品。原始错误SHA为 `6ac5c11d206dd66377f6d1aa36b601b2976b0c4b911250c619c6df0d704e4e97`。相关提取、所有权、子树权限与上下文测试通过；实际纠正及后续生成仍须新的真实Run验证。

2026-09-30 12:21–12:22 UTC，关联根 Run `40fdfbc9-b251-45ab-a0b8-1f097475ade4` 的唯一 `format-correct` 模型步骤原样返回了 malformed draft（字节SHA仍为6ac5c11d…），因此正确返回 `invalid_revision`；没有进入语义修订、制作或付费。该次格式预算已消耗，记录没有改写。宿主新增一个窄续接条件：只有同一持久绑定的已准入 grant 能被完整原始祖先再次证明，且当前 Wish→WorldAgent→Design 仅执行了无工具的格式步骤、输出字节完全未变，才可向新关联任务继续传递同一原文，并明确 `formatCorrectionUsed:true`。任何改动过的输出、隐藏子任务、Plan重跑、语义修订、写入或再次续接均拒绝。插件后续采用有界纯标点规范化，不能借此再领模型格式预算；完整 schema、literal顺序及语义验收仍必须通过。此次13项runtime相关测试、2项bindings/lifecycle测试及Runtime typecheck通过；先前全仓四项site失败仍保留。

对于契约升级导致的只读复审阻断，宿主另可保留已完成的语义修订：必须完整核对原始来源、失败格式步骤及最新三节点树，最新Design只能有capabilities、revise、review-revision；terminal全部问题须与review的所有criticalIssues逐项一致，不筛选文字。保留原JSON.parse(revise)对象，`specHash` 使用其原字段顺序的JSON.stringify UTF-8 SHA；同时记录 `formatCorrectionUsed`、`semanticRevisionUsed`、`reviewRetryUsed` 为true。后续插件仅做已明确的验收分类格式迁移，再执行一次真正的只读复审；不得重写内容或重领draft/revise预算。已带reviewRetryUsed的失败后续树一律不再准入。实际da63来源specHash为 `fa201e2ec71f7401daaed8f8c402ca4cceb42d32822879a648a52de2e78bf28b`，尚未据此通过世界制作。此次15项runtime相关测试及2项绑定/生命周期测试通过，Runtime typecheck通过。

上述Design历史兼容一次明确的只读目录步骤：`asset-catalog` 必须调用 `veya/asset-list` 且输入为 `{}`；旧两步/三步记录可不含该步骤。目录用于专业设计对照原生资源类型和精确哈希，不新增制作或修订额度。重复目录步骤、其他Action或输入、额外步骤和已消耗修订的任务仍被拒绝。此次恢复窄测10/10及Runtime typecheck通过；真实bfe1/6213身份修订失败树也确认仍不可领取恢复。

最后一次关联只读复审为请求 `880760d5-8b63-4bbc-9735-16ab8394d7d7` / Run `3e2ae2d2-d3d6-464a-af68-cbad58c03fd5`（12:50–12:51 UTC，固定172插件）。迁移后的验收kind已通过严格契约，实际review-retained仍报告talk与Plan的read/interact用词、以及规格未写共享Prop Flow两项问题；所有评论原样保留，没有过滤为通过。没有制作、付费或世界成果。reviewRetryUsed已经消耗，后续不会继续发放恢复grant；若修复制作职责说明后重新开始，必须作为明确的新制作请求重新规划/设计，保留当前失败历史。完整请求、源码hash及结果见本机世界验收报告。当前只能确认E1交互物及E10篡改/复用验收，不能称E2世界完成。

2026-09-30 13:16–13:25 UTC，173版本的新制作请求 `ff382eee-cd30-4e7c-81fe-b8df5d6d2a23` / Run `7e52341c-a40b-462d-a5be-88f87e3d1130` 不带previousRequestId，重新完成Plan与Gameplay Design。实际创建了owned世界和草稿，Build已复用指定raw资源的精确ID/hash。公共程序化资产阶段出现三项确定失败：两个Agent输出分别包含多余JSON Schema字段、尾部括号错误，尚未提交Cooker；第三项Cooker的mesh及类型检查成功，scene配方因配置表参数错误停止，尚无manifest/pack/注册成品。没有进入共享Prop制作或Verify，也没有新增模型/云图供应商调用，费用记录为0。全部原输出、操作ID和安全夹具已保留，服务清洁退出；E2/E9仍未通过，不把创建空世界视作世界制作成功。

该次启动前出现过三次30秒编排初始化超时；测试用复制入口的固定阶段标记随后确认apply、loader和engine初始化均可结束，原正式入口重新启动后独立取得81项可用贡献。暂未证明先前瞬时超时的根因，没有增加超时或更改生产逻辑。测试入口已清理，配置已恢复；没有转发DSH原始stderr或凭据。

195版插件配合新validation overlay包完成了实际创作门禁：request `6c1a5bb9-3e37-4535-ab5f-6a6ccab2fe84` / Run `bfe1b848-7c49-4e38-ac25-2f3138e07006` 在2026-09-30 14:35–14:38 UTC确认固定worker的三项验证版本均为1，随后进入新Plan/Design。Plan完整需求保持一致；Design从原JSON标点错误进入唯一修订后，把本地实体`plaque`改为`reading_plaque`，被稳定身份检查拒绝（`design_identity_changed`）。尚未进行世界写入或制作，没有新增资产供应商费用；全部原输出留存，服务已退出。新包为DLL `8c65aad4…` / PCK `1a0588b9…` 的validation overlay，原生Vulkan214项测试通过并不构成生成世界外观证据，E2仍未完成。后续正式往返及E4/E5必须等真实世界成果通过验证。

199版新任务 `57f8d55f-c1d7-432f-b171-2eedb7d5be3f` / Run `8906ff1d-6118-4544-b9d2-3895931ce4c8`（15:05–15:08 UTC）实际执行了新的只读asset-catalog，初版GameplaySpec通过确定性校验。复审发现Plan擅自把已读记录推迟至关闭后，与原请求/brief及draft的首次交互记录时序冲突；完整评论保留。唯一修订又添加ownerId=targetId，被self-anchor及引用校验拒绝。未进入世界写入、资产或验证，服务清洁退出，不重置修订额度。E2仍未通过，实际夹具见世界验收报告。

208版任务 `e688dae7-8ef2-4123-8fdf-de6169dc0ad5` / Run `08246864-7c6d-473c-ba32-6322f27afdf9`（15:46–15:52 UTC）实际通过新增的只读Plan fidelity review及Gameplay Design修订/复审。创建owned世界与草稿后，公共程序化Cooker `cook_20870a375990a9c06e45def3e93c2d08` 成功并登记视觉、碰撞和导航资源，原字节保留。共享PropAgent真实被调用，但锁定PropSpec.assets与bindings均为空，作者以 `missing_asset_bindings` 正确停止；Plan/Design把指定raw和程序化资源分配给世界，没有为阅读模块声明其视觉/碰撞资源。未到布局、灯光、组合或验证导出，不重做已成功Cooker，无新增供应商费用。服务清洁退出，E2/E9仍未通过。本轮使用DLL `2c9bc1be…` / PCK `55c81989…` validation overlay；230项原生Vulkan断言仍只是宿主回归。

E3的显式验收脚本已在同一 [normal-input harness](../packages/backend/runtime/test/creator-acceptance/README.md) 增加浮空prop分支：必须有不同owner/anchor、两个实际到达的通路点及操作前至少两米正常输入位移；完整保留input回执/位置/tick/相机和保存重入事实。默认世界返程入口检查不变；prop使用可信profile-home离开验证场景，明确不视作作品门户。4项helper回归和Runtime typecheck通过，尚未实际执行E3，不能据此标记通路/碰撞/外观验收完成。

### 已完成公共资源的新任务复用

请求可指定 `reuseAssetsFromRequestId`，仅用于相同玩家、home、creationSession、原始文字的 `create_world` 新任务；它参与完整请求指纹，与 `previousRequestId`、`previousArtifactId`、目标及参考字段互斥。宿主不会把制作过的旧世界伪装成只读设计恢复，也不转移旧修复轮次、账本身份、费用、草稿或机关状态。已消耗的设计恢复资格继续拒绝。

受信 `creation.assetReuse` 为 `{schemaVersion:1,sourceRequestId,sourceRunId,items:[{requirement,binding,producer:{runId,operationId,sourceHash}}]}`，最多16项/48KiB。每项必须来自完整已结束的根任务中，唯一第一轮 Build→公共 WorldAssets→成功 Procedural/Cooker 路径；原需求在Plan/GameplaySpec/Assets/producer一致，资源不能属于PropSpec，原配方重算sourceHash与提交/完成operation严格对应。仅接纳无动作静态procedural资源及全三件套，拒绝未知费用、未结束/未确认操作、隐藏写入、改变需求和额外客户端数据。

实际上下文返回前通过同一绑定worker的只读资产目录，再核visual/collision/navigation的精确hash、注册类型和source_asset_id；缺失或改变返回 `asset_reuse_catalog_mismatch`，绝不回退默认实例。相同源配方不可因新request_id或timeout再次提交Cooker（`creator_completed_asset_reuse_required`）。新插件负责保持获准需求并将绑定注入已有WorldAssets.previous；如果新需求不兼容则阻断，不能盲目把旧整块庭院当成新独立prop。

真实082468源的只读提取已通过（1项/1136字节），安全grant保存在本机验收evidence/asset-reuse-082468.json；没有启动服务或调用worker。新增及相关runtime14项、orchestration4项测试通过，两个包typecheck通过；先前全仓四项site失败保留，未重跑无关聚合。新grant的真实Run与live catalog准入仍待后续验收。

随后0.14.0任务5f703及0.14.1任务61ad均实际通过公共grant的同worker三件套哈希复核。0.14.0因原生world.read没有authored ID字段在制作前阻断；0.14.1于17:01–17:06 UTC通过新四版本门禁，并从inactive creation-template取得9个稳定ID，随后Design原JSON有两处多余closing bracket而返回invalid_spec。没有重做Cooker、付费或世界写入，原树保持终态；不能称世界通过验收。

此类已经持有公共grant的首次只读Design语法恢复，可仅以 `previousRequestId` 关联。宿主按原有完整无副作用条件证明worldDesignRecovery，并从源binding及两个持久creator-context取得同一个assetReuse；随后重新读取其原始producer整棵树、同玩家/home/session/原文、精确requirement/binding/sourceHash和操作完成证明。新绑定同时持有两种原shape，客户端不能传组合JSON或同时指定reuseAssetsFromRequestId。预算身份仅继承本次只读设计任务，不继承公共资源生产任务；任何已使用格式/语义/复审预算的继承链、改动需求/身份/资源或隐藏副作用均拒绝。新的context仍须live三哈希核对，成功旧配方仍不可重提。

Design恢复另兼容一次精确只读 `source-entities`：必须是 `veya/world-read`、输入creation-template及includeAuthoredEntities=true，返回有效原生stable ID数组、revision和内容哈希。旧记录可不含该步骤；重复、改目标/输入、非原生ID形状和额外写入不准入。真实61ad原draft SHA12ba28ff…及原Plan/公共授权组合已只读核验（41651字节），尚未启动新的关联Run，故恢复准入不等于格式修复或成品验证通过。

### 0.14.2 关联设计结果与最终宿主检查

2026-09-30 17:19–17:21 UTC，请求 `d66e2615-383e-443c-9f3e-5790e9765d8f` / Run `e6b65014-45d9-41e6-9106-6ce4aae3a806` 实际沿61ad已准入的原Plan与公共grant继续。Wish只执行context→world，没有重做理解或Plan；世界分支重新核对固定worker的四版本及三资源哈希。插件确定性归一化仅删除原位置5197/5456的两个多余closing bracket，literal序列保持，修复文本SHA为`28356ce37e42687e2b0b8d3f2ee70a0b78dd36861819fe2ff7c0687b37ae86af`。随后唯一semantic revise生成规格SHA`c7a5842a7423390ad7a0b105afbb10816f6d065305acedcffedf08c71fe417b3`，实际review-revision仍因桌面交互点/owner规则理解返回一项criticalIssue，原评论完整保留为blocked。没有world-copy、Cooker、Prop制作、验证、导出或新增供应商费用；服务清洁退出。后续静态核查认为tabletop的不同交互点/owner本身属于原生合法能力，提示文字由插件另行澄清；这不把原评论过滤成通过，也不改旧规格或Run。

只读调用现有retainedWorldDesign对e6返回`previous_request_unavailable`：原grant的formatCorrectionUsed=false，而旧retained-review分支仅覆盖已经消耗旧模型格式步骤的true链；公共grant继承也明确仅允许首次设计续接。未改标志、未新增恢复变体、未提交下一任务。具体实际结果仍见[世界验收报告](C:/Users/15389/.codex/worktrees/wishing-altar/aura-world-e2e/verification.md)。

最终宿主结构变更后的`pnpm run check`于17:23 UTC开始，实际整体exit1。工作区检查和所有TypeScript检查通过；Orchestration 171项中164通过、7跳过、0失败；Runtime 49项中48通过、1失败。失败为`test/site.test.ts:381`多项目启动测试，该行 firstStatus.state 实际为starting而预期running；until也会因任一项目error提前返回，未取得两项目完整状态前不能归因为单纯同步race，亦不能将它写成上次的error结果。最后断言结束后，已核验该次check/site父链及10个后代的PID/父PID/创建时间，只停止2个仍存活叶进程，其他进程自然退出，runner自然输出失败总结（496685.8ms）。用户4311和Veya worker59436未受影响。完整日志与有限清理证明为本机`aura-final-0142-check.log`/`aura-final-0142-check-cleanup.json`；后续顶层测试命令未执行，聚合门禁仍未通过。

### 单次确定性格式修复后的只读复审

在完整原始Plan/brief/raw回溯成立时，首次格式续接若已经完成唯一revise与review-revision，可进入既有retainedReview的一次只读复审。此前仅支持旧format-correct模型路径，现在也支持已记录的确定性标点修复：宿主逐字核对formatSourceHash、formatResultHash、beforeHash、实际revise的afterHash，以及1或2个原始offset；每次只能删除当前JSON parser错误前32字符内、字符串外的closing bracket，重建文本必须有效JSON且精确匹配记录SHA。没有额外字符、literal、语义或旧评论改写。全部criticalIssues仍须与阻断issues逐项相等。

返回原retainedSpec，formatCorrectionUsed、semanticRevisionUsed和reviewRetryUsed全部标记已消费；再失败不能继续领取。公共assetReuse仅多允许这一固定层：重新证明first-format绑定及其原始只读树、两个层次的context/Plan/grant、相同身份/原文和原始成功producer。客户端仍仅提供previousRequestId；任何第三层、混合reference、改变资源或隐藏写入拒绝。源实体投影上限与原生一致：512项、每个稳定ID最多192字符。

真实e6只读完整证明得到原规格SHA`c7a5842a7423390ad7a0b105afbb10816f6d065305acedcffedf08c71fe417b3`、原draftSHA12ba28ff…、同e688公共grant，合计50746字节。这里只证明下一个只读复审可以执行，尚未提交，不构成世界制作通过。修改前的拒绝报告与修改后的准入报告分别保存。最终聚合检查仍需在本次最终源码冻结后执行；上次48/49失败记录保留。

0.14.3的真实关联请求b1e8e218/Run1a9e5e95已实际通过唯一review-retained，原规格SHA c7a5842…不变，且未重跑Plan/draft/revise。随后owned世界与草稿创建完成，公共WorldAssets只读catalog复用原三哈希、没有重做Cooker，共享PropAgent收到正确raw9e8b。PropPrepare仅catalog/capabilities/recipe，作者以`authored_face_orientation_unverified`阻断，未提交Cooker；没有模块、布局、环境、组合、真实验证或成果导出。原批评完整保留，服务清洁退出，未另起任务。原世界制作resume已经保留，但当前跨终态host只支持设计/独立prop恢复，不冒充已有通用world制作恢复。E2/E9仍未完成，具体Run/草稿/成本及安全夹具见本机世界验收报告。

正常世界roundtrip测试现支持显式ownerTargetId：动作仍交targetId，读取Dialogue时核对owner；缺省保持直接交互兼容。新增split/default/非法owner边界回归后5项helper测试及Runtime typecheck通过，尚无实际世界往返结果。

### Terminal world production recovery

`previousRequestId` may reference a completed, blocked world production Run with an exact durable `world.output.resume`. This path grants no new Plan, Gameplay Design, format correction, semantic revision or review retry. The host walks the complete descendant tree, verifies parent/step identities, typed retained outputs, known operation completion and the original read-only design/common-asset provenance. Unknown submissions, hidden paid Actions, unrelated world/draft writes, incomplete trees, changed identity or text, and an exhausted third repair round are rejected.

The trusted context exposes only `worldProductionRecovery: {schemaVersion:1,sourceRequestId,sourceRunId,brief,continuation:[],resume,resumeHash,noNewPaidWork:true,nextRound}`. `resumeHash` is SHA-256 of the original `JSON.stringify(resume)` bytes, without sorting, schema defaults or altered `round`. `nextRound` is separately `resume.round + 1`, bounded by the current configured limit and three. This context cannot be combined with prop recovery, design recovery, fresh asset reuse or previous-artifact grants. These values are extracted from durable storage, never accepted as request JSON. Paid Tripo/cloud entry points retain the original accounting identity and forbid new paid work.

Large immutable grants live under the host-managed `.aura/veya-creator/grants/<SHA256>.json`. Bindings carry only `{grantId,contentHash}`; the existing 256 KiB index/context limits remain. Existing inline prop/design/common grants remain readable. Hash verification and same player/home/session/text/source-Run binding occur whenever a ref is hydrated. A private proof contains the distinct source-world hash/revision, draft identity/revision/hash, the union of retained resource/module pins, and completed Cooker submission fingerprints. Public context does not expose this private proof or filesystem paths.

Before the first durable creator-context response, the bound worker is read without activation: `world.status`, explicit `world.read`, `draft.read`, `assets.list` and required exact `creation.module.read` calls. Source owner is checked against the worker profile; world and draft use their separate hash algorithms. Any changed revision, content, resource, module, foreign/active playtest or incompatible worker blocks admission. Subsequent child context calls inherit the root's completed admission receipt so a valid compose in the same Run can advance the draft. Normal native revision/epoch guards still apply to each subsequent operation. Identical completed Cooker pipeline/sources/inputs fingerprints cannot be submitted again with a different request ID or timeout; a legitimately changed recipe remains subject to the existing bounded repair loop.

Focused regression commands:

```powershell
pnpm --filter @aura/runtime exec tsx --test test/veya-creator-world-production-recovery.test.ts test/veya-creator-world-design-recovery.test.ts test/veya-creator-asset-reuse.test.ts test/veya-creator.test.ts test/creator-roundtrip-support.test.ts
pnpm --filter @aura/orchestration exec tsx --test test/veya-creator-production-grants.test.ts test/veya-creator-bindings.test.ts test/veya-creator-asset-reuse.test.ts
pnpm --filter @aura/runtime typecheck
pnpm --filter @aura/orchestration typecheck
```

2026-09-30 actual admission: request `b1e8e218-5cd6-4843-a597-b2cac5989c63`, root `1a9e5e95-1efb-4a09-ab6b-1cc05554f086`. Prepare stopped before any Cooker submission; the completed common producer remained unchanged. The 47,579-byte resume SHA is `5cdfd82efaa4c62ff47572812a3efb1b968321eb3efac1778a45fd8cc96ed7ec`; source round 0 grants next round 1. The real worker read-only preflight verified eight resource pins, the original world/draft, and unchanged active world/instance/epoch/revision/mode. This proves recovery admission, not generated-world acceptance. No new Run was submitted during this check. The prior full aggregate gate remains failed (Runtime 48/49, site startup assertion and owned test-process cleanup); focused passes do not replace the required final aggregate run.

Admission boundary: cross-terminal world production recovery currently requires exactly one World Agent child and `continuation: []`, with no production checkpoint steps in the completed tree. Already answered production checkpoints are not silently flattened into a new root; the normal same-Run durable checkpoint path remains available. Completed `veya-asset-batch` children are supported under the same complete-tree/Action proof and their existing maximum of16 requirements. Unknown/new producer Flow kinds fail closed. The current recovery extractor does not admit a source tree containing provider-generation Actions; existing paid-prop recovery remains its separate proven path. The stored private draft proof may be newer than `resume.draft` after a completed compose; both are retained, and only the latest proven native draft snapshot is compared with the live worker. This does not edit the original resume or renew any design allowance.

### 0.14.4 actual production recovery terminal

2026-09-30 18:33:06–18:38:41 UTC, request `5c712cc0-8e2a-4204-ba75-557c1af41ea9` / root `136a70af-a4b4-4d44-ba41-37c83b95aa32` passed the real production-grant admission and reused the locked Plan/GameplaySpec, source world and draft. It did not run Plan or Gameplay Design again. The shared Prop Agent finished the exact raw-model preparation: Cooker `cook_4c5e4b9c028d033bc14f9b10e607c1fb` succeeded in all seven steps, with preparation receipt `954e8d93ebf0956b5fb2f58b8eeccf2ac82c4acad043eb204dac7b473e6a9921`. Prepared visual/collision hashes are `e676003babf0e01b58bea3b37230acb671fa57be912d8242e928956060699b28` and `e43c0d0d8d262b5d3615db9bfe95e91aeb63d6b6fc7d7eeac6b7f235ea64fd45`. The common resource triple was reused without another common Cooker submission. No new provider generation or supplier charge occurred.

Prop, layout and environment modules reached ready, but each of build-1/build-2/build-3 failed native compose validation for the world behavior module (`creation_validation_failed`, author stage, namespace `logic`). The final module was `76032c57094ad3a1021afc99e77d90611c51589eeba1de4b1fb3981fbfec4b48`. The coordinator stopped at round 3 and preserved the full result as blocked. No playtest, generated-world screenshots, performance/save verification or artifact export took place. The round-3 result has no further production recovery allowance; it must not be relabeled as successful or given renewed repair attempts. The isolated acceptance service exited cleanly and no second request was submitted.

Safe inputs, immutable module references/source, the three compose diagnostics, successful preparation output and final resume are retained under the local world evidence directory `production-136a70af`. Final resume SHA: `c909209af1e6e603a9c93233e24a913c83d162953804f278d0af434d585afe9d`. E2/E9 and normal-world roundtrip remain unverified; successful Cooker/module output is not their acceptance proof. The final full Aura aggregate gate is still pending after the host production-recovery changes; the previous Runtime 48/49 failure remains recorded.

### Unverified materials for a distinct new world task

`reuseProductionFromRequestId` is a new `create_world` task's reference to immutable production materials. It cannot be combined with `previousRequestId`, `previousArtifactId`, fresh common-resource reuse, target grants or client reference JSON. The same owner/home/worker session is required. Private proof separately hashes the original source text and the new task text; neither may later change under the same binding. The old Run, its exhausted repair count and all of its validation failures remain unchanged. The new task executes its own Plan and Gameplay Design and must match the supplied material identities exactly before reusing them; a mismatch blocks production rather than silently accepting stale design.

The trusted `productionMaterials` context contains `schemaVersion:1`, `sourceRequestId`, `sourceRunId`, the source brief/Plan/GameplaySpec, `sourceExhaustedRound`, `validation:"unverified"`, `noNewPaidWork:true`, the exact ready common asset result, and ready prop results with successful preparation receipts, module hashes and precise resource dependencies. It may also contain `environmentResource:{request,lookDescription,atmosphere,effectiveRequest?}`. `request` is the original locked atmosphere declaration; `effectiveRequest` records the actual submitted controls, with only cloudAmount/cloudScale/haze/warmth/brightness allowed to change. Preset, seed, source and cloud provenance stay fixed. The completed native Cooker result and catalog prove the exact resource/sun metadata; a new environment module is still authored for the new world.

Bindings store only a hash reference to `.aura/veya-creator/materials/<SHA256>.json`. The public material payload is bounded to128KiB and the full private proof to256KiB. Private proof preserves the resource/module union and successful Cooker/atmosphere submission fingerprints. The host rechecks each resource and exact prop module on the bound worker without entering a world or reading old runtime progress. Same completed work cannot be resubmitted with a fresh request ID or timeout. All new paid model/cloud work is forbidden and the accounting root remains linked to its original identity.

The first admission deliberately supports only a complete terminal, blocked subtree already admitted through worldProductionRecovery: one World Agent, no new Plan/Design or production checkpoint, known completed producer operations, and exact original design/common-asset provenance. It does not admit arbitrary failed trees, unknown submissions, another material-reference chain, layout/lighting modules, failed world logic, old world/draft/runtime state, or another recovery allowance. Material reuse is not an accepted artifact or delivery result.

Actual136a extraction produced32,763 public bytes, SHA `9b1f17a59d1cbfc62d14dbcc6bb43d6b943fecd523b707bcece83f350a4d111b`: seven exact resource pins, one ready prop module, and three successful operation fingerprints. The old source round remains3. Host extraction and the real plugin reader passed on this metadata; that read-only result is not a newly generated world or visual acceptance.

### Final host gate for the 0.14.5 integration window

On2026-10-01, the final `pnpm run check` exited0 after workspace validation, all typechecks and357 tests:350 passed,7 explicitly skipped,0 failed. Runtime passed71/71, orchestration166/173, workbench40/40, content-research22/22, Plugin SDK3/3, remaining shared/backend suites all passed, and root integration tests20/20 passed. Orchestration skips are the opt-in real ComfyUI, four-platform content, deployed local models, single-shot video, Veya Cooker and three-shot production checks, plus macOS caffeinate. They are not claimed as executed. The related real Veya acceptance Runs remain separately recorded.

All eleven SiteRunner tests passed, including two real projects on distinct owned ports (about5.01seconds), wildcard/occupied/foreign ports, startup cancellation and process ownership. The complete command and its tests exited normally without manual termination or cleanup. The old failed aggregate logs and their explicitly recorded owned-process cleanup are retained as history. This gate resolves the previously failing current Aura aggregate; it does not claim E2/E3/E4/E5/E9, generated-world rendering, or macOS product acceptance.

The same native worker session's live read-only material admission matched all seven exact resource pins and the prop module, with active world/instance/epoch/revision/mode unchanged. The new task case preserves the complete old E2 requirement as a prefix and explicitly requests a distinct acceptance work using the pinned materials; its text SHA is `69f3074770500e79960a11dd93ae56c56af91b6c9c6263e9a9c7483b9d448662`. At this record, no new task was prepared or submitted. Local reports: `aura-final-0145-check.log`, `production-materials-136a-final-readonly.json`; private grants and launch credentials remain outside Git.

The subsequent authorized distinct task was submitted as request `2904ef07-acce-47f1-961d-d2252be2192d`, root `e845483b-45f5-4d40-86e4-520338e8c284`,2026-09-30 19:39:03.483–19:44:16.168UTC. The isolated4312 service loaded all81 contributions at plugin0.14.5; its two-turn DSH runtime smoke and invalid-request rejection passed. The user4311 service was not used. The actual creator-context retained `productionMaterials.validation=unverified`, original exhausted round3, noNewPaidWork and the requested count limits, with no production/design recovery grant.

The fresh Plan and Gameplay Design completed; the latter used one semantic revision and received an empty final critical-issue list from the unchanged reviewer contract. A new owned world `2e6146b4a31fdef1291cfd4f78054c1c` and draft `374d28bb653ed26ba45c53b9dac63964` were created. Build retained the common assets and ready prop without re-running their producers. Environment Lighting then correctly stopped at `environment_cache_request_mismatch`: all locked atmosphere controls were identical, but the new Plan paraphrased the exact source lookDescription. It performed only asset-list. There were zero new provider, Cooker or atmosphere submissions, no new module write/compose, and no Verify, rendering, performance, save or export evidence. The new task remains blocked at round0; the old136a round3 is unchanged. Full safe Plan/Design/review/Build/environment inputs and outputs are retained under `materials-e845483b`. The acceptance service exited naturally with code0, and no retry or follow-up task was submitted.

A subsequent read-only audit found that the Design draft and its revision were identical after JSON parsing (both SHA `ea63cd2dfebf8baeefb39a96e9ec637f1230935b52cda3346eeaf5666a4c9985`). The initial reviewer correctly identified that `plaque_save_reenter` was merely another reading stage; the final reviewer cleared that issue without a data change. The frozen verifier would run both optional checks before saving and require a fresh change even though the first/repeat readings had already made their scalar/text expectations true. Its real save/reload compared persistent facts, but did not execute the declared reading action after reconstruction. These are source-level findings, not results of a playtest that never ran. The supplied PropSpec remained exactly equal to the original material specification, SHA `3292b4c4dd92b53c798f0b6bc5a3011be714d420d134740d5f040e12f6767649`.

The same audit identified an unobserved world POI outcome: `reading_poi` lacked the native fact field, and no executable stage expected its discovery. Existing checks only proved definition presence and persistence equality. Actual return travel and performance while moving remain separate acceptance duties: the frozen host check proves approach/interaction availability, and its ten-second performance sample follows gameplay. Safe audit objects are retained as `materials-e845483b/verifier-contract-source.json` and `readonly-verifier-audit.json`. The audit made no native calls, changed no old output, and started no service or Run.

### Plugin 0.14.6 compatibility and pending acceptance

Plugin0.14.6 retains the existing creator HTTP requests and host material-grant shape. No Aura binding-schema migration is required. World GameplaySpec optional checks may now declare `phase:"after_interaction"|"after_save_resume"`; omission retains the former behavior. The latter executes only after actual reconstruction and successful persistent-fact comparison. Its action evidence must match the native save/resume receipt's new scope; old-instance observations cannot satisfy it. Reading stages close an already active same-owner panel through its normal available close option before observing and submitting another talk, retaining the requirement for a fresh transition. POI facts require explicit native fields/typed values and executable expected outcomes.

For admitted environment materials, World Plan receives the exact source atmosphere and complete lookIntent from the host-owned assembly step; its model output cannot paraphrase those locked fields. This preserves the existing environment resource identity without expanding module reuse or lowering verification. Old0.14.5 Run output/spec hashes remain historical bytes and are not rewritten to the new optional-check schema.

The plugin gate reported81 SDK contributions and271 passing tests (`flow-refactor-0146-final-check.log`). A distinct E2 task has been prepared offline with unchanged case bytes/text SHA `69f3074770500e79960a11dd93ae56c56af91b6c9c6263e9a9c7483b9d448662`, request identity `419796c9-d435-4428-a5f9-e4314554853f`, and the same `reuseProductionFromRequestId` source136a. It remains **not registered or submitted** while the new native package is validated. It is a new Plan/Design task, not an e845 or136a recovery. The acceptance service remains stopped, no provider work is authorized for this case, and no new renderer or generated-world acceptance is claimed.

That task was subsequently authorized and submitted once as root `d683ce26-6f4f-4018-8483-a3f33fd1963e`,2026-09-30 20:35:15.555–20:36:52.918 UTC. The freshly loaded catalog had81 available contributions and no unavailable entries; Wish sourceHash was `e0e127428e5a63f9055b3123761268b02848eb3fe19ec968286b90bb3de8a5b7`. The same worker/store used DLL `1af575ab13e73e98681683ce993cd00a252c839a459918ff763aaca7952ea77e` and new byte-reexport PCK `9fca9a568b2a2439df2c05fc36ea0a6785ce35e81fa6410c345e9fc71a4e1a6d`; this is not a clean-release claim.

It stopped at Plan `8b280931-9d4e-4f34-9b02-3906ba47d3e8`, with `plan_fidelity_failed` and all three original reviewer issues preserved. The reviewer interpreted template copy as a conflict with creating a new work and claimed that atmosphere/lookIntent had been rewritten. The actual model Plan output omitted both environment fields; the host-populated complete values exactly matched the source. Both lookIntent JSON hashes are `b35dd5c655e5fbab28b1332f09391b6171d26e21cd6913382c025255dec3d01c`. The Plan executed only `plan` and `brief-review`, with no revision or Gameplay Design. There was no world copy, provider/Cooker submission, module write, compose, verification or export. Safe complete inputs, outputs and the unfiltered review are retained under `materials-d683ce26`; the isolated4312 service stopped naturally with exit0. User4311 was untouched, and no second request or recovery was attempted.

### Plugin 0.14.7 actual terminal and subsequent test-harness check

The next expressly authorized fresh materials task used request `fa2ca390-f19d-4e85-9b2e-6cdf80a89ea4`, root `a185648a-73da-4977-9c28-64723b476b99`,2026-09-30 20:51:11.062–20:58:59.823 UTC. Case text/material reference, worker/store and1af575/9fca package were unchanged. Catalog confirmed0.14.7 with81 available contributions and0 unavailable; World Plan hash was `008c90009566ecc0b015b0bce91e3dfa0f9bf93953bfb51ace8a733835fca2e2`, Verify Interaction hash `0a310208f60ca0083d9015e3d65b76d1dcb6b21cefd8afb7387d96596e9f1df3`. Plugin gate81/273 was separate from this real Run.

Plan passed its sole revision/recheck after replacing explicit talk/interact words in its prose with generic interaction wording. Gameplay Design's initial critic incorrectly demanded a top-level appearance field absent from its strict schema and also requested additional saved POI/completion facts. Its actual revision retained the complete PropSpec (`3292b4c4…`), did not invent top-level appearance, and added `done.plaque_read=true` and `reading_poi.knowledge=visited` to the explicit after_save_resume check. The draft/revision hashes were `38b7b121e683e37e7d3441e1ad02993bac336bf7f1f2917f832c103a69cdb7b9` and `45dbe23b2b3f2fb9558fadcb6c59a5686f9191c581249689142ba011cd66193d`.

The final critic nevertheless blocked with `playability_review`, applying GameplaySpec's empty stepIds/assetIds requirement to WorldPlan's descriptive return-home steps. Both exact objects and all unfiltered comments remain in `materials-a185648a`; GameplaySpec did have empty stepIds/assetIds and the correct hostCheck. No world copy, asset-provider/Cooker submission, module write, compose, Verify or export occurred. Incremental asset-provider spending was zero; LLM usage cost was not measured and total cost is not claimed to be zero. The service exited naturally with code0, and no automatic retry/resume/new task followed.

Only after that terminal/service shutdown, the acceptance-only world-roundtrip harness gained normal-input re-approach, an independent talk receipt, owner/text/scalar observations and typed close after normal-world reentry, for both world and floating-prop cases. Seven focused tests and runtime TypeScript checking passed. These tests cover scope reuse, rejected actions, wrong owner/prose, progress loss and failed closing. No real roundtrip or GPU call ran during that change; old scalar-only reentry reports remain historical. This test-only addition does not change production Flow hashes or claim E2/E3 acceptance.

### Plugin 0.14.8 actual layout refusal

The next authorized fresh materials task used request `2f3c2c10-5cc6-4f13-b8dd-e50357e670b1`, root `51d38dd0-1094-473d-bee0-9821c4c1d00c`, 2026-09-30 21:10:25.327–21:14:54.113 UTC. Its complete case text remained byte-identical (`69f3074770500e79960a11dd93ae56c56af91b6c9c6263e9a9c7483b9d448662`). The isolated 4312 catalog loaded plugin 0.14.8, all 81 contributions available, and the frozen 1af575/9fca worker package. Plan and Gameplay Design passed their initial reviews without revision; Design hash was `1fcdef8ddac41c7eb844bf49ba2d66199f98da108be4e952d1a6c3d39ec45ff3`.

The task created owned world `d75bdb6c4b37af4c08b3edeb8f4117fa` and draft `5e1e7fdc5348d5ce35b578d385d10e47` at revision 1. Environment Lighting reused atmosphere hash `7773418e49ac638a55bf84da2a7c149ffbe94c00278cb2401530ceb79967ebfc` and produced new module `74d1d0d14c49aecb01a83b4184c18fc924c578fe3ff0e7ca145763e1b673f153`. Scene Layout then returned `missing_target_grants` for the pending prop owner/interaction-point instances and `unavailable_layout_binding` for the supplied common visual/collision/navigation assets, because they were not present in the uncomposed source world. Both original issues and the complete source/input/agent request/output remain in `materials-51d38dd0`; no reviewer result was filtered.

There was no compose, world behavior, playtest, generated-world screenshot, performance/save validation or export. Provider and Cooker submission counts were zero; LLM cost was not measured. The blocked task was preserved and the service exited naturally with code 0. No automatic retry, recovery or new task followed, and user port 4311 was untouched.

`materials-51d38dd0/source-report.json` records the cached prop's actual source: original World Agent subtree 136a, Prop Agent `3c0403fb-74d0-4ea4-9192-893a2abccd87`, Prepare `f03f54cb-3231-424f-a06d-a842c7ed7e3b`, successful Cooker `cook_4c5e4b9c028d033bc14f9b10e607c1fb`, module `ea4d06d27e85695dc0f8fa0d40d69b8d13a5d138629cfd24cf40be69cf6c6a2a` and preparation receipt `954e8d93ebf0956b5fb2f58b8eeccf2ac82c4acad043eb204dac7b473e6a9921`. The 0.14.8 task reused that material and did not invoke a new Prop Agent. Independent verification of the new candidate has not run; cached production provenance is not acceptance evidence.

### Material-backed production continuation and cancellation-test correction

After the 0.14.8 task stopped, the required aggregate check exited 1: orchestration had 165 passes, one failure and seven skips. `local-ai.test.ts` found an extra cancelled ComfyUI job directory. All typechecks passed, but recursive testing stopped before Runtime/root integration; a separate Runtime run passed 73/73 naturally. The first failed log remains `aura-final-0148-check.log` and is not replaced by later results.

A controlled write-delay diagnostic reproduced the same directory recreation in all three attempts. The fake process's HTTP close returned while its async prompt handler could still create files, unlike a stopped child process. The correction is confined to the test host: it tracks its own in-flight handlers and waits for them before returning from `stop`. A new explicit write-barrier test cancels after writing begins, verifies that closing sockets is not yet quiescence, releases the handler and checks that the cancelled job is removed. The production manager, timeouts, original directory assertion and cleanup scope are unchanged. All ten local-AI tests passed with this correction.

The existing worldProductionRecovery extractor now accepts a current task's already admitted `productionMaterials` provenance through its trusted host argument. The service reads the immutable private grant, checks its binding/identity/new-text hash, reconstructs the original producer's admitted grant and entire material-producing subtree, and compares the rebuilt proof before extraction. Model outputs or a client-supplied material object cannot substitute for that proof. The current task must still have its own completed Plan/Design, no production checkpoint, known completed effects and remaining repair allowance. Cached common/prop results must match exact host-proven outputs; the only result normalization is the shared schema's missing-to-empty effect cost-record list. Source/spec/module hashes and all nonempty records are unchanged.

The continuation keeps the current world/draft, original resume bytes, generation scope, completed environment module and current task's round; it does not resume the exhausted material producer. It emits the existing worldProductionRecovery shape alone, without an accompanying material/design/asset-reuse grant. Private completed-operation proof now retains the canonical operation kind for atmosphere as well as Cooker; old records without a kind retain their Cooker meaning. Repeating a completed source operation with a new request ID is rejected, while changed, permitted nonpaid repair work remains subject to the existing limits.

Actual read-only admission of 51d38 preserved resume hash `437c2f34cb711ec57635f08d96e8bc235bfdab6dbc7022f2ce807b5a33427221`, 60,599 public bytes, round 0 to nextRound 1, eleven exact resource pins, two immutable modules and the three original successful operation fingerprints. The real plugin reader and bound-worker world/draft/catalog/module checks passed; active world, instance, epoch, revision, mode and playtest state were identical before/after. Reports are `materials-51d38dd0/production-recovery-proven-grant.json` and `production-recovery-live-admission.json`. No new Run, world activation, provider work, Cooker or GPU validation was performed by this admission. E2 acceptance remains open.

The subsequent final `pnpm run check` completed naturally with exit 0 (`aura-final-0149-check.log`): 363 tests, 356 passed, seven explicitly skipped and zero failures. All workspace/typecheck gates passed. Runtime passed 76/76, orchestration 167/174 (the same seven opt-in/platform skips), root integration 20/20, and every other package passed. Both the original cancellation-directory assertion and the new deterministic write-barrier regression passed; SiteRunner's ownership/two-project checks also passed without manual process cleanup. The failed 0.14.8 aggregate remains a separate historical result. Production sources are frozen pending explicit authorization of a single related creation Run; this green code gate does not mark E2/E3/E4/E5/E9 complete.

### 0.14.9 associated production Run: geometry clarification and schema refusal

The explicitly authorized continuation used request `e1aca2d3-6192-4ad4-a414-932f26e60b6e`, root `d818e054-f570-4f1c-bf3c-8762e024d85c`, 2026-09-30 21:44:33.240–21:45:38.333 UTC. Catalog confirmed 0.14.9 with 81 available contributions; Wish hash `1fb9da8737f37ff394e456bedf9a3999978ca272f89f0e523b5bf9bee7c5294e` and Layout hash `1e1453d8239337b6aeded95e21edbab519430abdfdf8a25f29d70954e44ea77c`. The actual context admitted the original resume hash and nextRound 1. It reused the same world/draft and common/prop/environment outputs, executing neither Plan, Design, copy nor environment authoring again.

Layout reported `layout.missing_geometry_anchor` for the aggregate courtyard's missing table/path/navigation/obstacle coordinates and `layout.lighting_environment_out_of_scope`, stating that lighting ownership was absent despite the retained environment module. Its complete unfiltered response included the blocking text question `garden_geometry.anchors`. World Agent preserved a needs_attention result. Wish then failed while creating the clarification schema, before a checkpoint was persisted: `步骤 Schema 必须可无损表示为受支持的 JSON Schema。` Consequently there is no accepted answer or waiting_input checkpoint for this Run; the source-derived intended key is `plugin/main/clarify-1`, not a saved durable step.

Read-only reproduction traced the schema failure to `savedSchema` rejecting the current Zod built-in min_length/max_length checks because they contain internally installed `when` functions. The actual answer schema is a strict object with the question ID as a string property, minLength 1 and maxLength 2000; unmodified Zod JSON Schema conversion and reconstruction succeed. This diagnosis changed neither host nor plugin behavior. Full safe inputs, outputs, question and schema evidence are retained in `production-d818e054`.

No module write, Cooker/provider submission, compose, Verify, renderer capture, memory/performance measurement, save or artifact export occurred in this continuation. Incremental supplier spending was zero; the new acceptance project had no paid ledger and LLM costs remain unmeasured. The isolated 4312 service exited naturally with code 0. The failed root and completed blocked children remain unchanged, and no automatic retry or new request followed.

## Procedural source projections and checkpoint fault admission (2026-10-01)

The existing `aura.veya.creator/context` capability supports three bounded reads:

- `{}` returns the usual trusted creator context with optional lightweight `proceduralRefs`.
- `{proceduralRefs: []}` returns only `{schemaVersion:1, proceduralRefs:[...]}`.
- `{proceduralRefs: [ref, ...]}` returns only `{schemaVersion:1, proceduralSources:[{ref,binding,meshRecipe:{source,sha256},sceneRecipe:{source,sha256}}]}`.

Each ref is `{schemaVersion:1,requirementId,producerRunId,operationId,sourceHash,bindingHash}`. A root may expose up to 64 refs across its asset batches; 16 is the per-child batch size, not the root limit. Recipe hashes are SHA256 of exact UTF-8 source bytes; the existing Procedural `sourceHash` algorithm is unchanged. The host transports immutable Luau, without interpreting geometry or manufacturing anchors. No filesystem paths, endpoint, credentials, arbitrary root Run, or executable instructions are admitted as query parameters. Duplicate or unrecognized refs, changed catalog pins, unknown Cooker results and responses over 256 KiB fail closed; no source is truncated.

References come from the calling root's linked, completed Procedural child or a validated same-owner/home/session ancestor grant. The latter is restricted to resources already pinned by the current materials/production/asset grant. The host proves the exact two submitted recipes, successful ten-step Cooker completion and all three registered visual/collision/navigation identities, and compares the live bound catalog again. Completion may be the submit's own terminal receipt or one matching terminal wait after a queued/running submit. Unknown, duplicate, orphan or competing receipts are rejected. A normal direct World Agent can use these **source-only** queries against its own completed subtree and existing native session. It cannot obtain creator identity or access another root's material history. A missing creator worker binding never falls back to that direct mode.

The `d818e054-f570-4f1c-bf3c-8762e024d85c` root remains failed. Its checkpoint was never persisted because the old schema guard rejected Zod 4.6.5's built-in length condition. The fix recognizes only the same installed Zod function reference on native length checks; custom refine/overwrite/transform/when remain rejected. Regression tests serialize text, enum and bounded multiple-choice answers, restart a real FlowEngine, reject invalid answers and accept/replay a valid answer on the same Run.

The existing production recovery admission additionally recognizes this precise **pre-durable schema fault**: exact host error, no root output/command/checkpoint/answer, only a completed creator-context plus one complete World child, nonempty bounded questions, a previously admitted production grant, identical locked inputs and a fully checked descendant tree. No other failed root is admitted. Recovery references the actual failed request and child's immutable resume, advancing its actual round 1 to 2; it does not rewind to round 1, invent an old output/answer or modify history. All prior opaque module resource pins are retained for live admission. Unknown work, exhausted round 3, changed scope or additional steps remain rejected.

Offline admission of the actual record proved resume hash `dd2bbd6fc882e0b6790496709b0b9e3643af7cdde79c35e8f070541923582872`, 11 asset pins, two module pins and the original `garden_geometry` producer `28660d76-9a32-4494-bc69-af40ad4290d2` / `cook_20870a375990a9c06e45def3e93c2d08`. Its original mesh/scene recipes are 2217/166 UTF-8 bytes. These checks performed no service startup, Run submission, Cooker, paid work or native world mutation. Safe evidence is in the acceptance project's `production-d818e054` directory; the old failure and schema reproduction remain intact.

The first 0.15 host aggregate failed two existing ancestor-fixture tests that omitted the recorded source binding/Run. Their fixtures were completed without relaxing production ownership checks; that failed log remains `aura-final-0150-check.log`. After the 64-reference and immediate-Cooker-receipt regressions, the final aggregate `aura-final-0150-source-contract-check.log` completed naturally with exit 0: **373 tests, 366 passed, seven explicitly skipped, zero failed**, plus all workspace/typecheck gates. Orchestration passed 175/182 with the same seven opt-in/platform skips; Runtime passed 78/78 and root integration 20/20. No owned test-process cleanup was required. The focused host checks passed 36/36 and recovery checks 14/14.

At 2026-09-30 22:23:56 UTC, the 0.15.0 plugin's production-recovery and procedural-source readers accepted the actual grant. Bound native read-only admission rechecked all 11 resource pins, two module pins, source recipe provenance, world/draft identities and the four required worker capability versions. Before and after remained world `d75bdb6c4b37af4c08b3edeb8f4117fa`, instance `0ec40cdd8dbb0e2c7398ca2d805427dd`, revision/epoch 1, mode 1 and no playtest. The worker stayed PID 5028 in the same creation session. The safe receipt is `production-d818e054/production-recovery-live-admission-0150.json`.

The isolated 4312 catalog loaded 81 available contributions and none unavailable; snapshot `catalog-2026-09-30T22-23-58-904Z.json` records Wish hash `45dd5f1e26748ae182d827eef74d8789031b979231124c25a2a11200de90739f`. No task was prepared, registered or submitted. The service then exited cleanly with code 0 for a subsequent plugin correction window; this catalog is historical and must be refreshed before a new Run. No generation, renderer, save or export acceptance is inferred from these read-only checks.

An additional acceptance-only `watch-performance.ts` now polls the active Aura durable subtree at one-second intervals and reports the exact running performance Action immediately. A late first observation is explicitly `performance_missed`. Its snapshots use `watch-run-*.json`, separate from CLI status files, and it neither invokes Veya nor changes Flow timing. The post-harness aggregate `aura-final-0150-watch-check.log` exited 0 naturally: **375 tests, 368 passed, seven skipped, zero failed**, Runtime 80/80. The final snapshot filename separation was applied after that aggregate's typecheck and covered by a fresh Runtime typecheck plus the two focused watcher regressions. No real performance interval has yet been sampled with this watcher.

The E3 fixture was prepared offline by replacing only its two raw asset placeholders. The copied case `E3-floating-prop-raw-resolved-0150.json` has SHA256 `b3ec4da0f28fc6a751eb1235932afe03c36ee6b1f8c974b1f4c50e4274d111dc`; the original fixture remains SHA256 `8943d59ed75ffbb11dac2c597aa5ff039aee4216b539ccabe519350283697e5b`. It contains only `operation:create_prop` and the unchanged text around those substitutions, with no previous-request/artifact reference. Existing trusted acceptance limits remain zero new model/cloud/character generation, three repair rounds and unlimited monetary policy. Current request/client files were untouched. The raw catalog pin still requires a live check when E3 is explicitly started; fixture preparation is not E3 acceptance.

### 0.15.0 authorized production continuation

After the final plugin gate (81 definitions, 302 plugin tests), the isolated catalog was reloaded: Wish hash `5e974b726bac61da6f4d566848f97ac145a8bb75798749c3ac441abe9d1c229e`, World Agent `a1005165a46b48923837f6d60a164aac67ded1c0517a201147f08afd24ccf24b`, all 81 available. A fresh read-only admission again verified the unchanged world/draft, 11 pins, two modules and same worker/session. Its receipt is `production-d818e054/production-recovery-live-admission-0150-final.json`.

Exactly one linked request `1aeaefbd-9e2c-41bb-8a67-570ddd933b80` was then submitted, root `cd29fabc-753e-4632-84b5-a6cb7ca41cd8`, 2026-09-30 22:37:11.178–22:37:57.050 UTC. It retained the original text and source d818 grant, round 2, resume hash `dd2b…2872` and `noNewPaidWork:true`. No Plan, Gameplay Design or world-copy ran. The actual creator context exposed the original successful `garden_geometry` producer reference.

The Environment child `19725741-f8f2-4069-ba7a-b9683c79ebb9` ran catalog/source reads and its lighting Agent, then returned **blocked** with `missing_host_source_geometry` for `brass_lighting`. It reported that the locked plan requested local brass lighting around the spawn/path/plaque, while the input authorized environment/sun and supplied no local geometry/placement evidence for those points. The complete original issue was retained; no answer or invented coordinates were supplied. The previous environment module `74d1…f153` and atmosphere `7773…ebfc` remain retained materials.

The root completed with domain `blocked`/`needs_attention`, not a deliverable. No Layout, module write, Cooker/provider submission, compose, Verify, capture, performance, save or export occurred. Incremental supplier spending was zero and LLM cost remains unmeasured. The watcher exited on root terminal before any performance interval, so no OS performance sample was triggered. Safe exact inputs/outputs, terminal summary and paid report are in `production-cd29fabc`; original durable records and exhausted historical tasks remain unchanged. The 4312 service exited cleanly with code 0, without any automatic follow-up Run or roundtrip.

Subsequent offline admission through the unchanged host extractor accepted that terminal tree with **round 2 → nextRound 3**, resume SHA256 `a5ebb64010622afcadf200947f811f99c83e2399799ad9965f6809ecdea8c36b`. All 11 asset pins, the original prop/environment module hashes and all three completed common/preparation/atmosphere operation fingerprints remain proven through their admitted ancestors, although the current Environment result was blocked. The world/draft remain `d75…17fa` / `5e1…0e47`, revision 1. `production-cd29fabc/recovery-offline-admission.json` records this check and unchanged hashes of all stored Run files/bindings; `recovery-offline-grant.json` contains the resulting host proof. This performed no RPC/native call and created no new Run. It does not renew earlier repair rounds or prove a later candidate acceptable.

### 0.15.1 final admitted round

The 0.15.1 catalog loaded all 81 contributions after the plugin's 306-test gate. Wish source hash was `621eb81bc85e80cff501ffe954494c09d177dc9d9cc5ff1552987efb8a638b3c`, World Agent `c8a4fb587ac985d626771c47336bc1d3728b6be45aac201b62c2019b96b4841d`. The latest live read-only checks again preserved all 11 assets, two prior modules and the world/draft/runtime scope; the receipt is `production-cd29fabc/production-recovery-live-admission-0151.json`.

Authorized request `ad2e2441-b78a-4b2b-b9d8-6e58bc5a61c2` created exactly one root `d4a0e46d-34be-4c5f-9307-bbbc4c1ba8c3`, 2026-09-30 22:57:00.599–22:58:44.723 UTC. It executed the actual **round 3**, reusing the original Plan, design, world/draft, common/prop/prepared assets and successful-operation guards. Scene Layout first consumed the admitted original Procedural source and produced immutable layout module `5c4a03894fe8979b4fffcc4dcd38822fab51c5eef0d6b0570d2fe15465f4b7e1`. Environment then read that exact module and catalog before its lighting Agent.

Environment failed after the Agent completed, before writing an environment module. A read-only reproduction using the actual output and same helper identified `environment_undeclared_entity_write`: the author declared three local lights (`brass_arrival_light`, `brass_lighting`, `brass_plaque_light`) but its Plan-domain list included only `environment`, `sun`, `brass_lighting`. The two additional local IDs failed the current declaration guard. Full original inputs/outputs and the helper-hash-bound diagnostic are in `production-d4a0e46d`. No source, rejected output or old history was edited to make it pass.

Only the successful Layout module write occurred. There was no new provider/Cooker operation, environment/logic module, compose, Verify, renderer capture, performance measurement, save or export. Incremental supplier cost was zero; LLM cost is unmeasured. The watcher observed failed root terminal without a performance interval. The acceptance service exited cleanly with code 0. Round 3 is exhausted; this task cannot receive another production recovery round, and the new Layout module is unverified production material rather than an accepted artifact.

The subsequent read-only protocol review confirmed that this is a domain declaration error after valid JSON/schema parsing, not a JSON syntax correction. The durable engine rejects resume/resolve on terminal runs; resume requires `paused`, while resolve requires `needs_attention` plus an `unknown` step. The lighting Agent already completed, so there is no unfinished Agent output to reconcile. Changed Flow/Action code must still satisfy the existing revision check; new code cannot be substituted into this failed Run. Production recovery also requires an admissible complete tree, an actual resume and a remaining round. The actual route rejected d4a0 with `previous_request_unavailable`. No fourth round, historical result replacement or extra formatting allowance was created.

An explicitly different three-light acceptance case was prepared **offline only** as `E2-world-three-lights-0152.json`. It retains the previous complete creator text and adds three separately declared stationary local lights (`brass_arrival_light`, `brass_lighting`, `brass_plaque_light`), one `nativeLight` each, covering spawn, path and reading area. Project Luau must determine their positions from the new Layout. Its text SHA256 is `eb5a1716981a18159d18b2d4453d2badc1dc4aa4a3595d9b83b3ad3f51ff1771`; case-file SHA256 is `2902d4330ba098e03a99e3cc763f50ea83149d7ecfe51ff95608654cb3bbd2c0`.

The intended new request uses the existing `reuseProductionFromRequestId=5c712cc0-8e2a-4204-ba75-557c1af41ea9` materials mechanism, with no previous-request/artifact reference. Offline reconstruction of that original producer grant and the plugin reader passed: the same seven resource pins, one ready Prop module and three successful-operation guards are preserved. They remain unverified production materials; d4a0's Layout, old world/draft, failed Environment output and old verification state are excluded. Fresh Plan/Design must still prove exact material compatibility, and live admission must recheck pins before any authorized submission. `materials-0152-three-lights-planned.json` records the content delta and admission; `production-d4a0e46d/terminal-recovery-review.json` retains the rejected continuation. All historical Run, binding, current-request and client files remained byte-identical. No service, Run, native call, paid operation or Cooker was started by this preparation.

### 0.15.2 three-light task: actual planning blocker

After the plugin's 81-contribution/308-test gate, the isolated 4312 catalog loaded all 81 contributions. Wish retained source hash `621eb81b…638b3c`; Environment was `617dbe9c227ae983ef127aa3188b6f142b4632c9eb0c06b55cb9ac488b096a0d`. Live read-only admission rechecked the same seven resource pins and ready Prop module on PID 5028, session `beb60…791c`; the active world, instance, revision/epoch and empty playtest ID were unchanged. Receipt: `materials-0152-live-admission.json`.

Exactly one authorized independent request `8d380f3d-7caa-4e64-a28f-85c08658543a` created root `ab7939a7-4def-4967-9261-3063712d362b`, 2026-09-30 23:15:42.132–23:17:21.030 UTC. Plan `dd30d8a5-85b4-4898-8bf1-6bba9c33ffa8` declared all three light IDs individually, each with a role specifying one `nativeLight`. Its brief review reported no critical issues. The Plan nevertheless returned a gap saying the exact three light positions must be determined by project Luau after the current Layout is complete. World Agent preserved that gap and stopped before Gameplay Design or production. Root status was `completed` with domain `blocked`, not a delivered world.

The Plan hash is `fe1b61761e4bb6356dbbdeebe2a6b5456e68db3873595606cb76423715ceff76`. Original Agent text, complete Plan input/output, unfiltered review, locked source material references and terminal reports are preserved in `materials-ab7939a7`. The original Prop specification/module/preparation were admitted as materials, but no new Gameplay Design ran, so new-design compatibility was not validated. There were zero new provider, Cooker or module-write calls, no candidate or rendered evidence, and no performance interval. Incremental supplier spending was zero; LLM cost remains unmeasured. The watcher and 4312 service both exited naturally with code 0. No subsequent task, roundtrip or E3 run was submitted.

### 0.15.3 integration retest: real candidate, incomplete acceptance

After the planning-contract fix and plugin gate (81 contributions, 310 tests), a separately authorized integration retest used the **same case bytes/text**. It did not resume ab793, change its gap or renew d4a0's exhausted rounds. Catalog Plan hash was `19a5e2cd856868caf5cfebd10bfd6c579a3ee3b69a73c4c34791725abee9ee2b`; all 81 contributions were available. Live admission again verified the seven material pins and ready Prop module against unchanged worker PID 5028/session and runtime scope. Evidence: `materials-0153-live-admission.json`.

Request `d5b217a1-a432-4177-ad01-bc96c916e7e8` created root `0da6d8d7-36b7-4988-acea-1b3ddbd893c4`, 2026-09-30 23:26:45.606–23:38:47.274 UTC. The new Plan passed with no gaps; Gameplay Design passed with the original complete PropSpec hash `3292b4c4dd92b53c798f0b6bc5a3011be714d420d134740d5f040e12f6767649`. The task copied a fresh world `6d3c0118256fea2737032b50359b1705`, created draft `7515b0b8c7957657e247cf7b0d82824f`, and made new Layout, Environment and world-logic modules. The Prop module was reused from the proven 136a producer and independently tested in the new candidate; this Run did not call a new Prop producer or prepare its assets again.

Composition produced candidate `ff916810f245310449a940802192727b3268ceb20f7ffe2e98d5b662d73560b9`, draft revision 2/base revision 1. Actual Windows Vulkan Forward+ validation reported **structure passed, performance passed, save/resume passed; playtest failed and visual failed**. First/repeat reading screenshots were captured at distinct frames and UI generations with the fixed text. Ten actual PNGs were retained and their file SHA256 values rechecked against native receipts; their absolute paths, candidate IDs, renderer/package identities and frame/UI metadata are in `materials-0da6d8d7/screenshots.json`. They are evidence for this candidate, not a completed E2 or ordinary player roundtrip.

The failed playtest finding was `return-home-route: Trusted return-home interaction is missing or replaced.` Visual findings retained the reported sky/exposure differences, bright sky streaks, a large cyan obstruction and insufficiently visible overall lighting. The close-up plaque finding passed. The coordinator entered its own round 1, produced another Layout module, then Environment/Lookdev returned blocked: the permitted atmosphere controls could not reliably remove the reported non-atmosphere geometry/rendering problems. Lookdev's original reason and screenshots were preserved. Environment's generic wrapper said candidate-bound visual evidence was required, although Lookdev had actually received it; that wrapper must not be interpreted as proof that screenshots were missing.

The native ten-second scene sample used `max_viewport_cpu_gpu_ms`, excluding frame-cap waiting: 1449 samples over 10.127732 seconds, p95 **2.754 ms**, p99 **10.430 ms**, receipt `535bfd017eda3669f90d8a169926e943a99aa73d6bb31222681955c0faebaecb`. This metric is not complete frame latency. The watcher observed the running Action at 23:35:11.087 UTC, before completion. A separately authorized 1 Hz OS sampler was bound to the exact Action envelope (23:35:10.963–21.279 UTC), candidate and process/package identity: nine samples in that envelope had sampled maxima of **1,043,795,968 working-set bytes** and **2,196,881,408 private bytes**. These are bounded process-memory samples, not Veya-owned allocation counts or a continuous peak. Native `memory_bytes:0` was not used as memory evidence. Bound report: `creative/build/creation-memory/bound-0da6d8d7/performance-memory.json`, SHA256 `870b0f6a739e091fd3ed4a5c5e88244e0056f2dc7ac0e15904845e70b13b7f1c`.

The root completed with domain **blocked**, round 1, and no artifact export. Four new module writes occurred; there were no provider or Cooker submissions. Original paid assets/common resources/atmosphere were reused, incremental supplier cost was zero, and LLM cost remains unmeasured. `materials-0da6d8d7/final-summary.json`, `performance.json`, `paid.json` and complete durable parent/child snapshots retain the result. The 4312 service exited naturally with code 0. No automatic follow-up Run, normal-input roundtrip, E3 or E4/E5 task followed.

#### Offline investigation of the return-home and Lookdev findings

The persisted Baseline `initial` observation contains `return_home.interaction` with an available `interact` option and both point/target equal to `return_home`. Its `components` projection contains only enabled, health, transform and velocity; it does **not** contain `components.interactions`. The verifier used that absent raw component field to check `creation.return_home` and rejected before executing any return-home navigation step. This explains that particular validation failure; it does not establish a broken route or successful travel. The original failed result remains unchanged.

The three source-world reads before/after composition have identical author SHA256 `9bc45c67933957a5103da3aa1e9fe82cac980cb7aac77054a84e0dc22e771cb8` and behavior SHA256 `ef056b1af67bf3a1035940b56764e3af6cb8900a992d3d946b1cd58abf01c4a4`. That native template author declares the expected `creation.return_home` interaction and a `material.portal` box of size 2×3×0.2 at `[0,1.5,2]`. The successful compose allowed no modification of `return_home`; the candidate's initial observed transform matches the template. These source-world reads are not a dump of the assembled draft and must not be presented as full candidate-source equality. `materials-0da6d8d7/return-home-readonly-evidence.json` records the exact observation, authored clause and compose scopes.

The actual Lookdev Agent session's saved image message contains exactly the player/horizon/sky attachment hashes of captures `907c0baa…`, `db276c63…` and `89a2045c…`. All three match candidate `ff916…`, the original PNG bytes and fresh native frame receipts; all ten retained PNG hashes were checked again. The candidate's asset versions and Environment module `3b6d42fd…` bind atmosphere hash `7773418e49ac638a55bf84da2a7c149ffbe94c00278cb2401530ceb79967ebfc`, and the module author explicitly selects that resource. Its original successful producer is Environment Run `2bc7a0fa-8ea6-4dc1-8572-fb67f383795e`, operation `cook_6de89db7bc9591048aa86dcc46dd2624`, with locked preset `blue_hour`, seed 4817 and procedural cloud amount 0. No new atmosphere variant was submitted in 0da6. `lookdev-image-provenance.json` retains those source references, exact controls, module source/hash and the ten-image metadata index. This proves current-candidate image and resource provenance; it does not diagnose the pixel-level cause of sky streaks or occlusion. The investigation used only saved records and files, without starting Aura, calling the worker, or modifying scene state.

### Native atmosphere implementation identity and pending 0.15.4 continuation

The existing atmosphere Action accepts optional `expectedSources: {schemaVersion:1, shaderSha256, recipeSha256, templateSha256}` and maps it to canonical `expected_sources` with snake-case keys. Aura validates precisely those four fields, lowercase SHA256 values and version 1. It normalizes the two forms to the native shape when computing the completed-operation fingerprint. Legacy requests without the field retain their exact historical fingerprint; adding a different transport request ID still cannot resubmit completed work. Extra fields, ambiguous camel/snake aliases and malformed source hashes are rejected.

The registered worker remains the sole native destination. Native Veya compares all three expected source hashes to its current packaged shader/recipe/template **before** starting a Cooker operation. Aura does not grant an exception merely because an Agent requests an upgrade, nor does it resolve the call against a default or other session. A verified implementation change therefore has a different bounded operation identity; once completed, that identity is also protected against resubmission. This local procedural work does not authorize new provider, cloud-image or model generation.

Production recovery now recognizes completed local `atmosphere-build` steps from the Environment Flow. It proves an immediate terminal result or exactly one matching terminal wait, requires successful Cooker steps and, for source-guarded calls, the corresponding native environment shader hash. Unknown/pending and conflicting completion receipts remain blocked. Optional `environmentResource.atmosphere.shaderHash` is a strict SHA256 field: extraction compares it with both a persisted native asset result and catalog; live admission compares the bound catalog again. A model-supplied hash without native evidence cannot become a retained resource. Material and production grants remain version 1; no repair count or old Run output is rewritten.

Offline admission of 0da6 succeeds using the existing production continuation mechanism: original round 1 → nextRound 2; resume SHA256 `c00ced226c96bff509595f7061117e6fd655b10c7ca7cc70ebaf0d24c88d2a86` (99,863 bytes), eleven asset pins and three retained module pins. Layout1 is material eligible for normal defect-directed repair, while the old world-logic module is absent from the latest cache and is not claimed as reused. The original text, current/client records, bindings and historical Run files were checked unchanged. Preparation details and commands are in `materials-0da6d8d7/recovery-0154-preparation.md`. This is offline eligibility only; final plugin/package gates, refreshed same-session descriptor, current live guards and separate submission authorization remain required.

The final host `pnpm run check` for this source-identity change completed naturally with exit 0: **378 tests, 371 passed, 7 skipped, 0 failed**. Runtime passed 81/81; orchestration passed 177 of 184 with seven declared skips; all 16 workspace/typecheck gates passed. The complete log is `aura-world-e2e/aura-final-0154-check.log`. Focused strict-source, worker-session isolation, legacy duplicate-work and shader-provenance tests also passed. No test process was killed or manually cleaned up for this run. Earlier failed aggregate logs remain retained. The isolated 4312 service stayed off, and this gate performed no acceptance worker call, new Run, supplier generation or Cooker submission. Native package admission and real candidate validation remain separate, pending checks.

### 0.15.4 linked submission: payload gate blocked before production

The new same-session worker PID 76008 passed live read-only admission on 2026-10-01: all eleven assets, three module hashes, existing world/draft and profile matched; active scope was unchanged before/after. The native tool schema exposed the strict four-field `expected_sources`. The old `7773…ebfc` atmosphere's actual shader `d593085c…` differed from the current packaged shader `e26e958d…`, with recipe `a07d634f…` and template `8dec4547…`; the plugin's implementation-upgrade reader accepted this evidence. Loaded DLL was `d95901dc8e4d0e47a57dc81da03a79137562a1c90a91bed8a96f49b83979426c`, PCK `6320f49c2abed7ff3788e4883a6ac8afb30f7e771b8f5f82ed167bbf518b8ff7`. This check did not cook an upgraded resource.

After loading all 81 available 0.15.4 contributions, one authorized linked request `c70e9e16-953d-4f78-92c8-5d5c507834a4` created root `91b48f29-3bf8-4def-8371-12f2815c0968`, referring to the unchanged 0da6 request/text and requested round 2. Wish hash was `b01592caaf655e08a5696e0fe261aefeafe70538289e6d3fd8728c911e7a9b64`; World Agent hash `18e3e54c0c7f91d33f2863e6310ffdfcf04c81410fbf217c2f51a941b23ef85f`.

World child `c006e2d2-63db-443c-a68d-b8359d85ee69` completed only its creator-context Action, then returned `creation_payload_capacity`: production input needed 211,620 bytes plus 139,264 bytes reserved for results/verification, exceeding 262,144. The input carried both `resume` and `productionRecovery`; the failed output contained no resume. This is a real pre-production payload rejection, not completion of a production repair or evidence of a reusable next-round output. Root domain status was **blocked**. No Agent, Build, native write, provider, Cooker, candidate, capture, performance, save or export executed. The original 0da6 records remain unchanged. Exact safe inputs/outputs, field byte sizes and terminal summary are retained in `production-91b48f29`.

The performance watcher observed root terminal without a performance event; no OS sample ran. The paid audit reported no new ledger or requests. Service 4312 exited naturally with code 0, with no automatic follow-up task or roundtrip. Native package readiness, code tests and this admission do not close E2 acceptance.

### 0.15.5 preparation: project binding capacity rejected before Run creation

The plugin's one-resume wire fix passed its 81-definition/323-test gate. New 0.15.5 catalog identities were Wish `343b66dfa25b5339c904fe33685d932e712a0b904edbafd307d1effa3a8d7802` and World Agent `dbe07bfaa3d039998d9ea94b2e43eaa808673a493e248c76ef93bcf49c9e241c`. Fresh live read-only admission again confirmed the original 0da6 round-1 grant for nextRound 2, all eleven assets/three modules, current world/draft, source guard schema and old/current shader identities. The worker remained PID 76008 in the same session with no playtest or scope change.

Prepared request `8f5ee501-5ab0-470c-8852-00624fc9cb0d` did **not** create a Run. Its task POST returned HTTP 503; one retry with exactly the same stable request ID and body also returned 503. Both occurred before committing a request binding. Read-only diagnosis replayed the admission and all 79 durable reads, then intercepted the commit: the existing project-wide `bindings.json` was 260,967 bytes, and the proposed unchanged-history addition was 263,689 bytes. The existing 256 KiB binding-store guard therefore rejected it as `creator_capacity_exceeded`, which the route exposed as `creation_unavailable`. This was not a worker, plugin catalog or production repair failure.

All 26 historical bindings remain unchanged. Five legacy embedded design-recovery records account for most of this file; no records were deleted, truncated or reclassified. `submit-0155-readonly-diagnostic.json` preserves the safe diagnosis. No new Run, Agent, native write, Cooker, provider, candidate or performance sample occurred. The isolated service exited naturally with code 0. The stable prepared request remains unsubmitted; any storage correction must retain the old grant bytes, ancestor checks and per-boundary limits before another authorized attempt.

#### Bounded design-grant storage correction

The host now stores design recovery in the same managed immutable grant directory used by production grants. A binding's `worldDesignRecoveryRef` contains only `grantId` and `contentHash`; both name the SHA256 of the exact envelope bytes. The envelope binds the receiving request, owner, home, creation session, source request/Run, text hash and descriptor-path hash, and includes a separate SHA256 of the unmodified recovery JSON. The original raw draft hash and optional retained-spec hash are checked too. No filesystem path or credential is added to Flow context.

Both service initialization and the worker-binding reader hydrate the original `worldDesignRecovery` object, preserving its fields, order and bytes. Existing inline records remain readable. Inline-plus-reference records, extra reference fields, missing files, changed bytes, mismatched sources or identities, and out-of-range values are rejected. Missing referenced content is an explicit corrupt-store error; initialization cannot silently treat it as a new empty project. Existing durable-tree proof and consumed-budget validation still run after hydration.

Externalization occurs only during a normal host commit, not during startup reads. The writer prepares all exact grant identities, keeps the index at or below 256 KiB, preserves the previous inline index bytes in an immutable SHA-named backup, writes every immutable grant, and then replaces the index atomically. A backup, grant or rename failure leaves the old index and in-memory state unchanged; no Run starts before the binding commit succeeds. Individual recovery and Flow payload limits remain unchanged. This is a storage representation change, not a new recovery entitlement or a reset of prior repair rounds.

Request and source UUIDs keep the existing case-insensitive admission contract; their stored keys and original character case are never normalized. New design grants and migration backups are written to unique same-directory temporary files, flushed and closed, then atomically published using a no-replace hard link. An incomplete write therefore cannot occupy a final hash filename. Identical concurrent content is accepted; conflicting existing bytes are rejected. Temporary files are removed after ordinary failure. Other pre-existing grant writers retain their prior behavior: a damaged immutable file remains a hash conflict requiring attention, and is never silently repaired or overwritten.

Focused tests use a path-redacted copy of the real 260,967-byte index and all five unchanged design grants. They prove that one more ordinary binding exceeded the old representation, while immutable references fit below 64 KiB; restart hydration reproduces the original objects exactly. They also cover wrong owner/home/session/source, ambiguous references, byte tampering, missing content, backup/grant/atomic-rename faults, and a failed request starting exactly once after storage becomes available. No real acceptance index or Run has been migrated by these tests. The pending request `8f5ee501…` and its original 0da6 source remain untouched pending the final gate and explicit execution authorization.

The first complete aggregate check (`aura-final-design-ref-check.log`) exited 0: 382 tests, 375 passed and 7 explicitly skipped. That result preceded the UUID-case and partial-write corrections; its log is retained. Their focused tests additionally cover uppercase source/request migration and restart, a simulated partial write followed by safe retry, and concurrent identical publication. The corrected source's complete `pnpm run check` (`aura-final-design-ref-atomic-check.log`) also exited 0: 384 tests, 377 passed and the same 7 explicitly skipped; Runtime 81/81 and Orchestration 183 passed of 190 including those skips. Workspace boundaries and all package typechecks passed. The focused creator tests passed 44/44 in Runtime and 13/13 in Orchestration. These are Windows host/filesystem tests, not a new Veya generation, render, performance or macOS acceptance result. The real acceptance directory remains unmigrated at this handoff.

The fixture's Windows host paths are now adapted only in test setup on POSIX platforms, using absolute mock paths with the same encoded lengths. A dedicated test also executes that adapted migration and backup on Windows. Original fixture bytes and all five recovery values remain separately pinned; production `isAbsolute` validation and stored paths are unchanged. Seven storage tests pass after this test-only correction; the previous two full gate logs are retained.

The first full check after the test-only platform adaptation (`aura-final-design-ref-platform-check.log`) failed: Orchestration 183 passed, one failed and seven skipped out of 191. The failure was `action-dsh.test.ts:309`, while polling the catalog after changing the Action helper to v2; the host RPC reported connection interruption (503). All seven storage tests and all package typechecks passed. The recursive gate stopped before Runtime and root-level tests. Its existing sanitized error does not distinguish child exit from RPC timeout, so no narrower cause is claimed. Running the unchanged Action/DSH test alone passed 1/1 in 19.1 seconds (`aura-design-ref-dsh-narrow.log`); no timeout, assertion or production code was altered to obtain that result.

The authorized same-source aggregate retry (`aura-final-design-ref-platform-repeat-check.log`) then exited 0: **385 tests, 378 passed, 7 skipped**; Orchestration 184 passed of 191, Runtime 81/81 and root-level tests 20/20. All workspace/type checks passed and the previously failing DSH/HMR case passed. The failed aggregate and successful isolated case remain recorded; their underlying intermittent RPC cause has not been established. All checks ended naturally without manual process cleanup. This final host gate still precedes any migration or submission in the actual acceptance project.

### Actual 0.15.6 migration and blocked production (2026-10-01)

Normal submission of the previously prepared request `8f5ee501-5ab0-470c-8852-00624fc9cb0d` successfully externalized five historical design grants. The exact old index (26 bindings, 260,967 bytes) was backed up under SHA256 `72eb19c27448e7b43cdd07bb7c921961170e42130237ef251aea64fa1e1dd9b9`. The new index contains 27 bindings in 60,422 bytes, SHA256 `d1661a43ac766da50637d747478e66bc4e4c1e3e76d3fc863e06bf3980d9add7`. Hydration reproduced all historical binding values and all five original recovery JSON byte sequences. The service performed its ordinary atomic commit; no acceptance binding or Run history was hand-edited. `production-40b42f1c/design-grant-migration.json` records the individual immutable references and comparisons.

Root `40b42f1c-ce9f-40e9-8d26-79565692d225` ran from 01:13:28.956 to 01:15:59.496 UTC on plugin 0.15.6 (81 available contributions), unchanged worker PID 76008/session and DLL `d95901dc…` / PCK `6320f49c…`. It retained the original request text, Plan, Gameplay Design, world `6d3c0118256fea2737032b50359b1705`, draft `7515b0b8c7957657e247cf7b0d82824f` and budget identity. It entered round 2 without replanning. A same-world travel operation completed, followed by new Layout, Environment and world-behavior module writes. A single guarded local atmosphere upgrade, operation `cook_046e1fbc9d1a6092963558bb686bc4f8`, succeeded with content hash `999902be30ae03861db744f64318e51532afad291e4fb14b4b96fabdab2a4e8f` and the current `e26e958d…` shader. It reused the old controls/seed and made no provider, model or cloud request. It was a new implementation identity, not a resubmission of previously completed Cooker work.

The round-2 compose failed with HTTP 422 and an exact native author diagnostic identifying Environment module `496229c19f40a36ba133779f2a20e3cff8071e094fbac5a66fdefb9b5148a932`. No new candidate was committed. Its existing third round then performed only six Build reads and three Environment reads, returning `lookdev_blocked` because no candidate-bound visual evidence existed for this author failure. No third-round Agent, module write, Cooker, compose or verification occurred. The root is **completed / domain blocked**, with terminal round 3 and unchanged terminal-resume SHA256 `134c510abf0502584a294409329905816ab80bc0a2a31f8018d2ccd28505584f`. There was no new screenshot, performance sample, save test, artifact export or normal-input roundtrip. Incremental supplier credits were zero; LLM costs remain unmeasured. All eight Run snapshots, exact inputs/outputs and module sources are under `production-40b42f1c`; service 4312 exited naturally with code 0. E2 remains incomplete.

### Limited admission of the unstarted final production round

The public production-recovery v1 contract still requires `nextRound = resume.round + 1`, with a maximum of 3. It never admits the terminal round-3 resume as a round-4 request. A host-only exception recognizes the particular released Build/Environment definition hashes which rejected an author defect before starting the last repair. It proves the complete terminal tree, the exact environment-author compose rejection, `build-2.output == build-3.input.previous`, locked inputs, and the fixed read-only third-round step sequence. Extra Agents, writes, descendants, checkpoints, uncertain results, other errors or a prior use of this exception are refused. A round which actually executed its author, such as the earlier d4a0 case, remains exhausted.

The host reconstructs a **new boundary view after completed build-2**, carrying its entire output and exact observed defect; it does not rewrite the old terminal resume. The actual reconstructed resume is 65,830 bytes, SHA256 `7c525feccdba512813e7e5b4204120ed70049edb0f182744e074e0adc2fb0740`, with round 2 / nextRound 3. Private immutable proof records the source final-resume hash, both Build identities/input-output hashes and blocked Environment identity. The public projection has no new fields. Its twelve asset pins, four module pins and all four completed-operation fingerprints include the successful atmosphere upgrade, which cannot be resubmitted.

Build's post-binding gameplay specification can legitimately differ from the locked design. Only this proven pending-boundary branch accepts that actual durable Build result on the host; the plugin independently recomputes the existing deterministic identity mapping and requires an exact digest, including every retained PropSpec. Neither side substitutes model-authored recovery JSON. Visual-context `collisionContentHash` and legacy binding `collisionVersion` are both supported; if both occur they must agree. Raw-source and collision hashes still require actual catalog or inherited native proof.

The existing serialized binding commit reserves at most **one successor request** for that source boundary. A lost start response may be retried with the same stable request; a second request is refused even if the first has already terminated. Preparation, proof or atomic-commit failure creates no reservation. Once the binding commits, an uncertain start retains that request's reservation. Initialization and the worker-binding reader also reject duplicate claims. A missing managed production grant is a corrupt-store error, never a new empty project. This adds no scheduler, repair allowance, history rewrite or relaxed 256 KiB limit.

Focused Runtime tests passed 21/21 and Orchestration tests 4/4, including actual collision-field forms, consumed-round rejection, lost response, concurrent successors, restart and missing-file handling; both package typechecks passed. Offline extraction plus the updated plugin reader accepted the actual boundary, with zero native calls and the binding index unchanged (`pending-round3-offline-report.json`). Live worker admission and an explicitly authorized new Run are still required; these tests and the reconstructed view are not production or render acceptance.

The complete `pnpm run check` for this correction exited 0: **391 tests, 384 passed, 7 skipped, 0 failed**; Orchestration 185 passed of 192 with seven declared skips, Runtime 86/86 and root tests 20/20. All workspace and package typechecks passed. Log: `aura-final-unstarted-round-check.log`. It ended naturally without manual process cleanup; `git diff --check` passed using the repository's normal line-ending configuration. Previous failed checks remain recorded. Service 4312 remained off throughout these checks, with no acceptance-worker calls, new Run or production operation. Windows host checks do not establish macOS execution or complete E2 acceptance.

### Actual final-round successor (2026-10-01)

After the preceding gates, read-only admission confirmed twelve exact asset pins, four modules, four completed-operation fingerprints and no prior successor. Worker PID 76008/session `beb60d8c684447e3ad29d5991aa0791c`, DLL `d95901dc…` and PCK `6320f49c…` were unchanged; its world/instance/epoch/revision/mode and the binding index were identical before and after admission. Plugin 0.15.7 registered all 81 contributions; Wish source hash was `87904bca34fb13998e3a7df9638b685e688d8f9e990c6148cea89c67221483dc` and World Agent hash `847f8a35af03a5a5e54c6c1552aab3d82e863063159747103291b6601483ed70`.

Normal submission accepted the single successor request `4be96085-78a6-4bff-a957-e2063997f799`, root `1d2e32d8-9255-492d-bf12-ce48a3f4b87b`. It ran from 01:49:45.316 to 01:50:39.845 UTC using the unchanged text and reconstructed round-2 boundary, and actually executed **round 3**. Plan, Design, world copy, asset production and successful Cooker operations were not rerun. Environment read the retained failed author module, generated a new author and wrote immutable module `5107c47a4d2f974642b68e906b3a39a74f497b2388769fe5e1195d61ddfb4806`; it reused environment resource `999902be…` and shader `e26e958d…` without Lookdev or atmosphere generation.

Compose again returned HTTP 422, `creation_validation_failed`, with exact `author` / `environment` ownership for that new module. The durable model output still contains a `local y` vector table whose third expression is an anonymous item instead of a `z` field. That is a direct source observation; the native diagnostic itself remained bounded and generic. No new candidate, Verify, screenshot, performance sample, save test, artifact or normal-input roundtrip followed. The root is completed with domain status blocked, and **the final round and sole successor claim are consumed**. No automatic retry was made. The tree contains zero supplier, Cooker-submit or atmosphere-build Actions; the project ledger was not created, and LLM costs remain unmeasured. All four original Run snapshots, complete inputs/outputs, author source, compose error, claim proof and costs are retained under `production-1d2e32d8`. Service 4312 exited naturally with code 0; user service 4311 and the worker were untouched. E2 remains blocked.

An offline assessment after this terminal result confirmed that the existing independent-task material route still admits source request `5c712cc0-8e2a-4204-ba75-557c1af41ea9` / root `136a70af…`: seven resource pins, one ready Prop module and three completed-operation fingerprints, public material SHA `9b1f17a5…`. It reconstructed the original source proof and passed the plugin reader without worker calls or writes to bindings/current/client. The three-light case and its text SHA `eb5a1716…` are unchanged. This does not resume either exhausted chain: a later explicitly authorized new task must run fresh Plan/Design/world creation and independently verify its result. Its source atmosphere is the older `7773418e…` resource. The native matching-variant branch can return a new successful cache receipt without executing Cooker, but a future package's source hashes and registered variant must first be checked; zero new cooking is not implied by offline admission. No such new task was prepared or submitted by this assessment.

The subsequently authorized **read-only 0.15.8 live gate** passed: catalog 81 available/zero unavailable, same owner/home/session on new worker PID 92972, DLL `0ae4ec4b…` / PCK `8f5834cc…`. All seven source resource pins and the one Prop module matched. The already registered `999902be…` environment matched its immutable path, type and actual `e26e958d…` shader; current shader/recipe/template hashes and the complete effective argument set also matched the earlier successful upgrade. This used only status, capability, catalog and module reads. Both before/after scopes had no active world or playtest, epoch/revision 0 and mode -1. Client registration adopted the new descriptor without preparing or submitting a task. The current request remained the exhausted `4be96085…`, with 28 existing bindings and exactly one consumed successor claim. `materials-0158-live-admission.json` records the evidence. No atmosphere Action or Cooker was invoked to demonstrate a cache hit; that future execution result is still unverified.

### Independent 0.15.8 E2/E9 execution (2026-10-01)

The separately authorized request `efd3e2ff-86b8-45c8-9ec0-45be49103361`, root `0c0ca738-b122-48e3-b43c-40d665a2ae89`, ran from 02:29:02.852 to 02:40:12.288 UTC. It used the unchanged three-light text and the 136a material reference, with no previous-request recovery. Fresh Plan and Gameplay Design passed their first reviews without revisions or filtered issues. Plan declared the three requested individual light identities. The complete PropSpec remained SHA `3292b4c4…`; the new GameplaySpec was `5279039a…`. World `f15eecfe12de664397a77e3f2cd1b4bc` and draft `9cfab1fb860fba94db14a157a5018a18` were newly created.

Build reused the existing common asset triple and ready Prop module `ea4d06d2…`; this root contains **no new Prop Agent or preparation child**. Shared implementation provenance remains the actual source Prop Agent `3c0403fb…` and Prepare `f03f54cb…`, followed here by independent per-prop verification in the new world. The environment upgrade Action returned immediate succeeded cache receipt `cook_71788ecff68adec6f3aa2a70aeb62d09` with unchanged asset `999902be…`, matching the inspected native registered-variant branch. It was one atmosphere Action and a new receipt identity, with no new Cooker execution or supplier work. The first compose rejected environment module `dc2b91b7…` with a generic native author diagnostic. The existing round-1 repair generated module `9cd48a1c…`; compose then succeeded with candidate `6723a1cb034084184c03a91048e13bad66399f291cfa15ce643343166cea498d`.

Actual Windows Vulkan Forward+ 1920×1080 verification passed structure, gameplay, scene performance and save/resume. First/repeat reading, a real saved reload with new instance/epoch, persistent truth and post-restore reading passed; the isolated Prop baseline also passed structure, gameplay and save/resume. **Whole-scene visual validation failed**: player/horizon images showed a large bright cyan rectangle dominating the intended restrained twilight courtyard. The target plaque itself passed visibility checks. Round-2 Lookdev retained the exact controls and rejected the defect as geometry/occlusion/rendering outside what its five atmosphere parameters could reliably repair. It made no further Cooker submission or module write. The root is completed/domain blocked at round 2; no artifact export, artifact-proof or normal-input world roundtrip was performed, and no automatic successor was created. macOS remains unverified.

Native scene performance sampled 1,436 observations over 10.010998 seconds: p95 3.173 ms, p99 9.845 ms, receipt `128e9e88…`. The metric is `max_viewport_cpu_gpu_ms`, excluding frame-cap waits, not full frame latency. A separately authorized 1 Hz OS sample was bound to the exact root/candidate and Action interval 02:38:19.664–02:38:29.846 UTC: nine in-window samples, maximum working set 982,167,552 bytes and private bytes 2,126,168,064. These are sampled main-Veya process maxima, excluding CEF, VRAM and allocator accounting. Its report SHA is `2bb2b62e509c855b501b4038843fc9f328249c15b3eba8ba26a68c1f0491d48a` (`creation-memory/bound-0c0ca738/performance-memory.json`). This valid performance evidence does not override the failed visual result.

All 21 durable Runs, ten screenshot receipts, immutable module sources, both compose outcomes, actual cache receipt, reviews and costs remain under `materials-0c0ca738`. The Run tree has zero supplier and Cooker-submit Actions; the project ledger was not created, and LLM costs are unmeasured. Service 4312 exited naturally with code 0; user 4311 and the frozen package were untouched. No production code was changed during this execution.

#### Ordinary recovery of a native atmosphere cache receipt

The first offline recovery check rejected this closed tree because the host required a Cooker step report for every successful atmosphere operation. Native catalog reuse deliberately returns an immediate `succeeded` receipt containing the existing asset and a new operation ID, without a `cooker` report. It does not execute a pipeline and is not evidence of a second cook.

The recovery scanner now admits that specific receipt only inside its completed Environment child: exactly one native asset, an immediate terminal response with no wait or fabricated step fields, identical native catalog records before and after the operation, and a preceding native capability snapshot matching all three `expectedSources` hashes. Native ID, content hash, generated-variant path, type, shader, preset and sun must match the retained resource; the exact submitted control set (including omitted versus explicit values) must match its effective request, whose preset/seed/source and locked Plan request remain unchanged. Missing, queued, unknown, conflicting or model-only evidence fails closed. Ordinary Cooker completion still requires its successful step report. The existing operation fingerprint is retained to prohibit resubmission; no new public grant shape, repair allowance or pending-round exception is introduced.

The real metadata fixture `packages/backend/runtime/test/fixtures/atmosphere-cache-0c0.json` contains only selected original request/receipt/catalog/capability fields, without host paths or credentials. Focused recovery/cache tests passed 21/21 and Runtime typechecking passed. The actual closed `0c0ca738` tree then passed offline extraction and plugin-reader validation with zero native calls: unchanged 103,865-byte resume, SHA256 `d50fc3483e64c3bd26f645ece9abfa4d9dfdffd00d64eb9a3a564fd63f235d99`, round 2 to next round 3, 12 asset pins, three retained module pins and four completed operation fingerprints. Binding index/current request/client bytes remained unchanged. This is eligibility evidence only; no service, successor, render or new acceptance was started.

The cache correction's complete check (`aura-atmosphere-cache-recovery-check.log`) exited 0: 396 tests, 389 passed, seven declared skips, with Runtime 91/91 and Orchestration 185/192. That log precedes the following claim correction and remains retained.

New ordinary production-recovery bindings now carry private `productionRecoveryClaimVersion: 1` and `productionRecoveryClaim` fields. The digest fixes the source request, source Run, exact resume hash and next round. The normal serialized commit requires the marker for every newly written ordinary recovery; updates cannot remove or change it. A versioned record with a missing, malformed or wrong claim is invalid. Both service restart and worker binding validate it against the immutable grant and scan all existing production grants, including unmarked historical bindings, for competing claims. A lost start response can retry only the same stable request and fingerprint; a different request cannot consume the same remaining repair boundary. Same-Run checkpoint continuation adds no binding. Independent `reuseProductionFromRequestId` material tasks do not claim the old repair allowance.

Legacy unmarked duplicate history remains readable without migration: the earlier `0da6` boundary has both the `91b48` payload-capacity failure and the later `40b42` successor. This was a prior admission gap, not an entitlement to another retry. Either old binding prevents a newly marked claimant from taking that boundary. The existing unstarted-final-round exception retains its stricter prior rule and consumed `1d2` successor. New claim tests cover restart, a lost response, changed input under the same request, another request, a missing/downgraded marker, historical occupation and independent material-task coexistence. No real binding/index/history was modified by this correction.

The final claim/cache source passed Runtime focused 25/25, Orchestration focused 3/3 and both package typechecks. The required final `pnpm run check` exited 0 (`aura-atmosphere-cache-claim-check.log`): **397 tests, 390 passed, seven declared skips**; Runtime 91/91, Orchestration 186/193 and root tests 20/20. Workspace and all package typechecks passed; tests ended naturally without manual cleanup. An additional offline scan validated the unchanged real index and found no existing claimant for `0c0ca738` boundary digest `442f880f025f0d4a22a0199f1f08136d0e3293019ea1bfd755ddbb1d28d1bd1f`. The 12 pins/three retained modules/four completed operations and exact resume remained identical. Service 4312 stayed off throughout; live worker admission and an explicitly authorized successor are still separate steps.
