# 真实 Veya 创作验收 harness

此目录是显式执行的测试工具，不进入生产服务，不依赖本次机器路径、凭据或历史 Run。它调用真实 Aura、插件、供应商和打包 Veya；协议单测不代替这里的视觉/玩法证据。尚未运行的用例不能标为通过。

## 环境

- 先按仓库说明准备现有依赖；此工具不安装依赖、不修改第三方代码。
- 独立 acceptance root，已按 [后端 Runtime](../../../../../docs/backend-runtime.md) 配置 DSH 模型授权。Tripo 使用该 root 的忽略文件 `.aura/tripo/api-key` 或后端 `TRIPO_API_KEY`，配置见 [Tripo](../../../../../docs/tripo.md)。不复制或打印其他用户凭据。
- 明确启用的本地 Veya 插件路径；工具只在 acceptance root 写自己的插件配置，不修改全局配置。
- 同版本打包 Veya `--creator-worker` 描述符，固定 `creation_session_id`，具有规定工具和真实 renderer。遵守 Veya 的隐藏绘制、UI、平台和包版本门禁。Windows 结果不能代表 macOS。
- 实际 `veya.system.context` 必须声明 `system.creation_verification` 下的 `progress_projection`、`creation_geometry`、`stable_interaction_ids`、`authored_identities` 整数版本均至少1。同名工具但缺少这些语义的旧包会在创作上下文准入时拒绝；不能改测试配置绕过此门禁。原生 authored ID 列表由 `world.read` 的显式只读选项取得，不从源代码推测。
- 预算配置位于该 root 的 `.aura/world-agent-budget.json`。用户默认货币政策可用 `{"schemaVersion":1,"unlimited":true,"accountingUnit":"tripo_credits"}`；有限部署上限仍受宿主校验。E2–E5 不新增供应商生成时另设 `maxAiAssets:0,maxSkyImages:0`，不要改变其他用户项目。未知付费副作用仍阻断。

CLI 的绝对路径参数不会进入模型。凭据和大日志只写入 root 的 `.aura/creator-acceptance/`，不得提交。请使用真实 owned home world ID；任意标签不能证明个人广场或返程功能。

## 启动和提交

以下命令从 Aura 根目录运行。自行指定本机路径，不把示例路径作为开发依赖：

```powershell
$acceptRoot = 'C:/veya-acceptance'
$pluginRoot = 'C:/projects/veya/aura-plugin'
$workerDescriptor = 'C:/accepted-worker/session.json'
$identityFile = 'C:/veya-acceptance/identity.json'
$fixtures = (Resolve-Path packages/backend/runtime/test/creator-acceptance/cases).Path

# 长驻终端；另开终端执行后续命令。可选 --port，默认4312。
pnpm --filter @aura/runtime exec tsx test/creator-acceptance/cli.ts serve --root $acceptRoot --plugin $pluginRoot

# 新进程重新加载实际插件闭包，保存全部贡献sourceHash；不可用项直接失败。
pnpm --filter @aura/runtime exec tsx test/creator-acceptance/cli.ts catalog --root $acceptRoot

# 将identity.template.json复制到identityFile并填入实际测试身份。
pnpm --filter @aura/runtime exec tsx test/creator-acceptance/cli.ts prepare --root $acceptRoot --case "$fixtures/E1-reading-plaque.json" --identity $identityFile
# 可选：只注册可信 worker 身份，等待其他门禁期间不会创建 Run。
pnpm --filter @aura/runtime exec tsx test/creator-acceptance/cli.ts register --root $acceptRoot --worker $workerDescriptor
pnpm --filter @aura/runtime exec tsx test/creator-acceptance/cli.ts submit --root $acceptRoot --worker $workerDescriptor
pnpm --filter @aura/runtime exec tsx test/creator-acceptance/cli.ts status --root $acceptRoot
```

`prepare` 分配并持久保存一个 request ID。HTTP 响应丢失只重试 `submit`，不要再次 `prepare`。显式 `--request-id` 可保留已有测试身份。`status` 单次读取状态和最多八层/64个 Run 的实际 durable 树，保存精确 Run JSON；不会调用 worker 的重型状态接口。

