# @aura/orchestration

Aura 的 durable workflow script 引擎。脚本负责控制流；Graph 是只读静态投影。恢复从 `run()` 入口重放，完成的关键调用返回存档结果。运行时不保存 JS 栈、闭包、Promise 或任意局部变量。

## 编写 Flow

Flow 入口为 `flow/<flow-id>/<flow-id>.flow.js`，每个一级目录只允许一个同名入口；本地辅助模块可以嵌套。使用公开 `@aura/orchestration/flow` 导出获得 checkJs/编辑器类型推导。

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

| 调用                                                                                                         | 返回值 / 语义                                                                           |
| ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `agent({id,label,preset,prompt,actions?,retry?,model?,reasoningEffort?,maxTokens?,temperature?,timeoutMs?})` | `{stepId,sessionId,output:string,attempt,recovered}`；每个 attempt 使用独立 DSH session |
| `action({id,label?,action,input,retry?})`                                                                    | `{stepId,actionId,output,attempt,recovered}`                                            |
| `sequence({id}, callback)`                                                                                   | 串行子作用域，返回 callback 的结果                                                      |
| `parallel({id,branches:{name: callback}})`                                                                   | 每个具名分支是独立串行作用域，返回同键结果对象，等待所有分支结束后汇合                  |
| `memo({id,label?,schema,compute})`                                                                           | 保存 schema 校验后的 JSON 结果；完成后重放不会调用 compute                              |
| `checkpoint({id,label?,prompt,schema})`                                                                      | 持久化输入要求，等待人工答案，重放返回已校验的答案                                      |

所有作用域调用必须 `await` 或 `return`。串行作用域不能重叠调用；并发统一使用 `parallel`。同级 ID 唯一（1–64 个字母、数字、下划线或连字符，首字符为字母/数字）。步骤的 `stepKey` 为作用域路径加本地 ID，例如 `main/analysis/research/call`；返回的 `stepId` 就是这个完整 key，记录中的 `id` 仍为本地 ID。循环须用稳定业务键创建子作用域或步骤 ID。单 Run 最多 64 个 durable 步骤；并发调用数由 `concurrency` 控制（1–4，默认 2）。Graph 无法静态展开的动态分支会显示提示，实际路径见运行记录。

V1 不支持 parallel 分支内的 checkpoint。运行时暂停会退出作用域；即使脚本捕获了内部暂停异常，也不能继续发起关键调用或提交完成结果。

`memo` 可封装时间、随机数和只读计算，必须返回 JSON；在结果落盘前崩溃时允许重新计算。外部写副作用必须通过 Action。普通 JS 代码每次重放都会重新执行，必须保证它基于固定输入、已存档结果和相同代码走出一致路径。重放时同一步骤的请求指纹变化，或完成时存在未访问的历史步骤，都会以 `FLOW_REPLAY_MISMATCH` 中断。

输入、输出、memo 和人工答案使用不超过 256 KiB 的 JSON；Agent 输出为 1–80,000 字符。checkpoint/memo 的 Zod Schema 必须能转换为可存档和重新校验的 JSON Schema；依赖执行代码的 transforms、refine/superRefine、overwrite（包括 trim）等规则会在持久化前明确报错，避免恢复时丢失校验。

## 每个 Agent 的模型参数

参数优先级为 **步骤选项 > `defineFlow.agentDefaults` > 运行时默认值**；字段为 `undefined` 时继承。旧的 Flow 级 `agentTimeoutMs` 仍有效，但优先级低于 `agentDefaults.timeoutMs` 和步骤 `timeoutMs`。

```js
export default defineFlow({
  title: "分别配置 Agent",
  input: z.object({ task: z.string() }),
  output: z.object({ report: z.string() }),
  agentDefaults: { timeoutMs: 180_000 },
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
        timeoutMs: 240_000,
      });
      return { report: review.output };
    });
  },
});
```

