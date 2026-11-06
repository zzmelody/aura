# @aura/orchestration

定义与工具注册的已知错误携带有界 ID、源码行号、操作枚举或数值上限，保留原 message/status。注册器的 `displayCatalog()` 只为公开 UI 副本附加 `errorDetails`，原 `catalog()` 与模型执行不带显示信息；替换、清理和卸载同时清理对应详情。`definition-errors.test.ts` 验证投影隔离、自定义诊断回退和原状态码。

插件 `ActionFailure` 可提供六语字面译文；WeakMap 与 direct-dispatch 私有回调将其传给运行显示映射，不在 Error 对象、Action 上下文、DSH 工具结果或存档中添加译文。页面/准入边界保留 `PluginFailure` 的受限显示数据。业务词库由插件拥有，未声明译文的旧插件保持原消息。

宿主操作的临时错误可使用 `@aura/protocol/errors` 的 `CodedFlowError`，保留既有可读 message/status，供 runtime 的 RPC/HTTP 边界投影。未知编排操作已提供稳定码。展示详情不写入 Flow 运行记录、插件存储或 Agent 上下文，既有插件 `FlowError` 契约不变。

运行/步骤不存在、重复请求冲突、暂停/恢复状态、检查点与人工处理、子运行操作、历史 attempt、产物预览及插件配置加载的已知拒绝携带稳定显示码。命令、运行记录、恢复策略、产物字节和配置回滚保持原行为。`engine.test.ts` 验证拒绝不会改写已完成记录或复用不同输入，产物测试验证预览格式错误保留原 415 状态。

`FlowDisplayErrors` 为运行、步骤和 attempt 保存最多 1024 条临时显示详情，仅存消息摘要和经过协议校验的错误码/不确定标识。`FlowEngine.view()` 克隆运行并投影这些信息；公开运行 RPC 在返回边界使用它，执行、插件后端、Agent 工具和存储仍使用原 `get()`。已知模型/Action 失败、一般代码失败和执行超时可显示当前语言，并保留需人工确认的警告。结果恢复、重试或存储策略不变；旧/未知错误、缓存淘汰和重启后的记录保留原消息。详情不写入 schema、命令、Flow 记录或模型上下文。

恢复分支通过只读反馈回调记录显示码：memo/子运行认领、工具结果未知、记录核对、输出认领、重试预算及旧身份/模型配置/版本不兼容。运行与步骤恢复事件的 `reasonDetails` 只附加到显示副本；原 `reason`、时间、状态和恢复策略保持原样。恢复通知与错误共用有界缓存，匹配原消息摘要和事件时间，不按旧句子推断类别。显式取消的运行也投影取消说明。

`schema.ts` 的标准校验失败附加结构化字段原因，`parseJson` 根据调用点的已知上下文标识输入/输出，JSON 格式与大小限制也附加显示码。旧诊断完整保留在 `message`，自定义原因、未知上下文与超出支持范围的诊断继续沿用原文。包含边界与严格大于/小于的含义不变；已知校验失败可进入 Flow 的临时显示映射，不改变 Schema、输入、输出或存档。

DSH 依赖统一固定为 `0.2.1-rc.5`，Cordis 为 `4.0.5`，loader / include 分别固定为 `1.0.6` / `1.0.10`。本包的 Zod 与 DSH domain 层统一为 `4.4.3`，Schema 持久化校验在 Aura 侧适配。升级使用已发布包，保留现有 profile、会话 ID、domain 与存储格式，不执行用户配置或历史数据迁移。集成测试通过隔离目录和本地合成模型验证授权、执行、取消与恢复，不调用真实付费模型。

目录读取直接投影已加载的最后可用定义，不触发磁盘扫描；HTTP 目录提供 ETag / 304。发现保留 Cordis HMR，新增/移除的兜底扫描为 5 秒，并合并同一发现器上并发的扫描请求。发现只处理目录和入口增删，已挂载模块由 DSH HMR 更新；不扫描源码依赖、不计算源码哈希。

动态插件配置接受并保留 manifest 的可选 `description`（最多 500 字符），启用和停用均遵循同一状态协议；合法的插件简介不会阻止配置应用。未知字段仍拒绝。