为避免短制作阶段在人工通知前已结束，`submit` 可加 `--concurrent-test <绝对路径JSON>`，文件格式为 `{ "command":"绝对可执行文件路径", "cwd":"绝对工作目录", "args":["参数", "{runId}"] }`。仅在提交成功后，以无 shell、Windows 隐藏窗口方式启动显式测试命令，替换真实 Run ID，并保存启动标记、退出码/时间和 stdout/stderr。CLI 保留子进程直到实际退出，不使用 detached/unref（真实 Windows PowerShell 验证发现 detached 可能未执行脚本即退出）。相同 Run 重复 submit 不重启测试；启动结果未知时保留标记供检查。该参数仅属于验收 CLI，不进入生产服务或模型。

自动并发测试提交会额外保留 65 秒的每秒产品 projection，增加 `testObservedAt` 与来自 durable 树的 `testActiveFlow`，供原生 E8 脚本按 UTC 对齐。测试必须在正式性能采样前结束；若未能证明样本与 running 制作阶段重叠，则不能算后台隔离通过。并发脚本负责自己的进程生命周期，CLI 不终止 Veya。

## 回答、取消与恢复

从 `status` 的真实 checkpoint 读取 `runId`、`stepKey`、schema，创建本地答案文件：

```json
{"commandId":"实际新UUID","checkpointRunId":"真实checkpoint所属RunUUID","stepKey":"真实stepKey","answer":{"按真实schema填写":"答案"}}
```

```powershell
pnpm --filter @aura/runtime exec tsx test/creator-acceptance/cli.ts answer --root $acceptRoot --answer 'C:/veya-acceptance/answer.json'
# 重复相同答案文件，核对同一根Run继续且无重复子步骤。
pnpm --filter @aura/runtime exec tsx test/creator-acceptance/cli.ts cancel --root $acceptRoot --command-id '<稳定UUID>'
pnpm --filter @aura/runtime exec tsx test/creator-acceptance/cli.ts resume --root $acceptRoot --command-id '<另一稳定UUID>'
```

取消清理由 Aura 的已持久化 playtest lease 负责。未知 begin 不可擅自认领当前 test；清理未证明完成时应留 needs_attention。`resume` 只用于可恢复的原 Run，不能覆盖 revision mismatch 或失败历史。

已付费 `create_prop` 在已知安全下游失败时，可先 `recovery --source-request <原UUID>` 查看宿主验证后的恢复证明，再用**相同原始 case 和身份**创建关联的新请求：

```powershell
pnpm --filter @aura/runtime exec tsx test/creator-acceptance/cli.ts recovery --root $acceptRoot --source-request '<最近失败request UUID>'
pnpm --filter @aura/runtime exec tsx test/creator-acceptance/cli.ts prepare --root $acceptRoot --case "$fixtures/E1-reading-plaque.json" --identity $identityFile --previous-request '<最近失败request UUID>'
pnpm --filter @aura/runtime exec tsx test/creator-acceptance/cli.ts submit --root $acceptRoot --worker $workerDescriptor
pnpm --filter @aura/runtime exec tsx test/creator-acceptance/cli.ts paid --root $acceptRoot
```

证明只能由宿主从绑定、durable 子树和账本提取；客户端不能提供恢复 JSON。关联恢复保留原 task ID、资产、费用和修复轮次，并硬禁新付费。已处理视觉/碰撞资产必须带同次 preparation 回执，不可再次作为原始模型缩放。

一个已耗尽修复额度的世界任务不能再次恢复。宿主可将其已完成且精确核验的公共资产、ready交互物/准备回执和环境资源作为**未通过最终验收的材料**，供另一项明确的新世界任务参考：

```powershell
pnpm --filter @aura/runtime exec tsx test/creator-acceptance/cli.ts prepare --root $acceptRoot --case "$fixtures/E2-world-reuse.json" --identity $identityFile --reuse-production-from-request '<已终态材料来源request UUID>'
```

这一路径必须独立记录新测试身份，不能加`--previous-request`、`--previous-artifact`或公共资产引用参数。新任务重新执行Plan/Design；材料规格不匹配就停止，旧轮数、评论和失败记录不变。宿主只接纳同owner/home/session的完整已证明来源，原source文本与新任务文本分别用SHA固定，现场只读重核资源和module哈希，禁止新增付费和重复提交已完成Cooker指纹。旧world/draft/runtime、布局/灯光模块和失败logic不会带入。当前只支持既有worldProductionRecovery的无checkpoint终态来源，不是任意失败任务恢复入口。详见服务文档的Unverified materials节。

