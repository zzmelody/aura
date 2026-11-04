# @aura/orchestration

DSH 依赖统一固定为 `0.2.1-rc.5`，Cordis 为 `4.0.5`，loader / include 分别固定为 `1.0.6` / `1.0.10`。本包的 Zod 与 DSH domain 层统一为 `4.4.3`，Schema 持久化校验在 Aura 侧适配。升级使用已发布包，保留现有 profile、会话 ID、domain 与存储格式，不执行用户配置或历史数据迁移。集成测试通过隔离目录和本地合成模型验证授权、执行、取消与恢复，不调用真实付费模型。

Aura 的编排子进程通过 DSH 的公开 `runProfile()` 启动 `aura-flow`。环境分层、profile 合并、Cordis 服务装配和退出清理由 DSH 处理。父子进程通过 stdio RPC 通信，启动异常通过 Aura 的脱敏诊断输出。

DSH 启动阶段耗时写入终端和 `.aura/dsh/logs/aura-host.log`，`event: "startup"` 的记录按 `startupId` 关联一次启动。`stage` 包括 profile 准备、进程创建、DSH 加载、插件 preset/backend 激活、各 domain 打开、工作空间、Action 恢复、Flow/Action 发现、Loader 等待、Flow 恢复和握手。`status` 为 started/completed/failed；`durationMs` 是本阶段耗时，`elapsedMs` 是从本次启动开始的累计耗时。total、handshake、dsh-load 和 orchestration-setup 包含子阶段，不能相加。启动失败会保留最后开始的阶段和已完成阶段；日志只接受固定阶段、UUID 与数值，不记录配置、凭据、原始错误或上游响应。

HMR 覆盖插件源码和 helper，并合并相同的 Flow/Action 监听根。DSH 的忽略匹配使用 POSIX glob，而 Windows `path.relative()` 返回反斜杠，因此生成的 profile 同时提供两种分隔符的忽略规则，避免为 `node_modules` 和隐藏目录注册大量文件监听。使用 DSH 0.2.1-alpha.2、Windows Electron 44.7.0、Node 24.21.0、相同的五个插件和独立空存储进行对照时，优化前启动 79.5 秒（DSH 加载 70.4 秒），优化后两次新进程启动分别为 13.3 秒与 22.4 秒。耗时受机器负载和文件缓存影响。

`personalAssistant(create = false)` 读取 Aura 专属主会话与其工作空间；只有显式传入 `true` 才在缺失时创建。索引对并发打开合并处理，固定身份为协议定义的 `coding-aura-personal-assistant`，沿用现有 domain 与 DSH 日志。再次打开不改写已有记录、不触发模型、不更换目录，重启后继续原上下文和模型配置。普通会话的关闭、归档和删除接口拒绝结束此主会话；普通任务保持独立。所属工作空间不可用时返回冲突，不自动重建或迁移用户数据。

`conversations(projectId, includeStatus = true)` 默认沿用历史状态投影；启动时传入 `false` 仅返回索引元数据和当前进程的运行、等待回答状态，不逐项读取 DSH 日志。`coding/conversation-list.ts` 拥有该投影，历史日志失败不隐藏会话，旧日志中尚未结束的回合仍在完整查询时投影为已停止；不改写任何索引或日志。

目录读取直接投影已加载的最后可用定义，不触发磁盘扫描；HTTP 目录提供 ETag / 304。发现保留 Cordis HMR，新增/移除的兜底扫描为 5 秒，并合并同一发现器上并发的扫描请求。发现只处理目录和入口增删，已挂载模块由 DSH HMR 更新；不扫描源码依赖、不计算源码哈希。

在线对话通过 `aura_flow_catalog` 读取所有可用 Flow 的公开输入 Schema，通过 `aura_run_flow` 调用相同的 durable 引擎，通过 `aura_flow_status` 读取原 Run 的当前输入与结果。明确的重复执行生成新 Run；同一工具 call ID 沿用原算法的稳定 requestId，保留旧执行的幂等身份。未知提交或读取结果阻止本轮自动重新启动，已接收运行的引用仍进入工具结果以便历史恢复。新运行可带可选 `conversationId`，在原 Run 格式中附加归属，列表同步返回，避免工作台重复导入为另一段会话；不迁移或重写旧记录。模型和执行仍经 DSH，停止聊天不会自动取消独立 Run。