在线对话通过 `aura_flow_catalog` 读取所有可用 Flow 的公开输入 Schema，通过 `aura_run_flow` 调用相同的 durable 引擎，通过 `aura_flow_status` 读取原 Run 的当前输入与结果。明确的重复执行生成新 Run；同一工具 call ID 沿用原算法的稳定 requestId，保留旧执行的幂等身份。未知提交或读取结果阻止本轮自动重新启动，已接收运行的引用仍进入工具结果以便历史恢复。新运行可带可选 `conversationId`，在原 Run 格式中附加归属，列表同步返回，避免工作台重复导入为另一段会话；不迁移或重写旧记录。模型和执行仍经 DSH，停止聊天不会自动取消独立 Run。

启动与查询工具会向外层 Agent 返回有界的步骤诊断：步骤 ID、子 Run、已记录的失败原因、人工输入要求、当前 attempt 耗时和剩余退避时间。运行时已检测到状态存档失败时，即使最后落盘的状态仍显示 running，也会返回存储故障。诊断复用面向用户的错误，不读取原始模型响应或日志。启动工具只短暂等待，后续故障通过原 runId 查询。

`@aura/orchestration/service` 提供 DSH 宿主装配的 Flow 与 Action 服务。`artifacts/` 负责产物登记、历史绑定和读取，`managed-process/` 提供插件可用的受管进程和系统资源租约。Flow 的 HTTP 路由由 [Runtime](../runtime/README.md) 挂载。

Aura 的 durable workflow script 引擎。脚本负责控制流；Graph 是只读静态投影。恢复从 `run()` 入口重放，完成的关键调用返回存档结果。运行时不保存 JS 栈、闭包、Promise 或任意局部变量。

## 编写 Flow

内置 Flow 支持 `flow/<flow-id>/<flow-id>.flow.ts`，兼容原有 `.flow.js`；每个一级目录只允许一个同名入口，本地辅助模块可以嵌套。新增内置入口使用 TypeScript。外部插件仍按公共 SDK 契约加载 ESM JavaScript。使用公开 `@aura/orchestration/flow` 导出获得类型推导。

```js
import { defineFlow, z } from "@aura/orchestration/flow";

export default defineFlow({
  title: "调研并确认",
  input: z.object({ task: z.string().min(1) }),
  output: z.object({ report: z.string(), approved: z.boolean() }),
  concurrency: 2,
  async run(ctx, input) {
    return ctx.sequence({ id: "main" }, async (flow) => {
      const results = await flow.parallel({
        id: "analysis",
        branches: {
          research: (branch) =>
            branch.agent({
              id: "call",
              label: "方案分析",
              preset: "researcher-v1",
              prompt: input.task,
              retry: { maxAttempts: 2 },
            }),
          review: (branch) =>
            branch.agent({
              id: "call",
              label: "风险审阅",
              preset: "reviewer-v1",
              prompt: input.task,
            }),
        },
      });
      const approved = await flow.checkpoint({
        id: "approval",
        label: "确认报告",
        prompt: "是否采纳这份报告？",
        schema: z.boolean(),
      });
      return {
        report: results.research.output + results.review.output,
        approved,
      };
    });
  },
});
```

根 `ctx` 只暴露 `runId`、`mode`、`signal` 和 `sequence({id}, callback)`。作用域回调收到的 `flow` 还提供以下调用：

| 调用                                                                                                                 | 返回值 / 语义                                                                           |
| -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `agent({id,label,preset,prompt,images?,actions?,retry?,model?,reasoningEffort?,maxTokens?,temperature?,timeoutMs?})` | `{stepId,sessionId,output:string,attempt,recovered}`；每个 attempt 使用独立 DSH session |
| `action({id,label?,action,input,retry?})`                                                                            | `{stepId,actionId,output,attempt,recovered}`                                            |
| `flow({id,label?,flow,input})`                                                                                       | `{stepId,runId,flowId,output,recovered}`；启动并等待一个持久化子 Flow                   |
| `sequence({id}, callback)`                                                                                           | 串行子作用域，返回 callback 的结果                                                      |
| `parallel({id,branches:{name: callback}})`                                                                           | 每个具名分支是独立串行作用域，返回同键结果对象，等待所有分支结束后汇合                  |
| `memo({id,label?,schema,compute})`                                                                                   | 保存 schema 校验后的 JSON 结果；完成后重放不会调用 compute                              |
| `checkpoint({id,label?,prompt,schema})`                                                                              | 持久化输入要求，等待人工答案，重放返回已校验的答案                                      |