另有窄的 `create_world` 设计语法恢复：只有完整结束于 `invalid_spec`、原 draft 确实不是合法 JSON、整棵 Wish→WorldAgent→Plan/Design 尚未执行任何写入的任务，才可用相同 `recovery`/`prepare --previous-request` 命令创建关联 Run。宿主提取已完成的 brief、Plan、Design 输入和原 draft UTF-8 SHA；通过 `creation.worldDesignRecovery` 传给同层设计的一次格式纠正，不重新运行 Plan，不把坏 JSON 视为已验收规格。纠正仍须满足全部设计语义和验收条件。已经使用过此恢复的祖先不能再次领取格式预算；客户端传入恢复 JSON、跨身份/会话、隐藏资产写入、未结束子步骤或有效 JSON 的其他 schema 错误均拒绝。世界恢复沿原请求预算身份；之后合法制作仍受配置预算限制，与已付费 prop 恢复的禁止新增付费边界分开。

若实际候选视觉失败且原生资源检查证明准备阶段尺寸错误，宿主运维可显式登记一次有限修复证明：

```powershell
pnpm --filter @aura/runtime exec tsx test/creator-acceptance/cli.ts reconcile-preparation --root $acceptRoot --source-request '<失败request UUID>' --saved-evidence "$acceptRoot/.aura/creator-acceptance/evidence" --worker $workerDescriptor --requirement '<锁定需求ID>' --candidate '<实际失败候选SHA256>' --report '<原生geometry报告>' --host-files '<原生资源文件映射>'
```

这不是 HTTP 或 Flow 输入。CLI 核对同 session 的 live catalog、原成功 Cooker 目录中三个资源的真实字节、preparation 回执、同候选的 durable Build/Visual 结果，再将原报告和资源字节存入宿主管理的内容哈希目录。传给 Flow 的只有 `prop_preparation_geometry` 缺陷身份；文件路径、几何报告和凭据不会进入模型。修复轮次继续累计，仍禁止新付费；普通恢复继续复用已完成准备结果，不自动重跑 Cooker。报告缺失、资源哈希变化、候选不匹配或修复额度耗尽均拒绝登记。

## 后续用例和成果检查

| 用例 | 前置条件与真实证据 |
|---|---|
| E1 | 真实AI模型、实际阅读/重复阅读、UI逐字画面、性能、保存重进、导出；记录真实供应商费用 |
| E2 | 将模板里的原始 asset ID/hash 填为已验资源；真实WorldAgent调用共享Prop；无特效整场景性能；可信返程入口及target声明 |
| E3 | 新 create_prop，不传 previousArtifactId；填入与E2相同的原始模型ID/hash，maxAiAssets为0；创建新的浮空配置，验证统一比例/碰撞/地面锚点与通行、真实操作与保存 |
| E4 | `prepare ... --previous-artifact <世界artifact hash> --target <已保存世界的授权JSON>`；仅布局typed diff、状态保留 |
| E5 | 同E4，明确授权实际全局 EnvironmentStyle 实体和指定主光实体，排除其他灯光与布局；天空/地平线/角色三视角、玩法和布局保留 |

E4/E5现有存档目标格式见 `target.template.json`，不得自动扩大范围；必须先在实际目标完成可观察操作并保存，读取新的revision和authored hash。宿主要求原生证明同一owned checkout源自该artifact，使用原世界建draft而非重新checkout。初始空存档不能证明已有进度保留。`--grant`/`grant.template.json`仅用于从artifact新建测试副本，不能与`--target`混用。E2若只有目标metadata而无实际入口，只能记录声明，不能把其他模板门户算作个人返程通过。E3创建新作品，旧蓝图的展示配置不变；prepared/source 区别必须保留。将旧tabletop artifact直接改floating的请求目前会返回fixture_migration_required，不作为E3成功路径。

### E4/E5：已有进度上的局部候选与 patch 导出

先等待 E2 完全终态、所有 playtest 已结束，再完成下述普通输入往返脚本。记录真实世界 artifact、已读 scalar 为 true、完整阅读正文、正常返程及新 instance 重进；其 `saved-target-snapshot.json` 是后续目标快照。不能在当前 E2 尚在运行时执行下一次 `prepare`，因为该命令会更新 acceptance root 的当前请求记录。