启动与查询工具会向外层 Agent 返回有界的步骤诊断：步骤 ID、子 Run、已记录的失败原因、人工输入要求、当前 attempt 耗时和剩余退避时间。运行时已检测到状态存档失败时，即使最后落盘的状态仍显示 running，也会返回存储故障。诊断复用面向用户的错误，不读取原始模型响应或日志。启动工具只短暂等待，后续故障通过原 runId 查询。

`codingHistory(id, { page: true, beforeSeq?, throughSeq? })` 使用 DSH 的 message/turn 窗口和稳定日志截面返回完整回合与向前游标。默认调用仍支持完整历史投影；分页不改写 DSH 日志或用户配置，旁支过滤继承前缀，旧导入历史只在最早一页出现。

执行宿主尚未就绪时，分页历史优先走 `coding/cold-history.ts`：在当前进程组合已发布的 DSH JSONL 只读持久化服务与 domain 校验，直接读取已完成回合，不等待完整插件与 Flow 恢复，也不启动执行进程。索引仅在有界私有临时副本中打开（最多 2 MiB、512 个文件），旧布局的自动引导只作用于副本；原索引和日志不迁移、不写入。每次读取都重新检查当前索引权限，关闭的会话、已解除关联或父会话已归档的旁支仍不可读取；JSONL 只使用 `read` 句柄，保留 DSH 的版本、修订与断尾校验。响应只包含现有历史 DTO，不输出原始日志事件。

只读窗口每页最多十个完整回合，沿用原日志的 `beforeSeq` / `throughSeq`，可以与宿主就绪后的分页互接；继承前缀和最早一页的导入历史规则一致。未完成日志、索引过大、格式暂不可读等情况回退原宿主路径；存在非空的 home 级 `cordis.patch.yml` 时也回退，避免忽略用户对存储根或编码的覆盖。运行状态始终由执行宿主确认；已就绪的宿主继续提供包含内存状态的实时读取。HTTP 请求取消会传递到只读加载；该优化不预热、恢复或重发模型请求。`agent-failure.ts` 独立提供相同的安全错误投影，读取历史无需加载 Agent 执行适配器。

`src/` 根模块拥有执行引擎、恢复、注册和 DSH 集成；业务模块按 `content/`、`video/`、`topics/` 归拢，产物登记、历史绑定和 HTTP 交付在 `artifacts/`，模型进程适配在 `local-ai/`。各领域的 library、production 与 routes 分开，公共 package 子路径名称保持稳定。完整职责见 [模块边界](../../../docs/development/module-boundaries.md)。

Aura 的 durable workflow script 引擎。脚本负责控制流；Graph 是只读静态投影。恢复从 `run()` 入口重放，完成的关键调用返回存档结果。运行时不保存 JS 栈、闭包、Promise 或任意局部变量。

对话的 `skills(projectId)` RPC 通过 DSH skill registry 读取已注册工作空间的用户可调用技能，只返回名称与描述。文件系统 provider 与技能加载器沿用 DSH 组合，对话工具白名单允许 `skill` 并支持原生 `/name` 显式调用。Flow Agent 的工具白名单保持不变，DSH 按实际工具可见性发布技能目录。HTTP 边界为 `GET /coding/projects/:id/skills`，客户端不能提交任意扫描路径。

工作空间对话按 DSH 会话头中绑定的目录读取根级 `AGENTS.md`，并通过该 Agent 自身的 DSH 提示词作用域加载。旁支及同目录的会话子 Agent 沿用这一边界。读取限于 64 KiB 的 UTF-8 正文，文件缺失、不可访问或指向符号链接时跳过。跨工作空间分叉按目标会话目录重新装配规则。宿主级指令加载器保持禁用，Flow Agent 不参与此加载过程。