所有作用域调用必须 `await` 或 `return`。串行作用域不能重叠调用；并发统一使用 `parallel`。同级 ID 唯一（1–64 个字母、数字、下划线或连字符，首字符为字母/数字）。步骤的 `stepKey` 为作用域路径加本地 ID，例如 `main/analysis/research/call`；返回的 `stepId` 就是这个完整 key，记录中的 `id` 仍为本地 ID。循环须用稳定业务键创建子作用域或步骤 ID。单 Run 最多 64 个 durable 步骤；并发调用数由 `concurrency` 控制（1–4，默认 2）。Graph 无法静态展开的动态分支会显示提示，实际路径见运行记录。

V1 不支持 parallel 分支内的 checkpoint。运行时暂停会退出作用域；即使脚本捕获了内部暂停异常，也不能继续发起关键调用或提交完成结果。

### 嵌套 Flow

`flow.flow()` 接受 catalog 中的规范 Flow ID。引擎先用子 Flow 的 input Schema 校验输入，随后把子 Flow 的插件身份、稳定请求 ID 和 child Run ID 保存到父步骤；子 Run 继续使用自己的 output Schema、步骤、重试和恢复记录。父流程重放时认领原 child Run，不会重复创建或把调用降级为隐藏 Action。子流程的 completed、waiting_input、needs_attention、paused、cancelled 和失败状态会传播到父流程；暂停和取消也沿父子关系向下传递。

子 Run 由等待它的父执行片段内联调度，不占顶层 FIFO 的 32 个运行槽，因此多个父 Run 不会因等待排队中的子 Run 而死锁。最多嵌套 8 层；调用链中出现相同规范 ID 会在创建子 Run 前以循环调用拒绝。子 Run 不单独出现在顶层运行历史，但可通过完整 Run API 读取，并在父步骤内展开查看和处理 checkpoint。

内置 Flow 可以调用任意已注册 Flow。插件 Flow 可直接调用同一插件命名空间的 Flow；跨插件或调用内置 Flow 时，插件 manifest 必须声明宿主支持的 `aura.flow.invoke` capability。权限按调用方已固定的插件版本检查，目标仍必须使用 catalog 中的规范 ID。

`memo` 可封装时间、随机数和只读计算，必须返回 JSON；在结果落盘前崩溃时允许重新计算。外部写副作用必须通过 Action。普通 JS 代码每次重放都会重新执行，必须保证它基于固定输入和已存档结果走出一致路径。重放时同一步骤的请求指纹变化，或完成时存在未访问的历史步骤，都会以 `FLOW_REPLAY_MISMATCH` 中断。

输入、输出、memo 和人工答案使用不超过 256 KiB 的 JSON；Agent 输出为 1–80,000 字符。checkpoint/memo 的 Zod Schema 必须能转换为可存档和重新校验的 JSON Schema；依赖执行代码的 transforms、refine/superRefine、overwrite（包括 trim）及自定义 `when` 等规则会在持久化前明确报错，避免恢复时丢失校验。Zod 4.4 为每个字符串/数组 min/max/length 检查创建独立的长度类型条件，Aura 与当前安装版本的原生函数实现比对后将其保存为标准 JSON Schema；仅相同 check 名称或重写函数的 `toString` 不能放行自定义条件。该检查面向受信任插件的 Schema，不作为任意 JavaScript 闭包的安全隔离。

## 每个 Agent 的模型参数

### 受控图片输入

`images` 最多接收 4 个 `FlowImageReference`，包括 DSH 返回的 `attachmentId: "sha256:<digest>"`、`mediaType`、`bytes`、宽高和可选名称/原始尺寸；不接受文件路径、URL 或 base64。运行记录/请求指纹只保存这些引用；Session 边界通过 DSH attachment store 校验并读取实际图片，再传入 Session Controller。还会检查 DSH 自身的数量及消息总字节限制。图片缺失、损坏或模型不支持视觉时失败，不降级为纯文本。`MODEL_DOES_NOT_SUPPORT_IMAGES` 会作为可定位的安全错误保留。当前 demo 模型不支持图片；真实视觉验收需要选择支持图片的运行模式/模型。

### 参数优先级

参数优先级为 **步骤选项 > `defineFlow.agentDefaults` > 运行时默认值**；字段为 `undefined` 时继承。旧的 Flow 级 `agentTimeoutMs` 仍有效，但优先级低于 `agentDefaults.timeoutMs` 和步骤 `timeoutMs`。