每次 E4/E5 提交前，核对快照对应的原 owned 世界仍存在，实际 scalar 仍为 true，重新取得最新 authored revision/content hash。授权 JSON 只包含 `worldId`、`baseRevision`、`baseHash`、显式 `allowedEntityIds` 和 `allowSpawnChange`；不要把整个快照的额外证据字段直接作为 target 提交。

- E4：只列允许调整的实际静态实体。移动一个物件组合时，明确列出需要共同移动的 owner、交互点及子实体，不能仅凭名字推断整个模块均已授权。既有聚合庭院资源不能当作可单独移动的内部桌子/网格；它们未必有独立稳定 ECS 身份。保持 `allowSpawnChange:false`，排除 player、控制器、返程入口以及未授权布局。typed diff 仅允许相应 transform/collider/navigation_surface；本用例不请求新资产。
- E5：本用例同时请求全局环境和主光变化，因此必须列出实际承载 EnvironmentStyle 的实体以及实际指定主光。不能只给主光 grant 后期待修改未授权环境，也不能默认授权全部局部灯光。实体 ID 从实际世界读取，可能带模块 namespace；不要猜测必然是 `environment` 或 `sun`。保持 `allowSpawnChange:false`，排除布局、交互物与玩家。
- 两者均使用同 player/home/session 的 E2 世界 artifact 和已有保存目标。E2 已锁定的 runtime GameplaySpec、物件 identity、资源 hash 与完整正文必须保留；不要误填独立 E1/E3 用例的另一段正文。`maxAiAssets:0,maxSkyImages:0` 禁止新增供应商模型/云图，预算仍由宿主配置提供。

以下命令从 Aura 根目录执行，使用前文已配置的 `$acceptRoot`、`$identityFile`、`$workerDescriptor`、`$fixtures`。目标文件必须先按实际检查结果填写；这些示例命令尚不代表用例已运行。

```powershell
$savedTargetFile = 'C:/veya-acceptance/evidence/roundtrip-01/saved-target-snapshot.json'
$savedTarget = Get-Content -Raw -LiteralPath $savedTargetFile | ConvertFrom-Json
$worldArtifact = $savedTarget.artifactId
$layoutTargetFile = 'C:/veya-acceptance/E4-target.json'
$nightTargetFile = 'C:/veya-acceptance/E5-target.json'

# E4：明确授权的已有保存世界；响应丢失时只重试 submit，保留 request ID。
pnpm --filter @aura/runtime exec tsx test/creator-acceptance/cli.ts prepare --root $acceptRoot --case "$fixtures/E4-layout.json" --identity $identityFile --previous-artifact $worldArtifact --target $layoutTargetFile
pnpm --filter @aura/runtime exec tsx test/creator-acceptance/cli.ts submit --root $acceptRoot --worker $workerDescriptor
pnpm --filter @aura/runtime exec tsx test/creator-acceptance/cli.ts status --root $acceptRoot
# 仅在实际终态、确认已导出后检查 artifact；失败先保留完整报告。
pnpm --filter @aura/runtime exec tsx test/creator-acceptance/cli.ts artifact-proof --root $acceptRoot
pnpm --filter @aura/runtime exec tsx test/creator-acceptance/cli.ts paid --root $acceptRoot

# E5：E4结束后再执行；重新核对并填写 E5 target，仍明确引用原 E2 保存世界。
pnpm --filter @aura/runtime exec tsx test/creator-acceptance/cli.ts prepare --root $acceptRoot --case "$fixtures/E5-night.json" --identity $identityFile --previous-artifact $worldArtifact --target $nightTargetFile
pnpm --filter @aura/runtime exec tsx test/creator-acceptance/cli.ts submit --root $acceptRoot --worker $workerDescriptor
pnpm --filter @aura/runtime exec tsx test/creator-acceptance/cli.ts status --root $acceptRoot
pnpm --filter @aura/runtime exec tsx test/creator-acceptance/cli.ts artifact-proof --root $acceptRoot
pnpm --filter @aura/runtime exec tsx test/creator-acceptance/cli.ts paid --root $acceptRoot
```

每个 patch 的通过证据必须包含：