| 参数              | 范围与默认行为                                                                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`           | 当前模式 provider 下的模型 ID，1–200 字符。Codex 默认 `AURA_CODEX_MODEL` 或 `gpt-5.6-terra`；Demo 默认 `deepseek-v4-flash`                                                            |
| `reasoningEffort` | DSH 对所选模型支持的准确档位；Codex 默认 `medium`，Demo profile 仅支持 `off`。不做静默降档或别名转换                                                                                  |
| `temperature`     | 0–2；不设置时交给供应商默认。透传到 DSH，请求是否接受该参数由具体模型决定                                                                                                             |
| `maxTokens`       | 1–1,000,000 的整数，具体模型还可能有更低限制。Demo 默认 4096。**当前锁定版本的 Codex 适配器不转发此字段，因此 Codex 模式显式设置会报 `AGENT_OPTION_UNSUPPORTED`，不承诺伪造的硬上限** |
| `timeoutMs`       | 1,000–600,000 的整数；默认 180,000。限制每次 Agent attempt 的总时长，不是整个 Run 或单次模型请求的时长                                                                                |

不开放脚本级 `provider`、API key、base URL 或任意 provider 参数；凭据和路由仍在后端 DSH profile 中管理。选择 `preset` 用于角色/工具环境，不能覆盖本次已固定的模型参数。模型配置的元数据校验在创建 Agent attempt 前执行；不支持的模型或思考档位给出明确错误，不自动换模型。

Run 入队前保存已合并的 `agentDefaults`，每个 Agent step 在调用前保存 `config` 并纳入 `requestHash`。重试、人工重试及重启都使用同一配置；即使环境默认模型变化，尚未访问的后续 Agent 也继承原 Run 默认值。脚本在重放中显式改变步骤参数会触发 `FLOW_REPLAY_MISMATCH`。底层供应商自身的模型实现和未设置的采样默认值不在 Aura 可冻结的范围内。

Graph 节点详情展示的是参数声明/表达式，不执行它们；展开运行步骤可以查看真正存档的 provider、模型、思考强度、温度、token 配置与超时。

升级前未存档 Agent 配置的未结束 Run，在恢复时标记 `agent_config_unrecoverable`，要求新建运行，不擅自套用新默认值；已完成历史保持可读，未保存的配置明确显示为旧记录。存储域版本仍为 1。

## Action 与重试

Action 入口为 `action/<action-id>/<action-id>.action.js`。Action 使用 DSH 原生工具 Schema DSL；`output.render` 给模型呈现结果，`execute` 返回结构化 JSON。

```js
import { defineAction } from "@aura/orchestration/action";

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
    return input.text.toUpperCase();
  },
});
```

Action `recovery` 默认为 `manual`。只有显式 `idempotent` 的直接 Action 才能自动重试。网络写操作需要把 `ctx.idempotencyKey` 交给支持去重的服务；编排器传递稳定 key，无法单独保证 exactly-once。

`retry` 配置在每次 `agent/action` 调用上：`maxAttempts` 默认 1、最大 10；`initialDelayMs` 默认 1000、`multiplier` 默认 2、`maxDelayMs` 默认 30000。预算包含第一次调用、失败尝试和崩溃中断的 attempt；退避截止时间被持久化。预算耗尽的失败可被脚本捕获并降级；重放遇到同一失败再次抛出保存的错误。整个 Run 进入 failed 后为终态，只能新建 Run。

`ctx` 还提供 `signal`、`cwd`、Action 目录 `directory`、每次工具调用的 `callId`、`mode`，以及调用方存在时的 `runId`、`stepId`、`sessionId`。直接 Flow Action 的 `idempotencyKey` 跨 attempt 和重启保持不变。Agent 内部 Action 调用由 DSH 记录和调度，不是单独的 Flow durable step；未完成 Agent 一旦调用过工具，就需人工处理，不能自动重跑整个 Agent。

外部插件可以通过 `@aura/plugin-sdk/action` 的 `auraCapability(ctx, id)` 使用 manifest 已声明且宿主支持的领域能力。能力实现由长驻宿主持有，Action 只收到固定操作及 JSON 结果，不接触凭据、任意 URL 或进程句柄。当前 `aura.veya.world-agent` 映射 Veya 的固定世界操作、运行观察/检查、探索动作/对话/重生和 `veya.cooker.capabilities/submit/status/cancel`，从平台默认 Godot `user://world-agent-session.json` 读取连接描述符；描述符声明 `veya-agent-tools/1` 时调用原生 `/agent/v1/call`，旧服务仅对已有世界操作回退到对应 `/v2` 路径，运行态、截图与 Cooker 工具不回退。可用后端环境变量 `AURA_VEYA_WORLD_AGENT_SESSION` 覆盖绝对路径。描述符与 bearer token 不进入 Action 入参、输出或运行记录。

默认不向 Agent 暴露 Action；用 `flow.agent({actions:["text-stats"],...})` 显式授予，名称冲突会拒绝。直接 Action、Agent 共用 Flow 并发门，Agent 内部工具使用 DSH 的并发安全和超时策略。Action 超时默认 30 秒、最大 10 分钟；取消、暂停和关闭需要代码遵守 `signal`，无法强制打断阻塞 JS。

## 队列、恢复与人工处理

Run 创建时先写入持久化 FIFO，最多同时执行两个 Run。queued、running、pausing 属于活动执行；paused、waiting_input、needs_attention 释放运行槽。进程关闭保留 active durable 状态，下次启动协调；用户显式取消才进入 cancelled。

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