```js
export default defineFlow({
  title: "分别配置 Agent",
  input: z.object({ task: z.string() }),
  output: z.object({ report: z.string() }),
  agentDefaults: { timeoutMs: 1_800_000 },
  async run(ctx, input) {
    return ctx.sequence({ id: "main" }, async (flow) => {
      const research = await flow.agent({
        id: "research",
        label: "调研",
        preset: "researcher-v1",
        prompt: input.task,
        // provider 由 Run.mode 决定；Demo 只调用本地模拟服务。
        model: ctx.mode === "codex" ? "gpt-5.6-terra" : "deepseek-v4-flash",
        reasoningEffort: ctx.mode === "codex" ? "medium" : "off",
      });
      const review = await flow.agent({
        id: "review",
        label: "深度审阅",
        preset: "reviewer-v1",
        prompt: research.output,
        reasoningEffort: ctx.mode === "codex" ? "high" : "off",
        timeoutMs: 1_800_000,
      });
      return { report: review.output };
    });
  },
});
```

| 参数              | 范围与默认行为                                                                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`           | 当前模式 provider 下的模型 ID，1–200 字符。Codex 默认 `AURA_CODEX_MODEL` 或 `gpt-6.1-sol`；Demo 默认 `deepseek-v4-flash`                                                              |
| `reasoningEffort` | DSH 对所选模型支持的准确档位；Codex 默认 `xhigh`（Extra high），Demo profile 仅支持 `off`。不做静默降档或别名转换                                                                     |
| `temperature`     | 0–2；不设置时交给供应商默认。透传到 DSH，请求是否接受该参数由具体模型决定                                                                                                             |
| `maxTokens`       | 1–1,000,000 的整数，具体模型还可能有更低限制。Demo 默认 4096。**当前锁定版本的 Codex 适配器不转发此字段，因此 Codex 模式显式设置会报 `AGENT_OPTION_UNSUPPORTED`，不承诺伪造的硬上限** |
| `timeoutMs`       | 1,000–1,800,000 的整数；默认 1,800,000。限制每次 Agent attempt 的总时长，不是整个 Run 或单次模型请求的时长                                                                            |

不开放脚本级 `provider`、API key、base URL 或任意 provider 参数；凭据和路由仍在后端 DSH profile 中管理。选择 `preset` 用于角色/工具环境，不能覆盖本次已固定的模型参数。模型配置的元数据校验在创建 Agent attempt 前执行；不支持的模型或思考档位给出明确错误，不自动换模型。

Run 入队前保存已合并的 `agentDefaults`，每个 Agent step 在调用前保存 `config` 并纳入 `requestHash`。重试、人工重试及重启都使用同一配置；即使环境默认模型变化，尚未访问的后续 Agent 也继承原 Run 默认值。脚本在重放中显式改变步骤参数会触发 `FLOW_REPLAY_MISMATCH`。底层供应商自身的模型实现和未设置的采样默认值不在 Aura 可冻结的范围内。

所有 Flow 每次连续执行最长 360 分钟，包括嵌套调用和步骤重试；到期会中止运行及活动子流程，记录 `FLOW_TIMEOUT`。暂停和等待人工输入期间不计时，恢复后重新开始执行窗口。单次 Agent / Action 调用默认及最大为 30 分钟，底层普通 HTTP 请求与服务启动探测仍保留各自的短期限。

Graph 节点详情展示的是参数声明/表达式，不执行它们；展开运行步骤可以查看真正存档的 provider、模型、思考强度、温度、token 配置与超时。

升级前未存档 Agent 配置的未结束 Run，在恢复时标记 `agent_config_unrecoverable`，要求新建运行，不擅自套用新默认值；已完成历史保持可读，未保存的配置明确显示为旧记录。存储域版本仍为 1。

## Action 与重试

Action 入口为 `action/<action-id>/<action-id>.action.js`。Action 使用 DSH 原生工具 Schema DSL；`output.render` 给模型呈现结果，`execute` 返回结构化 JSON。默认异常只记录稳定错误码；需要在 Workflow 中展示的安全、产品化说明必须显式抛出 `ActionFailure`，且不得包含凭据、私有路径、签名 URL 或堆栈。

```js
import { ActionFailure, defineAction } from "@aura/orchestration/action";