1. 宿主与原生 lineage 对同一个已保存 world/artifact/revision/hash 的校验；未使用新 checkout 代替旧存档。
2. 原生 overlay 的稳定实体集合与组件范围 diff，修改只落在显式授权范围；未授权 Dialogue、玩法、资源绑定和源模块保持原样。
3. **saved baseline 先于 authored baseline**：begin 保存并取得实际源进度，在 candidate 完成恢复及 on_start 后、激活前，原生 `preserve_existing` 对比旧 scalar 和规定的持久领域事实。报告需有同候选 `source-preservation` receipt、零差异，并检查该 saved baseline 的 initial observe 中原已读 key 仍为 true。空源存档或在重建后重新读一次才变 true，不满足此检查。
4. `playtest.save_resume` 真写盘、卸载重建；新 instance/epoch、原生 `exact` 进度投影一致和独立观察均通过。范围为已声明的 scalar/Inventory/Quest/POI/机关/领取/插槽/交互进度/Journal/Trigger.fired 等领域事实，不代表位置、瞬态 Dialogue、全部 Save 字段或私有钱包的全量比较。
5. 保留的 authored 世界契约与每个 prop 的独立 fresh baseline 回归通过，首次/关闭后重复阅读仍显示原完整正文，并有候选绑定的实际截图。E4 验证真实路线与碰撞，E5 验证天空/地平线/角色视角；两者保留真实性能和保存恢复门禁。
6. 最终 patch、candidate、模块、依赖和证据 hash 一致，供应商新增费用为零；未实际执行的平台继续标记未验证。

**patch 导出不表示已交付。** 本轮证明的是已有保存源上的授权候选、进度保留、真实验证和不可变 patch 成果；前台应用事务由后续任务实现。现有 `world-roundtrip.ts` 的 world/prop 分支会 checkout authored 新副本，不能拿它给 patch 做“原世界已应用并保留存档”的假验收，也不能把 E4 导出后直接执行 E5 说成 E5 已基于 E4 的修改世界。本节默认 E4/E5 分别验证同一个 E2 保存源；真正串联应用需另有经过验收的交付路径。

```powershell
pnpm --filter @aura/runtime exec tsx test/creator-acceptance/cli.ts artifact-proof --root $acceptRoot
pnpm --filter @aura/runtime exec tsx test/creator-acceptance/cli.ts stop --root $acceptRoot
```

`artifact-proof` 按原始字节验证manifest SHA256、candidate/type和产品projection，下载每个引用blob核对长度/hash，并要求未引用blob被拒绝。它保存原manifest，不删字段、不重新计算内容。原生候选/证据篡改拒绝和实际 checkout 还须独立测试，不能由HTTP证明代替。只在安全终态停止服务；工具不终止任何Veya进程。

### 生成世界的正式往返与已有进度

`world-roundtrip.ts` 在 Flow 已结束、没有 active playtest 后运行。打包 worker 必须显式加 `--creation-owned-input-test`，启用受身份限制的私有 `/v2/testing/creation-input` 测试入口；该入口不进入 canonical 工具或 Aura Action，也不是生产自动驾驶。脚本先 checkout 验收过的世界成果，进入其正常 owned 世界，在真实碰撞下提交普通 LocalPlayer 输入，到达阅读目标、等待同一 action_id 提交完成、记录正文和已读 scalar，然后使用真实 `return_home` 入口返回 profile 个人广场。旅行会保存真实 runtime；再次进入原世界必须得到新 instance，并保留已读状态。

```powershell
# 从最终报告/受信 edit_context 填入实际 artifact、组合后实体ID、状态key和固定正文。
# toReading/toReturn 可填真实场景中已检查的测试路线坐标；不会修改场景布局。
$roundtripCase = 'C:/veya-acceptance/world-roundtrip.json'
$roundtripOutput = 'C:/veya-acceptance/evidence/roundtrip-01'
pnpm --filter @aura/runtime exec tsx test/creator-acceptance/world-roundtrip.ts --worker $workerDescriptor --case $roundtripCase --output $roundtripOutput
```

格式见 `world-roundtrip.template.json`。`scalarBefore:null` 表示初始状态没有该 key；若作者显式初始化为 false，则填 false。每次使用新的输出目录，已声明的测试身份不会被覆盖重跑。输入按实际角色位置和测试回执中的 ECS 相机 yaw 转换，操作逐次核对 world/instance/revision/epoch/artifact，最多 180 段/3600 个物理 tick；碰撞不通、回执未知或状态不符时停止，不改控制器、不 teleport、不重交已提交动作。脚本不读取或打印描述符凭据。

