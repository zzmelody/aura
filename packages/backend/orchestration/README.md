# @aura/orchestration

Aura 的代码 Flow 编排包。Flow 的发现、加载、执行、动态 agent step、持久化与 HTTP 边界都在后端；前端只读取 catalog、提交参数并渲染运行结果。

## 编写 Flow

Flow 固定放在本包的 `flow/` 目录中。该目录只允许一级 Flow 目录，目录名就是稳定 ID；入口必须严格命名为 `<flow-id>.flow.js`，一个目录只能有一个 `*.flow.js`：

```text
flow/
  research-report/
    research-report.flow.js
    prompts.js
    lib/
  code-review/
    code-review.flow.js
```

入口使用公开的 `@aura/orchestration/flow` 接口。包导出的声明文件会为 JavaScript Flow 提供 `checkJs` 校验和编辑器补全：

```js
import { defineFlow, z } from "@aura/orchestration/flow";

export default defineFlow({
  title: "多角度分析",
  description: "分析、审阅并汇总结果",
  input: z.object({ task: z.string().min(1) }),
  output: z.object({ report: z.string() }),
  concurrency: 2,
  agentTimeoutMs: 180_000,

  async run(ctx, input) {
    const [research, review] = await Promise.all([
      ctx.agent({
        id: "research",
        label: "方案分析",
        preset: "researcher-v1",
        prompt: `分析：${input.task}`,
      }),
      ctx.agent({
        id: "review",
        label: "风险审阅",
        preset: "reviewer-v1",
        prompt: `审阅：${input.task}`,
      }),
    ]);
    const coordinator = await ctx.agent({
      id: "coordinator",
      label: "最终报告",
      preset: "coordinator-v1",
      prompt: JSON.stringify({
        task: input.task,
        research: research.output,
        review: review.output,
      }),
    });
    return { report: coordinator.output };
  },
});
```

`ctx.agent()` 返回 `{ stepId, sessionId, output }`。每次调用都会创建一个有独立 preset 和 session 的动态 step；同一次运行不能重复 step ID。并行关系直接用 JavaScript 的 `Promise.all()`、循环和条件表达，真正进入 DSH 的并发由 `concurrency` 限制。Agent 错误会先持久化失败 step 再抛出，Flow 可以捕获并降级，也可以让整个运行失败。

`input` 和 `output` 先经过各自的 Zod schema，再检查是否为大小受限、可持久化的 JSON。取消通过 `ctx.signal` 传给 Flow，并同时取消活跃 DSH session。任意 Flow 代码或工具副作用都不会在 runtime 重启后自动重放。

Flow JS 是部署时安装的受信任后端代码，不是 DSH agent 工具沙箱中的脚本。它拥有完整 Node.js 文件、网络与环境变量权限；HTTP 只能按已发现的 Flow ID 调用，不能上传代码或指定任意磁盘路径。

## 发现与热加载

`FlowDiscovery` 在首次启动、catalog 读取、运行开始前和后台短周期扫描时检查 `flow/` 的直接子目录。非法 ID、入口名不一致、缺少入口或多个 `*.flow.js` 都会作为不可用项进入 catalog。

每个合法入口由 DSH 已有的 Cordis Loader 注册为独立插件。DSH Cordis HMR 跟踪入口及其本地 ESM 依赖图，因此修改入口、`prompts.js` 或嵌套的 `lib/*.js` 都会重载对应 Flow。新目录自动挂载，删除目录或入口会注销 Flow。

HMR 导入或应用失败时保留最后一个成功版本，并在 catalog 返回加载警告；修复后自动切换。开始运行时会固定当前定义函数和整个 Flow 目录的 SHA-256 内容 hash，热更新或删除不会取消已经开始的运行，只影响后续运行。

## DSH 复用边界

```text
HTTP / host.invokeFlow
          ↓
discovery → Cordis Loader/HMR → code Flow registry
                                  ↓ ctx.agent()
                        DSH Session Controller
                                  ↓
                  DSH session JSONL + storage domain
```

- `flow-api.ts`：`defineFlow`、Zod 与 JavaScript Flow 上下文类型。
- `discovery.ts` / `registry.ts`：目录约束、Loader entry、last-known-good 定义和内容 hash。
- `engine.ts`：代码 Flow 运行、动态 step、并发、取消、幂等与恢复。
- `sessions.ts`：DSH Session Controller 适配，复用 create/selectModel/prompt/cancel/follow/page。
- `plugin.ts`：DSH 插件组合、RPC 和新的 `aura_code_flows` storage domain。
- `profile.ts`：DSH profile、Cordis HMR、preset roots 和模型路由。
- `index.ts`：长驻 DSH 子进程、本地调用与 Hono HTTP 路由。

Aura 不复制 DSH agent、session、模型、工具、skill、MCP 或会话历史实现。每个 agent step 只保存它和 DSH session 的映射；历史仍从 DSH Controller 分页读取。用户 preset 位于 `.aura/dsh/.agent-presets/<preset-id>/`，由 DSH 原生 composition 和健康检查加载。

运行记录使用全新的 `aura_code_flows` domain，只保存 Flow 元数据、内容 hash、结构化 input/output、状态、动态 steps、preset、session ID、输出和安全错误。旧 JSON DAG 定义与旧运行记录不读取，也不会因此递归删除原 DSH session 日志。

## 调用

后端本地调用和 HTTP 调用进入同一执行、校验与持久化链路：

```ts
const run = await host.invokeFlow("research-report", {
  input: { task: "..." },
  mode: "codex",
  signal,
});
```

| 方法 | 路径                                                   | 作用                                                |
| ---- | ------------------------------------------------------ | --------------------------------------------------- |
| GET  | `/flows/catalog`                                       | Flow、JSON Schema、版本 hash、加载错误与 preset     |
| POST | `/flows/:flowId/runs`                                  | 提交 `{requestId, mode, input}`，202 返回 `{runId}` |
| GET  | `/flows/runs`                                          | 最近 100 次运行摘要                                 |
| GET  | `/flows/runs/:runId`                                   | 结构化 input/output 和动态 steps                    |
| POST | `/flows/runs/:runId/cancel`                            | 显式取消运行                                        |
| GET  | `/flows/runs/:runId/steps/:stepId/history?beforeSeq=…` | DSH 会话历史分页                                    |

历史接口只能访问该运行实际产生的 step ID，不接受任意 session ID。当前 Aura runtime 是受信任局域网开发服务，不应直接暴露到公网。

## 验证

```powershell
pnpm --filter @aura/orchestration typecheck
pnpm --filter @aura/orchestration test
pnpm run check
pnpm run build:web
```

真实 DSH/HMR 集成测试使用临时 Flow 目录、独立 DSH home 和本地模拟 provider，不读取个人凭据或调用付费模型。DSH 与原生 TypeScript 加载要求仓库规定的 Node.js 24 或更高版本。