export default defineAction({
  title: "转为大写",
  description: "纯字符串转换，可安全重复。",
  recovery: "idempotent",
  parameters: { text: { type: "string", required: true } },
  output: {
    schema: { type: "string" },
    render: (_input, output) => [{ type: "text", text: output }],
  },
  async execute(ctx, input) {
    ctx.signal.throwIfAborted();
    if (!input.text.trim()) throw new ActionFailure("请输入需要转换的文本。");
    return input.text.toUpperCase();
  },
});
```

Action `recovery` 默认为 `manual`。只有显式 `idempotent` 的直接 Action 才能自动重试。网络写操作需要把 `ctx.idempotencyKey` 交给支持去重的服务；编排器传递稳定 key，无法单独保证 exactly-once。

`retry` 配置在每次 `agent/action` 调用上：`maxAttempts` 默认 1、最大 10；`initialDelayMs` 默认 1000、`multiplier` 默认 2、`maxDelayMs` 默认 30000。预算包含第一次调用、失败尝试和崩溃中断的 attempt；退避截止时间被持久化。预算耗尽的失败可被脚本捕获并降级；重放遇到同一失败再次抛出保存的错误。整个 Run 进入 failed 后为终态，只能新建 Run。

`ctx` 还提供 `signal`、`cwd`、Action 目录 `directory`、每次工具调用的 `callId`、`mode`，以及调用方存在时的 `runId`、`stepId`、`sessionId`。直接 Flow Action 的 `idempotencyKey` 跨 attempt 和重启保持不变。Agent 内部 Action 调用由 DSH 记录和调度，不是单独的 Flow durable step；未完成 Agent 一旦调用过工具，就需人工处理，不能自动重跑整个 Agent。

外部插件可以通过 `@aura/plugin-sdk/action` 的 `auraCapability(ctx, id)` 使用 manifest `permissions` 已声明且宿主支持的领域能力；本插件后端的私有服务经 `ctx.services` 提供。能力实现由长驻宿主或插件后端持有，Action 只收到固定操作及 JSON 结果，不接触凭据、任意 URL 或进程句柄。

Flow Agent 使用 fail-closed 工具白名单：固定为原生工具呈现并屏蔽 DSH、preset 及 profile 的全部继承工具，只把 `flow.agent({actions:["your-action"],...})` 显式声明的 Action 注册到当前 Agent scope；未声明时模型工具集合为空。profile 对已知内置工具的禁用继续作为纵深防护，未来新增的 DSH 默认工具也不会自动进入 Flow Agent 上下文。Action 名称冲突会拒绝。直接 Action、Agent 共用 Flow 并发门，Agent 内部工具使用 DSH 的并发安全和超时策略。全部内置和仓库插件的 Action 超时统一为 30 分钟，最大也为 30 分钟；取消、暂停和关闭需要代码遵守 `signal`，无法强制打断阻塞 JS。

## 队列、恢复与人工处理

Run 创建时先写入持久化 FIFO，默认最多同时执行 32 个顶层 Run。queued、running、pausing 属于活动执行；paused、waiting_input、needs_attention 释放运行槽。进程关闭保留 active durable 状态，下次启动协调；用户显式取消才进入 cancelled。

启动时先完成 Loader、Flow/Action discovery，再恢复记录：

- 校验 Flow hash 和已引用 Action hash，版本不符标记 `revision_mismatch`，要求新建运行。不保存旧可执行版本；运行中仍固定当次加载定义与 Action 快照。
- completed 步骤复用输出；queued 尚未开始的步骤重新调度。
- Agent 根据预先保存的 sessionId/requestId 核对 DSH 持久事件；已完成回合直接认领输出。没有工具调用的中断 attempt 按 retry 剩余预算重试，预算耗尽则失败。
- Agent 已发起工具调用、DSH 记录无法核对，或普通 Action 执行期间中断：步骤变为 unknown，Run 进入 needs_attention。
- idempotent Action 在剩余预算内使用同一 key 重试；memo 未完成可重新计算。
- 升级前 active 记录没有 durable identity，标记 `legacy_unrecoverable`；旧 completed 记录继续可读。`aura_code_flows` domain 保持 version 1，新增字段向后兼容。

暂停采用 cooperative drain：queued 立即 paused；running 先 pausing，停止发起新步骤，让已开始步骤完成，再退出为 paused。继续运行从入口重放并复用结果。checkpoint 提交答案后重新排队。

unknown 步骤支持 `retry`（每个新请求授权增加一次 attempt 预算）、`submit_output`（校验 Action 输出 Schema 或 Agent 字符串）、`terminate`（取消 Run，保留未知 attempt 审计）。一个 parallel 可能产生多个 unknown，全部处理完毕才继续。

### 本地模型 Actions

### macOS 保持唤醒 Action

`macos-keep-awake` 在 macOS 后台管理 Aura 自己启动的 `/usr/bin/caffeinate -i`。输入 `operation: "start" | "stop" | "status"`；重复 start 复用已记录的进程，stop 只终止 PID 与可执行文件均核验为 `caffeinate` 的进程。状态写在工作区 `.aura/macos-keep-awake.json`，因此 Aura 重启后仍可查看和停止；进程不会阻止合盖、手动睡眠或低电量关机。其他平台调用会明确失败。

### Pi Action

`pi` 是通用的本机 Pi CLI 调用 Action，不绑定项目、角色、模型供应商或插件集合。默认只需要 `prompt`；Pi 入口按 `piPath`、`AURA_PI_BIN`、`PATH` 的顺序解析，JS 入口由当前 Node（或 `nodePath` / `AURA_PI_NODE_BIN`）执行。Action 沿用 Pi 自己的模型与认证配置，也可显式覆盖 `provider`、`model`、`thinking`、system prompt、工具集合、extensions 和 skills。`agentDirectory` / `AURA_PI_AGENT_DIR` 可为单次调用指定 `PI_CODING_AGENT_DIR`，但凭据内容不会进入 Action 入参、输出或日志。

默认使用 Pi 的全局资源发现，同时以 `--no-approve` 拒绝非交互的项目本地信任提示；`approveProject: true` 可显式信任项目配置，`isolated: true` 则关闭自动发现的 extensions、skills、prompt templates 和 themes，只加载入参提供的绝对路径。`contextFiles: false` 可关闭工作区 context files。`cwd` 可相对 Aura 工作区指定但不能越界；session 与输出默认保存到 `.aura/pi/sessions` 和 `.aura/pi/runs/<callId>`。Action 支持按 UUID 续接 session，返回最终文本、tool calls、Pi 状态、JSONL 日志、退出信息和 usage；取消或超时会终止 Pi 进程组，输出会遮蔽环境中的常见 secret/token/key 值。

### Flow / Action 定义

`FlowDiscovery` 在首次启动、运行开始前和后台短周期扫描时检查内置及已启用外部根的直接子目录。非法 ID、入口名不一致、缺少入口或多个 `*.flow.js` 都会作为不可用项进入 catalog。外部贡献使用 `<plugin-id>/<local-id>` 规范 ID，内置贡献保持原有 ID；DSH 工具名由后端映射为安全名称，持久化和公开接口始终保留规范 ID。

外部插件的 manifest、信任、能力声明和根目录由 `@aura/plugin-manager` 在进入编排宿主前校验，插件代码只通过 `@aura/plugin-sdk/action` 与 `@aura/plugin-sdk/flow` 接入。宿主不支持 manifest 请求的任一 capability 时插件整体保持不可用，不带着缺失能力部分加载。运行时可通过内部 `plugins/configure` RPC 动态替换多根发现器并扩展 HMR 监听；加载失败会恢复上一组根。源码直接交给模块加载器，不计算贡献目录或静态依赖闭包的哈希，动态 import 按 Node/DSH 的原生规则加载。旧记录里的可选 `sourceHash` 继续读取并保留，新记录不再生成该字段；恢复或续接使用当前已加载的代码，不比较源码哈希。插件身份、模型配置、调用请求指纹、输入和步骤幂等检查仍生效；未知结果和已完成副作用不因代码更新而重发。显式 compatibility 仍决定旧 ID 和 pre-plugin 身份能否保留；旧配置中的 from/to 哈希只作为兼容字段读取。运行中已开始的执行片段持有其模块引用；后续恢复可使用更新后的代码。Aura 不替插件执行安装、构建或生命周期脚本。

`contributes.backend` 通过原生递归文件事件观察插件源码；目录、入口和 backend 不做源码哈希或依赖树解析。通知变更后在后台扫描或显式替换时加载新模块，未变化的设置和源码不会反复打开后端。
宿主等待进行中的调用和该插件的活跃 Flow 结束后，准备新后端并切换版本；
加载失败保留上一版。版本标签沿插件自己的本地模块图传递，SDK 和已安装依赖保持共享，
不重新安装依赖、不写插件清单。资源与业务状态的回收仍由后端的 `close` 负责。

## API

RPC handshake 为 v4。所有 HTTP 写操作携带 UUID `requestId`；命令身份和状态变更在同一个 Run 记录中提交。重试相同命令不会再次执行副作用，返回该 Run 的当前状态；同 requestId 不得改目标或输入。路径中的 `stepKey` 必须 URL 编码，包括 `/`。

| 方法 | `/flows` 下路径                                          | 内容                                                                   |
| ---- | -------------------------------------------------------- | ---------------------------------------------------------------------- |
| GET  | `/catalog`、`/:flowId/source`                            | catalog 或只读源码                                                     |
| GET  | `/services`                                              | 已发布的 Flow 服务及其输入输出 Schema                                  |
| POST | `/:flowId/runs`                                          | 工作台入口：`{requestId,mode,input}`，202 返回 `{runId}`               |
| POST | `/:flowId/invoke`                                        | 服务入口：`{mode,input,requestId?}`，202 返回运行及状态链接            |
| GET  | `/runs`、`/runs/:id`                                     | 最近 100 次摘要或完整运行                                              |
| POST | `/runs/:id/pause`、`resume`、`cancel`                    | `{requestId}`                                                          |
| POST | `/runs/:id/steps/:stepKey/answer`                        | `{requestId,output}`                                                   |
| POST | `/runs/:id/steps/:stepKey/resolve`                       | `{requestId,action:"retry" \| "submit_output" \| "terminate",output?}` |
| GET  | `/runs/:id/steps/:stepKey/history?attempt=2&beforeSeq=…` | Agent attempt 历史；默认最新 attempt                                   |

对应 RPC 为 `start/get/list/pause/resume/cancel/answer/resolve/history/wait`。`wait` 和 `host.invokeFlow()` 等待当前执行片段进入 paused、waiting_input、needs_attention 或终态，并返回 Run；调用方必须检查 status。

`host.invokeAction()` 使用独立 `aura_code_actions` domain，仍保持重启后 active 标记 interrupted、不自动重放的行为，也不新增通用 Action HTTP 执行端点。

### 将 Flow 发布为 HTTP 服务

Flow 必须显式设置 `service: true` 才能通过服务入口调用。未设置的 Flow 仍可在 Aura 工作台运行和被其他 Flow 嵌套调用，但 `/invoke` 会返回 404。

```js
export default defineFlow({
  title: "XXX 服务",
  description: "供其他应用调用的工作流",
  service: true,
  input: z.object({ task: z.string().min(1) }),
  output: z.object({ report: z.string() }),
  async run(ctx, input) {
    return ctx.sequence({ id: "main" }, async (flow) => {
      const result = await flow.agent({
        id: "generate",
        label: "生成报告",
        preset: "researcher-v1",
        prompt: input.task,
      });
      return { report: result.output };
    });
  },
});
```

服务发现接口会返回已发布 Flow 的 `inputSchema`、`outputSchema` 和 `invokePath`。调用使用 durable 异步协议，HTTP 连接断开不会取消 Flow：

```bash
curl -i -X POST http://127.0.0.1:4311/flows/xxx/invoke \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 019d09d4-12bb-7a64-957d-e9765441bca8" \
  -d '{"mode":"codex","input":{"task":"生成报告"}}'