成功的 `saved-target-snapshot.json` 只保存真实当前世界及 authored hash/revision，**不自动授权编辑实体**。E4/E5 必须另选明确的 `allowedEntityIds`，以同一 artifact 加该目标开始局部修改，并核对保存过的 scalar。纯进度保存不增加 authored revision，验收比较事实和实例重新创建。正文的 ECS 观察只证明玩法数据；可读像素仍以 Flow 的真实截图验证为准。该脚本存在或类型检查通过不等于实际往返已经验收。

重进后脚本还会再次沿正常输入路线接近原交互点，重新提交一次 `talk`，等待该新 scope 中的独立 action receipt，观察正确 owner 上的完整正文与原 scalar，再用正常关闭选项关闭面板。报告分别保存 `rereadAction`、`reread`、`rereadClosed`；旧 instance 的回执、拒绝动作、错误 owner/正文、丢失 scalar 或未关闭面板均拒绝。action_id 是 scope 内身份，跨 instance 可出现相同数字，不能据此当成同一次动作。此补充适用于 world 与 floating prop；此前只有重进 scalar/inactive 观察的旧报告不补写成已重读。

E3 使用同一脚本的显式 `artifactKind:"prop",display:"floating"` 分支，格式见 `prop-roundtrip.template.json`。原生 checkout 必须返回对应 prop 及可信 edit_context 中的 floating 展示规格。`targetId` 是地面锚点，`ownerTargetId` 必须是不同实体；动作提交给锚点，完整正文与状态从 owner 观察。将至少两个已实际检查通路的 waypoint 填为有限数值，普通输入必须到达它们，且在第一次操作前累计至少两米真实水平位移。出生即在操作范围内不能满足此门禁。每个输入 operation 的真实 start/end position、ticks、camera_yaw、scope 和到点观察都会保留；这些是受控正常输入与碰撞路径证据，不代表真人键盘操作。

浮空验证场景通过 profile 的可信 homeWorldId 调用 travel.enter，保存后再次进入原 owned fixture，要求新 instance 与原已读事实；这个退出明确标记为测试场景保存路径，不冒充世界的 authored 返程门户。正常旅行的新 instance 可以再次从相同 epoch 数字开始，因此用 instance + epoch 组合区分；Flow 自身 save_resume 的 epoch 门禁不变。默认 world 分支继续验证实际 return_home 入口。新的 prop 测试分支必须在对应真实成果完成后单独运行；通过 helper 单测不算 E3 通过。

## 记录和检查

每轮保留request/Run/answer身份、源码hash、包EXE/DLL/PCK hash、renderer/平台/分辨率、新绘制帧序号、supplier task与实际/增量费用、candidate/artifact/blob hash、存档epoch和缺陷原因。制作时通知前台隔离测试执行者；性能采样前停止额外探针和测试GPU负载。保留失败和未验证平台，禁止用mock、数据测试或库存模型冒充E1真实文本生成。

```powershell
pnpm --filter @aura/runtime run typecheck
pnpm --filter @aura/runtime exec tsx test/creator-acceptance/cli.ts help
pnpm --filter @aura/runtime exec tsx --test test/veya-creator.test.ts test/veya-creator-artifacts.test.ts test/veya-creator-recovery.test.ts
```

生产源码/插件共享helper变化后建立新关联Run，保持旧历史。打包worker DLL只能在所属进程停止后替换。测试用例或脚本存在不等于已实际通过验收。

如果唯一模型格式纠正原样返回坏 JSON，宿主仅允许一次受信续接：`recovery --source-request <该次任务>` 会重读其持久 creator-context 和完整原始祖先，确认当前整树没有 Plan 重跑、review/revise 或制作/付费，并要求格式输出与原 draft 逐字节相同。新 grant 明确 `formatCorrectionUsed:true`；后续只能执行插件的有界纯语法规范化，不能重领模型格式预算。该续接本身再次失败时不会重复准入；任何改变过的模型输出也不准入。检查实际 grant 文件并固定新 catalog 后再提交关联任务，历史失败保持原样。

`retainedSpec` 复审续接用于完成语义修订后仅被复审拒绝的只读终态。宿主要求完整祖先证明，以及capabilities/revise/review-revision三步全部结束；所有终态问题必须逐项等于实际criticalIssues，不按文字挑选。返回原持久revise JSON对象及SHA256(JSON.stringify对象)的specHash，并把semanticRevisionUsed/reviewRetryUsed设为true。新插件可按已固定契约迁移验收kind并执行唯一只读复审，不重新设计。任何再次带reviewRetryUsed的失败链、隐藏制作、未完成或来源变化都拒绝。运行后必须记录原/迁移后hash和实际复审结果，不把准入当制作通过。

