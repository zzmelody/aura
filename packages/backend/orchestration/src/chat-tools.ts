import { createHash } from "node:crypto";
import { defineTool, type ToolDefinition } from "@deepseek-ai/dsh-tools";
import { TTS_VOICES } from "./local-ai/api.ts";
import type { PluginTaskTool } from "./backend-api.ts";
import type {
  ChatWorkflowStart,
  FlowCatalog,
  FlowMode,
  FlowRun,
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

const summary = (run: FlowRun): Record<string, JsonValue> => {
  const output =
    run.output === undefined ? undefined : JSON.stringify(run.output);
  return {
    status: run.status,
    runId: run.id,
    ...(executable(run.status)
      ? { note: "工作流仍在运行，请查询此 runId 的状态，不要重复启动。" }
      : {}),
    ...(run.error ? { error: run.error.slice(0, 500) } : {}),
    ...(output
      ? {
          output:
            output.length > 12_000 ? `${output.slice(0, 11_997)}…` : output,
        }
      : {}),
  };
};

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
    while (executable(run.status) && Date.now() < deadline && !signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      run = host.get(runId);
    }
    return summary(run);
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

  const tts = compileTool({
    name: "aura_tts",
    description:
      "运行 Aura「语音合成」工作流：把一段文字合成为 WAV 配音。用户明确要求朗读、配音或生成语音时调用。",
    parameters: {
      text: {
        type: "string",
        required: true,
        description: "要朗读的文字，1–2000 字。",
      },
      speaker: {
        type: "string",
        enum: [...TTS_VOICES],
        default: "Vivian",
        description: "预设音色。",
      },
      language: {
        type: "string",
        enum: ["Auto", "Chinese", "English", "Japanese", "Korean"],
        default: "Auto",
      },
    },
    output,
    timeoutMs: waitMs + 15_000,
    execute: (
      args: { text: string; speaker?: string; language?: string },
      exec: { callId: string; signal: AbortSignal },
    ) =>
      once(exec.callId, exec.signal, async (requestId) => {
        const input = {
          text: args.text,
          speaker: args.speaker ?? "Vivian",
          language: args.language ?? "Auto",
        };
        const run = await host.start({
          requestId,
          flowId: "tts",
          input,
          mode: scope.mode,
          ...(scope.sessionId ? { conversationId: scope.sessionId } : {}),
        });
        return { runId: run.id, flowId: "tts", title: run.flow.title, input };
      }),
  });

  const image = compileTool({
    name: "aura_image",
    description:
      "运行 Aura「图片生成」工作流：用本机图片模型按提示词生成一张图片。用户明确要求画图、生成图片、出一张图时调用。提示词写清主体、场景、风格与构图。",
    parameters: {
      prompt: {
        type: "string",
        required: true,
        description: "画面描述，1–2000 字。",
      },
      aspect: {
        type: "string",
        enum: ["square", "portrait", "landscape"],
        default: "square",
        description: "画幅：方图、竖图或横图。",
      },
      negative: { type: "string", description: "不希望出现的内容。" },
    },
    output,
    timeoutMs: waitMs + 15_000,
    execute: (
      args: { prompt: string; aspect?: string; negative?: string },
      exec: { callId: string; signal: AbortSignal },
    ) =>
      once(exec.callId, exec.signal, async (requestId) => {
        const input = {
          prompt: args.prompt,
          aspect: args.aspect ?? "square",
          ...(args.negative ? { negative: args.negative } : {}),
        };
        const run = await host.start({
          requestId,
          flowId: "image",
          input,
          mode: scope.mode,
          ...(scope.sessionId ? { conversationId: scope.sessionId } : {}),
        });
        return { runId: run.id, flowId: "image", title: run.flow.title, input };
      }),
  });

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
      "在当前对话中运行任意已发现的 Aura 工作流。仅在用户要求执行时启动；先从目录确认 ID 和输入 Schema。查看结果或继续讨论时使用 aura_flow_status；只有用户明确要求再次运行才创建新运行。",
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
      "读取既有工作流运行的当前状态、输入和输出。继续讨论结果或等待完成时使用，不会启动或重试工作流。",
    parameters: { runId: { type: "string", required: true } },
    output,
    execute: async (args: { runId: string }) => {
      const current = host.get(args.runId);
      return { ...summary(current), input: current.input };
    },
  });

  const names = new Set([
    "aura_tts",
    "aura_image",
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
  return [tts, image, catalog, run, status, ...plugins];
}