```

返回 202，并通过 `Location` 和响应体给出状态地址：

```json
{
  "runId": "…",
  "requestId": "019d09d4-12bb-7a64-957d-e9765441bca8",
  "status": "queued",
  "links": {
    "self": "/flows/runs/…",
    "cancel": "/flows/runs/…/cancel"
  }
}
```

调用方随后读取 `GET /flows/runs/:runId`。终态为 `completed` 时结果在 `output`；`waiting_input` 时根据步骤的 `outputSchema` 调用 `answer`；`needs_attention` 时调用 `resolve`。网络超时后应复用同一个 `Idempotency-Key`，Aura 会返回原 Run，输入或模式不同则返回 409。也可以在 JSON 请求体内传 `requestId`；若头和请求体同时存在，两者必须一致。

## DSH 可选集成

编排宿主持久化五个功能开关，并按需装载原生 DSH MCP 客户端、SenseVoice、团队工具和全文索引。MCP 配置保存的是后端环境变量引用。MCP 工具调用和团队模型调用共用对话能力的额外请求账本。市场浏览通过 DSH 市场索引的校验器读取公开目录。参见[对话能力](../../../docs/dsh-conversation-capabilities.md)。

## 实现与部署

`engine.ts` 为执行门面和命令提交；`scheduler.ts` 从 Run 表调度；`scopes.ts` 管理结构化调用；`execution.ts` 执行重放和 attempts；`recovery.ts` 协调中断状态；`sessions.ts` 适配 DSH Controller；`actions.ts` 复用 DSH ToolRuntime。没有另建 Agent 引擎或修改 DSH 依赖。

Flow/Action 是部署时安装的、拥有完整 Node.js 权限的受信任代码。HTTP 仅按已发现 ID 调用，不能上传代码或指定路径。仅支持单进程调度；服务仍是受信任局域网开发服务。凭据继续由 DSH 后端保存，不进入运行 DTO 或日志投影。

Discovery 对旧根 `ctx.agent/action` 和原生 Promise 并发给出行号诊断，Runtime 作用域兜底校验。内置示例、默认草稿和 AI 编写提示已采用结构化 API，旧脚本需迁移。Cordis HMR 跟踪入口和本地依赖，失败保留最后可用版本；监听路径使用 canonical realpath。

## 验证

执行 `pnpm --filter @aura/orchestration typecheck`、`pnpm --filter @aura/orchestration test`，再运行 `pnpm run check` 和 Web build。测试覆盖 FIFO、作用域、暂停、checkpoint、retry、未知结果、版本冲突和写盘故障；真实 DSH 测试使用临时目录及本地模拟模型，强制 SIGKILL 验证无工具 Agent 恢复、工具副作用隔离、历史读取和 HMR，不调用付费模型。

## 工作流产物预览

图片（PNG/JPEG/WebP）、MP4 视频和自包含 GLB 通过 `GeneratedArtifacts` 按 SHA-256 归档，图片限制 32 MiB / 4000 万像素，视频和模型限制 200 MiB。图片缩略图为最长 640×480 的 WebP；插件模型可提供已有海报，不为预览再次调用生成服务。含外部资源 URI 或无法解析的 GLB 仅允许下载。

`WorkflowArtifactIndex` 在同一受管目录的 `runs/` 保存版本化 sidecar，记录 run、step、attempt 和工具 call 的关联、补登记状态与后端恢复信息。文件路径仅留在后端索引；公开 DTO 不包含路径或上游 URL。原 Action 输出、JSON Schema、运行记录与重放指纹均保持原样。直接 Action 和 Agent 工具可在调用上下文内登记产物并立即展示。受信任 Action 可调用 `await ctx.artifacts?.register(path, { name, poster })`，该端口没有模型可调用的任意文件读取接口。

Runtime 挂载以下 Hono 路由；JSON-RPC 只解析关联与元数据，HTTP 进程从受管目录按文件描述符校验内容 hash 并流式发送：

- `GET /flows/runs/:runId/artifacts`：本运行及子运行的产物列表，`pending` 表示历史补登记尚在进行。`?retry=1` 重试本地补登记，不重跑生成。
- `GET|HEAD /flows/runs/:runId/artifacts/:artifactId/content`：原始文件，支持单段 Range、ETag、If-None-Match、If-Range；`?download=1` 强制下载。
- `GET|HEAD /flows/runs/:runId/artifacts/:artifactId/thumbnail`：图片缩略图或模型海报。

每次读取检查运行与产物归属；路径穿越、符号链接及内容变化均不能通过。历史迁移按运行持久化版本/指纹，可重启续跑；查看历史运行时优先处理。历史产物来自插件的候选投影和已登记 GLB。Agent 历史只解析结构化工具结果，不从自然语言提取路径。已删除或无结构化结果的历史日志不能恢复，缺失文件或未经来源验证的候选保留不可用状态。成功归档的文件默认保留，隐藏客户端会话不删除归档。

## 产品插件后端

插件 ESM 热更新以真实目录判断模块归属，避免 macOS 临时目录或目录别名经符号链接解析后漏掉 helper 的版本标记；本地 helper 随插件版本重新加载，SDK 继续共用宿主实例。源码写入完成与原生监听通知异步发生，下一次观察到变更的刷新才切换版本。加载时记录本地模块的 inode、大小及纳秒修改时间；收到通知后仅核对该文件的元数据，忽略未变化文件的延迟通知和同一次修改的重复通知，避免启动后重复打开后端，不扫描或读取整棵源码树。回归以有界状态等待验证文件原子替换、目录符号链接、已有调用和任务结束后的刷新，以及加载失败后继续提供旧版。

对话通过 DSH 原生 command/compaction、Web 与 subagents 服务接入增强能力；
`coding/capabilities` 管理用户开关和请求次数额度，`coding/compact` 执行手动压缩，
`coding/agents` 只读恢复子 Agent 目录。参见[对话能力](../../../docs/dsh-conversation-capabilities.md)。