### 新世界任务复用已完成的公共程序化资源

若世界任务在公共静态 Cooker 三件套完成后阻断，可用 `prepare ... --reuse-assets-from-request <原request UUID>` 创建新的世界任务。原 case 文本、player/home/creationSession 必须相同；与 `--previous-request`、`--previous-artifact`、目标和参考字段互斥。这是独立的资产复用授权，仍执行新任务规划与设计，不携带原世界、草稿、repairRound、费用或续接资格。

宿主从完整终态 Build→公共 WorldAssets→Procedural 的持久记录取得原需求、visual/collision/navigation 精确绑定和成功 Cooker operation/sourceHash。只支持无动作的静态 procedural 公共资源；prop 自有资源、未知/未结束操作、变更需求和费用未知记录均拒绝。`creator-context` 返回 `assetReuse` 前，再通过固定 worker 的 `veya.assets.list` 核对三项 hash/type/source_asset_id，不回落前台。相同已完成源配方的重复 Cooker 提交会被拒绝；插件应把匹配需求的三件套传给已有 WorldAssets.previous 路径。需求变化不能仅改ID套用旧资源。客户端不提供 grant JSON、文件路径或绑定哈希。

2026-09-30 的082468来源已用原持久JSON只读核验出一个garden_geometry grant；该资源是包含桌/底座等细节的整块庭院，并非独立prop模型。服务/实际新Run仍须在最新插件冻结后执行，静态证明与窄测试不算新的真实生成或玩法验收。

若已经获准的资产复用任务在首次只读Design产生malformed JSON，可按前述语法恢复仅使用 `prepare --previous-request <该设计任务request>`；不要同时传 `--reuse-assets-from-request`。宿主重新证明原资产生产树、源任务的两个持久context、同身份及锁定Plan需求后，保留同一assetReuse和原worldDesignRecovery，之后再核live目录。该继承只支持首次、未消费修订预算且完整无副作用的语法失败，不将制作过的任务或已用完恢复链变为只读；旧Run/公共资产/预算历史均不改写。

首次确定性格式续接已完成唯一semantic revise、仅因完整review criticalIssues阻断时，宿主可以按既有retainedReview规则再允许一次只读复审。仍用 `prepare --previous-request <最近关联任务request>`，不传reuse引用或JSON；宿主验证1/2处原始closing删除记录、全部原文与SHA、原规格、两层固定context/身份及原producer，三个预算标志都置为已消费。新步骤只复审原规格；任何新criticalIssue继续阻断，该任务失败后不再允许延长此链。是否准入由宿主持久证明决定，CLI不能代替或覆盖。

### 性能 Action 开始通知

在已授权 Run 进入 Verify 前启动只读观察器；不必等十秒性能采样结束后再执行普通 `status`：

```powershell
pnpm --filter @aura/runtime exec tsx test/creator-acceptance/watch-performance.ts C:/veya-acceptance REPLACE_ROOT_RUN_UUID
```

它仅访问该验收 root 记录的 loopback **4312** Aura Run 读取接口，每次沿活跃子 Run 读取完成后等待一秒，不访问 Veya、renderer、Cooker 或用户 4311。进入 Baseline 时即时输出 `baseline_entered`；发现 `veya/world-performance` 持久步骤为 `running` 时立即输出 `performance_running`，包含根/子 Run ID、完整 candidate hash、stepKey、startedAt 及观察 UTC，并退出。将该事件立即通知内存采样执行者。首次读到 completed 只输出 `performance_missed`，不能据此声称覆盖了开始时刻。服务读取失败或超时也不能算性能验收成功。

事件逐行保存在 `evidence/performance-watch-<rootRunId>.jsonl`，读取过的真实 Run 使用独立的 `watch-run-<RunId>.json` 文件，不与 CLI status 的 `run-*.json` 并发写同一路径。最终仍需重新取完成的 Baseline 与父链，用原生内存脚本按真实 durable Action UTC 区间绑定样本；观察器不保证网络/调度延迟下完整覆盖十秒窗口，也不把 Action 区间当作精确 renderer 采样时间。先看到 Baseline 和 candidate 后可准备采样，`running` 通知用于确认实际开始。一个观察器只监视一个已授权 Run，不提交任务、不改变 Flow 顺序或延长采样。