执行中的模型控制只保存当前会话的待发送选择；`steerCoding` 可附带 `modelConfig: { mode, selection }`，固定追加消息发送时的模型和思考强度。模型解析、图片校验通过后，引导与新选择一起交给 DSH Agent；DSH 的 `installModelSelection` 在后续步骤装配提示词时固定路由和思考强度，已经发出的请求保持原配置。不写入部署级默认模型。当前轮次内只允许切换同一模型服务的模型，跨服务切换需等本轮结束。无运行轮次返回 `steered: false`，校验失败不投递、不切换、不自动重试。

对话发送或引导中附带图片时，DSH 模型元数据若在接收消息前判定模型不支持图片，返回安全的 422 提示，要求用户更换支持图片的模型或移除附件后自行发送。该拒绝不启动模型回合，不自动丢弃图片、切换模型或重发请求。

追加指令还在校验时若本轮结束或停止，返回 `steered: false`。此时可通过历史接口的 `running` 字段确认服务是否已完成本轮收尾。

追加消息可携带客户端生成的 `requestId`。Agent 读取时，实时流和历史中的 `steer` 事件带回同一 ID，用于更新已显示的消息。

`POST /flows/assets/images` 在图片路由上执行 32 MiB 请求体限制，超出时返回图片大小错误。普通 Flow 请求的请求体上限为 256 KiB。

工作空间对话的 `openCodingSide(parentId)` 每次显式调用都创建独立旁支，`closeCodingSide(id)` 仅关闭指定旁支。多个旁支分别通过 DSH fork/resume 继承主对话并保存自己的上下文和模型设置；首条提问成为旁支列表标题。关闭或归档主对话会释放它的全部旁支。索引在原 `aura_coding_conversations` domain 中添加可选 `sideConversations` 元数据，保留原 ID、domain 版本和旧字段；单旁支历史只在读取时投影，不扫描、迁移或重写用户数据。DSH 日志保持原样。

旁支每轮使用专属系统规则，将主对话历史作为背景，并以旁支用户消息确定当前任务。用户可在旁支明确要求继续主对话的任务。新旁支首次 fork 后通过 DSH 关闭继承的计划模式，已建立的旁支恢复自身的计划状态。

## 编写 Flow

`coding/terminals/*` RPC 管理用户的工作区终端。`coding/terminals.ts` 仅使用已发布的 `ctx.subprocess.terminalEnvironment/resolveExecutable/spawnTerminal`，不复制 DSH、不创建 Agent，也不持有模型凭据。PTY 以已注册工作区的目录启动；客户端不能传入任意 cwd、可执行文件或环境变量。DSH 提供父环境凭据过滤和完整进程会话的终止。终端有独立身份、1 MiB 有界输出与分页游标，输入、尺寸、活动检查和关闭均指向该身份。重放会过滤已经回答过的终端查询，防止重连时将旧设备响应混入当前输入。关闭工作区终端或 runtime 时等待 DSH 完整清理进程后才移除终端。未指定 `force` 的 POSIX 终端在重新确认空闲并阻止新输入后，先通过公开 `signalForeground("SIGHUP")` 挂断 shell，避免交互式 shell 忽略 TERM 时固定等待 3 秒；挂断失败仍执行 DSH 的完整清理。启动中、忙碌、活动未知及 Windows 终端保留原有 3 秒退出宽限期，不提前升级终止。关闭仍忙碌或活动未知的终端先返回 409，只有用户确认后才强制关闭。终端仅在当前服务进程中存在，重启不恢复命令。

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

Flow Agent 使用 fail-closed 工具白名单：固定为原生工具呈现并屏蔽 DSH、preset 及 profile 的全部继承工具，只把 `flow.agent({actions:["text-stats"],...})` 显式声明的 Action 注册到当前 Agent scope；未声明时模型工具集合为空。profile 对已知内置工具的禁用继续作为纵深防护，未来新增的 DSH 默认工具也不会自动进入 Flow Agent 上下文。Action 名称冲突会拒绝。直接 Action、Agent 共用 Flow 并发门，Agent 内部工具使用 DSH 的并发安全和超时策略。全部内置和仓库插件的 Action 超时统一为 30 分钟，最大也为 30 分钟；取消、暂停和关闭需要代码遵守 `signal`，无法强制打断阻塞 JS。

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

