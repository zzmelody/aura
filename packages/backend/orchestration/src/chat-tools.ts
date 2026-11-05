import { createHash } from "node:crypto";
import { defineTool, type ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { PluginTaskTool } from "./backend-api.ts";
import type {
  ChatWorkflowStart,
  FlowCatalog,
  FlowMode,
  FlowRun,
  FlowStep,
  JsonValue,
} from "@aura/protocol/types";
import { executable } from "./durable.ts";
import { FlowError } from "./schema.ts";

/** The narrow backend surface chat tools may touch; no Agent or session APIs. */
export interface ChatToolHost {
  start(input: {
    requestId: string;
    flowId: string;
    input: unknown;
    mode: FlowMode;
    conversationId?: string;
  }): Promise<FlowRun>;
  get(id: string): FlowRun;
  storageIssue?(id: string): string | undefined;
  catalog?(): Promise<FlowCatalog>;
  associateConversation?(runId: string, conversationId: string): Promise<void>;
  taskTools?(): readonly PluginTaskTool[];
}

export interface ChatToolScope {
  mode: FlowMode;
  sessionId?: string;
  signal: AbortSignal;
  /** Called once per accepted run so the client can attach a run card. */
  started(run: ChatWorkflowStart): void;
  /** Settled-wait budget before a tool answers with "still running". */
  waitMs?: number;
  /** Starts admitted in this chat turn; shared by every tool. */
  maxStarts?: number;
}

/** DSH call IDs are opaque; derive a stable RFC 4122 v4-shaped request ID. */
export function requestIdFor(callId: string): string {
  const hex = createHash("sha256").update(`aura-chat:${callId}`).digest("hex");
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const preview = (value: unknown) => {
  const text = JSON.stringify(value);
  return text.length > 140 ? `${text.slice(0, 137)}…` : text;
};

const runNotes: Partial<Record<FlowRun["status"], string>> = {
  queued: "运行正在排队，请查询同一 runId，不要重复启动。",
  running: "运行尚未结束。请根据步骤进度判断当前在等什么，并查询同一 runId。",
  pausing: "正在等待已开始的步骤收尾，随后进入暂停。",
  paused: "运行已暂停，需要在运行详情中继续。",
  waiting_input: "流程正在等待人工输入，请在运行详情中回答后继续。",
  needs_attention: "步骤结果未确认，请在运行详情核对结果后处理。",
};

/** Project public Run data only; never fetch raw provider responses or logs. */
function stepDiagnostics(
  root: FlowRun,
  host: ChatToolHost,
  now: number,
): JsonValue[] {
  const limit = 12;
  const details: JsonValue[] = [];
  const seen = new Set([root.id]);
  function visit(run: FlowRun) {
    const relevant = (step: FlowStep) =>
      step.status !== "completed" &&
      (step.status !== "failed" ||
        run.status === "failed" ||
        run.status === "interrupted");
    const steps = run.steps.filter(relevant);
    // Show the reason for a stop before ordinary queued work in parallel branches.
    const blocking = steps.filter(
      (step) => step.status !== "queued" && step.status !== "running",
    );
    const active = steps.filter(
      (step) => step.status === "queued" || step.status === "running",
    );
    for (const step of [...blocking, ...active]) {
      if (details.length >= limit) break;
      const attempt = step.attempts?.at(-1);
      const reason = step.error ?? attempt?.error;
      const stepKey = step.stepKey ?? step.id;
      const childRunId = step.kind === "flow" ? step.childRunId : undefined;
      const detail: Record<string, JsonValue> = {
        runId: run.id,
        stepKey,
        label: step.label.slice(0, 160),
        kind: step.kind ?? "agent",
        status: step.status,
        ...(reason ? { error: reason.slice(0, 500) } : {}),
        ...(attempt ? { attempt: attempt.number } : {}),
        ...(step.nextAttemptAt !== undefined
          ? { retryInMs: Math.max(0, step.nextAttemptAt - now) }
          : {}),
        ...(step.status === "running" && step.startedAt !== undefined
          ? {
              elapsedMs: Math.max(
                0,
                now - (attempt?.startedAt ?? step.startedAt),
              ),
            }
          : {}),
        ...(step.kind === "action" ? { actionId: step.actionId } : {}),
        ...(step.kind === "checkpoint" && step.status === "waiting_input"
          ? { prompt: step.prompt.slice(0, 500) }
          : {}),
        ...(childRunId ? { childRunId } : {}),
      };
      details.push(detail);
      if (!childRunId || seen.has(childRunId) || details.length >= limit)
        continue;
      seen.add(childRunId);
      let child: FlowRun;
      try {
        child = host.get(childRunId);
      } catch (error) {
        if (!(error instanceof FlowError) || error.status !== 404) throw error;
        detail.childStatus = "unavailable";
        continue;
      }
      if (child.parent?.runId !== run.id || child.parent.stepKey !== stepKey)
        continue;
      detail.childStatus = child.status;
      const childError = host.storageIssue?.(child.id) ?? child.error;
      if (childError) detail.childError = childError.slice(0, 500);
      visit(child);
    }
  }
  visit(root);
  return details;
}

function summary(run: FlowRun, host: ChatToolHost): Record<string, JsonValue> {
  const output =
    run.output === undefined ? undefined : JSON.stringify(run.output);
  const storageIssue = host.storageIssue?.(run.id);
  const note = storageIssue ? undefined : runNotes[run.status];
  const error = storageIssue ?? run.error;
  const now = Date.now();
  const steps =
    run.status === "completed" ? [] : stepDiagnostics(run, host, now);
  return {
    status: run.status,
    runId: run.id,
    ...(note ? { note } : {}),
    ...(error ? { error: error.slice(0, 500) } : {}),
    ...(steps.length ? { steps } : {}),
    ...(run.status === "queued"
      ? { queuedMs: Math.max(0, now - (run.queuedAt ?? run.createdAt)) }
      : {}),
    ...(output
      ? {
          output:
            output.length > 12_000 ? `${output.slice(0, 11_997)}…` : output,
        }
      : {}),
  };
}

const compileTool = defineTool as unknown as (
  options: unknown,
) => ToolDefinition;

/**
 * Turn-scoped workflow tools. Every tool starts at most one durable
 * run per model call ID, waits briefly, then hands progress to the run card.
 */
export function chatTools(host: ChatToolHost, scope: ChatToolScope) {
  const results = new Map<string, Promise<JsonValue>>();
  let starts = 0;
  let uncertainStart = false;
  const waitMs = scope.waitMs ?? 15_000;
  const maxStarts = scope.maxStarts ?? 2;

  async function settle(runId: string, signal: AbortSignal) {
    const deadline = Date.now() + waitMs;
    let run = host.get(runId);
    while (
      executable(run.status) &&
      Date.now() < deadline &&
      !signal.aborted &&
      !host.storageIssue?.(runId)
    ) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      run = host.get(runId);
    }
    return summary(run, host);
  }

  /** Same call ID returns the same answer; failures go back to the model as data. */
  function once(
    callId: string,
    signal: AbortSignal,
    task: (requestId: string) => Promise<{
      runId: string;
      flowId: string;
      title: string;
      input: unknown;
    }>,
  ) {
    let result = results.get(callId);
    if (!result) {
      result = (async (): Promise<JsonValue> => {
        if (uncertainStart)
          return {
            status: "unknown",
            error:
              "上次提交结果尚未确认，本轮不能再次启动工作流。请先检查已有运行。",
          };
        if (starts >= maxStarts)
          return {
            status: "rejected",
            error: `本轮对话最多启动 ${maxStarts} 个工作流，请等当前运行结束后再请求。`,
          };
        starts++;
        let accepted = false;
        let workflow: ChatWorkflowStart | undefined;
        try {
          scope.signal.throwIfAborted();
          signal.throwIfAborted();
          const started = await task(requestIdFor(callId));
          accepted = true;
          workflow = {
            flowId: started.flowId,
            title: started.title,
            runId: started.runId,
            inputPreview: preview(started.input),
          };
          scope.started(workflow);
          if (scope.sessionId)
            await host.associateConversation?.(started.runId, scope.sessionId);
          return {
            ...(await settle(started.runId, signal)),
            workflow: { ...workflow },
          };
        } catch (error) {
          const rejected =
            !accepted &&
            error instanceof FlowError &&
            error.status >= 400 &&
            error.status < 500;
          if (rejected) starts--;
          else uncertainStart = true;
          return {
            status: rejected ? "rejected" : "unknown",
            requestId: requestIdFor(callId),
            ...(workflow
              ? { workflow: { ...workflow }, runId: workflow.runId }
              : {}),
            error:
              error instanceof FlowError
                ? error.message.slice(0, 500)
                : "工作流提交或结果读取尚未确认，请检查已有运行，不要重新启动。",
          };
        }
      })();
      results.set(callId, result);
    }
    return result;
  }

  const output = {
    schema: { type: "json" },
    render: (_args: unknown, value: JsonValue) => [
      { type: "text", text: JSON.stringify(value) },
    ],
  };

  const catalog = compileTool({
    name: "aura_flow_catalog",
    description:
      "查看 Aura 可运行的工作流及其输入 Schema。在用户要求完成工作、选择或运行工作流时查询，按 Schema 准备参数，不猜测工作流 ID。",
    parameters: {},
    output,
    execute: async () =>
      (await host.catalog?.())?.flows
        .filter((flow) => flow.available)
        .map((flow) => ({
          id: flow.id,
          title: flow.title,
          description: flow.description,
          ...(flow.inputSchema ? { inputSchema: flow.inputSchema } : {}),
        })) ?? [],
  });
  const run = compileTool({
    name: "aura_run_flow",
    description:
      "在当前对话中运行任意已发现的 Aura 工作流。仅在用户要求执行时启动；先从目录确认 ID 和输入 Schema。向用户说明返回的失败或等待步骤、具体原因及 runId。查看后续状态时使用 aura_flow_status；只有用户明确要求再次运行才创建新运行。",
    parameters: {
      flowId: { type: "string", required: true },
      input: { type: "json", required: true },
      mode: {
        type: "string",
        enum: ["demo", "codex", "lumina", "custom"],
        description: "用户选择的运行模式；未指定时沿用当前对话模式。",
      },
    },
    output,
    timeoutMs: waitMs + 15_000,
    execute: (
      args: { flowId: string; input: JsonValue; mode?: FlowMode },
      exec: { callId: string; signal: AbortSignal },
    ) =>
      once(exec.callId, exec.signal, async (requestId) => {
        const started = await host.start({
          requestId,
          flowId: args.flowId,
          input: args.input,
          mode: args.mode ?? scope.mode,
          ...(scope.sessionId ? { conversationId: scope.sessionId } : {}),
        });
        return {
          runId: started.id,
          flowId: started.flow.id,
          title: started.flow.title,
          input: started.input,
        };
      }),
  });
  const status = compileTool({
    name: "aura_flow_status",
    description:
      "读取既有工作流运行的状态、输入、输出和步骤诊断。用户询问失败、中断或卡住时，说明具体步骤、原因、是否在等待输入或重试，以及 runId。运行耗时本身不代表卡死。此工具不会启动或重试工作流。",
    parameters: { runId: { type: "string", required: true } },
    output,
    execute: async (args: { runId: string }) => {
      const current = host.get(args.runId);
      return { ...summary(current, host), input: current.input };
    },
  });

  const names = new Set([
    "aura_flow_catalog",
    "aura_run_flow",
    "aura_flow_status",
  ]);
  const plugins = (host.taskTools?.() ?? []).map((tool) => {
    if (names.has(tool.name))
      throw new FlowError("Chat tool name already owned.", 409);
    names.add(tool.name);
    return compileTool({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      output,
      timeoutMs: waitMs + 15_000,
      execute: (
        args: Record<string, unknown>,
        exec: { callId: string; signal: AbortSignal },
      ) =>
        once(exec.callId, exec.signal, (requestId) =>
          tool.start(args, {
            requestId,
            mode: scope.mode,
            signal: exec.signal,
          }),
        ),
    });
  });
  return [catalog, run, status, ...plugins];
}