`comfy-workflow` 支持由 Aura 调用 ComfyUI 自定义 API workflow：传 JSON 对象或本地文件、按节点覆盖入参、收集保存/预览产物和非文件输出。`local-image` / `local-video` 复用同一执行器作为默认模板；每次执行独立目录，取消和结束后回收受管服务及中间文件。完整参数和可运行示例见 [本地模型 Actions](docs/local-ai-actions.md#自定义-comfyui-workflow)。

`local-image`、`local-video`、`local-tts` 分别访问已部署的 Qwen-Image-2512、MiniMax H3 和 Qwen3-TTS，另有 `local-ai-service` 管理启停和状态。它们是可供未来 Flow / Agent 复用的独立 Action，不新增 Workflow。后端统一串行使用 GPU，生成结束、取消或失败后回收受管进程，单独启动有 60 秒空闲期限。配置、参数、调用示例及 Windows 异常退出资源所有权见 [本地模型 Actions](docs/local-ai-actions.md)。

### macOS 保持唤醒 Action

`macos-keep-awake` 在 macOS 后台管理 Aura 自己启动的 `/usr/bin/caffeinate -i`。输入 `operation: "start" | "stop" | "status"`；重复 start 复用已记录的进程，stop 只终止 PID 与可执行文件均核验为 `caffeinate` 的进程。状态写在工作区 `.aura/macos-keep-awake.json`，因此 Aura 重启后仍可查看和停止；进程不会阻止合盖、手动睡眠或低电量关机。其他平台调用会明确失败。

### Flow / Action 定义

`FlowDiscovery` 在首次启动、catalog 读取、运行开始前和后台短周期扫描时检查内置及已启用外部根的直接子目录。非法 ID、入口名不一致、缺少入口或多个 `*.flow.js` 都会作为不可用项进入 catalog。外部贡献使用 `<plugin-id>/<local-id>` 规范 ID，内置贡献保持原有 ID；DSH 工具名由后端映射为安全名称，持久化和公开接口始终保留规范 ID。

外部插件的 manifest、信任、能力声明和根目录由 `@aura/extensions` 在进入编排宿主前校验，插件代码只通过 `@aura/plugin-sdk/action` 与 `@aura/plugin-sdk/flow` 接入。宿主不支持 manifest 请求的任一 capability 时插件整体保持不可用，不带着缺失能力部分加载。运行时可通过内部 `plugins/configure` RPC 动态替换多根发现器并扩展 HMR 监听；加载失败会恢复上一组根。插件版本和贡献目录 hash 会随定义固定到运行记录，因此目录启停与插件内容 HMR 只影响新运行，已创建运行继续使用固定版本。Aura 不替插件执行安装、构建或生命周期脚本。

## API

RPC handshake 为 v4。所有 HTTP 写操作携带 UUID `requestId`；命令身份和状态变更在同一个 Run 记录中提交。重试相同命令不会再次执行副作用，返回该 Run 的当前状态；同 requestId 不得改目标或输入。路径中的 `stepKey` 必须 URL 编码，包括 `/`。

| 方法 | `/flows` 下路径                                          | 内容                                         |
| ---- | -------------------------------------------------------- | -------------------------------------------- |
| GET  | `/catalog`、`/:flowId/source`                            | catalog 或只读源码                           |
| POST | `/:flowId/runs`                                          | `{requestId,mode,input}`，202 返回 `{runId}` |
| GET  | `/runs`、`/runs/:id`                                     | 最近 100 次摘要或完整运行                    |
| POST | `/runs/:id/pause`、`resume`、`cancel`                    | `{requestId}`                                |
| POST | `/runs/:id/steps/:stepKey/answer`                        | `{requestId,output}`                         |
| POST | `/runs/:id/steps/:stepKey/resolve`                       | `{requestId,action:"retry"                   | "submit_output" | "terminate",output?}` |
| GET  | `/runs/:id/steps/:stepKey/history?attempt=2&beforeSeq=…` | Agent attempt 历史；默认最新 attempt         |

对应 RPC 为 `start/get/list/pause/resume/cancel/answer/resolve/history/wait`。`wait` 和 `host.invokeFlow()` 等待当前执行片段进入 paused、waiting_input、needs_attention 或终态，并返回 Run；调用方必须检查 status。

`host.invokeAction()` 使用独立 `aura_code_actions` domain，仍保持重启后 active 标记 interrupted、不自动重放的行为，也不新增通用 Action HTTP 执行端点。

## 实现与部署

`engine.ts` 为执行门面和命令提交；`scheduler.ts` 从 Run 表调度；`scopes.ts` 管理结构化调用；`execution.ts` 执行重放和 attempts；`recovery.ts` 协调中断状态；`sessions.ts` 适配 DSH Controller；`actions.ts` 复用 DSH ToolRuntime。没有另建 Agent 引擎或修改 DSH 依赖。

Flow/Action 是部署时安装的、拥有完整 Node.js 权限的受信任代码。HTTP 仅按已发现 ID 调用，不能上传代码或指定路径。仅支持单进程调度；服务仍是受信任局域网开发服务。凭据继续由 DSH 后端保存，不进入运行 DTO 或日志投影。

Discovery 对旧根 `ctx.agent/action` 和原生 Promise 并发给出行号诊断，Runtime 作用域兜底校验。内置示例、默认草稿和 AI 编写提示已采用结构化 API，旧脚本需迁移。Cordis HMR 跟踪入口和本地依赖，失败保留最后可用版本；监听路径使用 canonical realpath。

## 验证

执行 `pnpm --filter @aura/orchestration typecheck`、`pnpm --filter @aura/orchestration test`，再运行 `pnpm run check` 和 Web build。测试覆盖 FIFO、作用域、暂停、checkpoint、retry、未知结果、版本冲突和写盘故障；真实 DSH 测试使用临时目录及本地模拟模型，强制 SIGKILL 验证无工具 Agent 恢复、工具副作用隔离、历史读取和 HMR，不调用付费模型。