`comfy-workflow` 支持由 Aura 调用 ComfyUI 自定义 API workflow：传 JSON 对象或本地文件、按节点覆盖入参、收集保存/预览产物和非文件输出。`local-image` / `local-video` 复用同一执行器作为默认模板；每次执行独立目录，取消和结束后回收受管服务及中间文件。完整参数和可运行示例见 [本地模型 Actions](docs/local-ai-actions.md#自定义-comfyui-workflow)。

`local-image`、`local-video`、`local-tts` 分别访问已部署的 Qwen-Image-2512、MiniMax H3 和 Qwen3-TTS，另有 `local-ai-service` 管理启停和状态。它们是可供未来 Flow / Agent 复用的独立 Action，不新增 Workflow。后端统一串行使用 GPU，生成结束、取消或失败后回收受管进程，单独启动有 60 秒空闲期限。配置、参数、调用示例及 Windows 异常退出资源所有权见 [本地模型 Actions](docs/local-ai-actions.md)。

### macOS 保持唤醒 Action

`macos-keep-awake` 在 macOS 后台管理 Aura 自己启动的 `/usr/bin/caffeinate -i`。输入 `operation: "start" | "stop" | "status"`；重复 start 复用已记录的进程，stop 只终止 PID 与可执行文件均核验为 `caffeinate` 的进程。状态写在工作区 `.aura/macos-keep-awake.json`，因此 Aura 重启后仍可查看和停止；进程不会阻止合盖、手动睡眠或低电量关机。其他平台调用会明确失败。

### Pi Action

`pi` 是通用的本机 Pi CLI 调用 Action，不绑定项目、角色、模型供应商或插件集合。默认只需要 `prompt`；Pi 入口按 `piPath`、`AURA_PI_BIN`、`PATH` 的顺序解析，JS 入口由当前 Node（或 `nodePath` / `AURA_PI_NODE_BIN`）执行。Action 沿用 Pi 自己的模型与认证配置，也可显式覆盖 `provider`、`model`、`thinking`、system prompt、工具集合、extensions 和 skills。`agentDirectory` / `AURA_PI_AGENT_DIR` 可为单次调用指定 `PI_CODING_AGENT_DIR`，但凭据内容不会进入 Action 入参、输出或日志。

默认使用 Pi 的全局资源发现，同时以 `--no-approve` 拒绝非交互的项目本地信任提示；`approveProject: true` 可显式信任项目配置，`isolated: true` 则关闭自动发现的 extensions、skills、prompt templates 和 themes，只加载入参提供的绝对路径。`contextFiles: false` 可关闭工作区 context files。`cwd` 可相对 Aura 工作区指定但不能越界；session 与输出默认保存到 `.aura/pi/sessions` 和 `.aura/pi/runs/<callId>`。Action 支持按 UUID 续接 session，返回最终文本、tool calls、Pi 状态、JSONL 日志、退出信息和 usage；取消或超时会终止 Pi 进程组，输出会遮蔽环境中的常见 secret/token/key 值。

### Flow / Action 定义

`FlowDiscovery` 在首次启动、运行开始前和后台短周期扫描时检查内置及已启用外部根的直接子目录。非法 ID、入口名不一致、缺少入口或多个 `*.flow.js` 都会作为不可用项进入 catalog。外部贡献使用 `<plugin-id>/<local-id>` 规范 ID，内置贡献保持原有 ID；DSH 工具名由后端映射为安全名称，持久化和公开接口始终保留规范 ID。

外部插件的 manifest、信任、能力声明和根目录由 `@aura/extensions` 在进入编排宿主前校验，插件代码只通过 `@aura/plugin-sdk/action` 与 `@aura/plugin-sdk/flow` 接入。宿主不支持 manifest 请求的任一 capability 时插件整体保持不可用，不带着缺失能力部分加载。运行时可通过内部 `plugins/configure` RPC 动态替换多根发现器并扩展 HMR 监听；加载失败会恢复上一组根。源码直接交给模块加载器，不计算贡献目录或静态依赖闭包的哈希，动态 import 按 Node/DSH 的原生规则加载。旧记录里的可选 `sourceHash` 继续读取并保留，新记录不再生成该字段；恢复或续接使用当前已加载的代码，不比较源码哈希。插件身份、模型配置、调用请求指纹、输入和步骤幂等检查仍生效；未知结果和已完成副作用不因代码更新而重发。显式 compatibility 仍决定旧 ID 和 pre-plugin 身份能否保留；旧配置中的 from/to 哈希只作为兼容字段读取。运行中已开始的执行片段持有其模块引用；后续恢复可使用更新后的代码。Aura 不替插件执行安装、构建或生命周期脚本。

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

图片（PNG/JPEG/WebP）、MP4 视频和自包含 GLB 通过 `GeneratedArtifacts` 按 SHA-256 归档，图片限制 32 MiB / 4000 万像素，视频和模型限制 200 MiB。图片缩略图为最长 640×480 的 WebP；Tripo 模型使用已有海报，不为预览再次调用生成服务。含外部资源 URI 或无法解析的 GLB 仅允许下载。

`WorkflowArtifactIndex` 在同一受管目录的 `runs/` 保存版本化 sidecar，记录 run、step、attempt 和工具 call 的关联、补登记状态与后端恢复信息。文件路径仅留在后端索引；公开 DTO 不包含路径或上游 URL。原 Action 输出、JSON Schema、运行记录与重放指纹均保持原样。`localAI.image`、`localAI.comfyWorkflow` 和 Tripo game-asset capability 在调用上下文内自动登记，因此直接 Action 和 Agent 工具都可在生成后立即展示文件。受信任 Action 也可调用 `await ctx.artifacts?.register(path, { name, poster })`，该端口没有模型可调用的任意文件读取接口。

Runtime 挂载以下 Hono 路由；JSON-RPC 只解析关联与元数据，HTTP 进程从受管目录按文件描述符校验内容 hash 并流式发送：

- `GET /flows/runs/:runId/artifacts`：本运行及子运行的产物列表，`pending` 表示历史补登记尚在进行。`?retry=1` 重试本地补登记，不重跑生成。
- `GET|HEAD /flows/runs/:runId/artifacts/:artifactId/content`：原始文件，支持单段 Range、ETag、If-None-Match、If-Range；`?download=1` 强制下载。
- `GET|HEAD /flows/runs/:runId/artifacts/:artifactId/thumbnail`：图片缩略图或模型海报。

每次读取检查运行与产物归属；路径穿越、符号链接及内容变化均不能通过。历史迁移按运行持久化版本/指纹，可重启续跑；查看历史运行时优先处理。仅接受已知 Comfy 输出目录、匹配 Tripo manifest/task 的产物以及已登记 GLB。Agent 历史只解析结构化工具结果，不从自然语言提取路径。已删除或无结构化结果的历史日志不能恢复，缺失文件或未经来源验证的候选保留不可用状态。成功归档的文件默认保留，隐藏客户端会话不删除归档。

## 产品插件后端

插件 ESM 热更新以真实目录判断模块归属，避免 macOS 临时目录或目录别名经符号链接解析后漏掉 helper 的版本标记；本地 helper 随插件版本重新加载，SDK 继续共用宿主实例。回归覆盖目录符号链接及已有任务结束后的刷新。

对话通过 DSH 原生 command/compaction、Web 与 subagents 服务接入增强能力；
`coding/capabilities` 管理用户开关和请求次数额度，`coding/compact` 执行手动压缩，
`coding/agents` 只读恢复子 Agent 目录。参见[对话能力](../../../docs/dsh-conversation-capabilities.md)。
