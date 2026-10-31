import { createHash } from "node:crypto";
import { defineTool, type ToolDefinition } from "@deepseek-ai/dsh-tools";
import { TTS_VOICES } from "./local-ai/api.ts";
import type { PluginTaskTool } from "./backend-api.ts";
import type {
  ChatWorkflowStart,
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
  }): Promise<FlowRun>;
  get(id: string): FlowRun;
  taskTools?(): readonly PluginTaskTool[];
}

export interface ChatToolScope {
  mode: FlowMode;
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
  if (executable(run.status))
    return {
      status: run.status,
      runId: run.id,
      note: "工作流已开始运行，进度会显示在用户的运行卡片中；不要重复启动。",
    };
  const output =
    run.output === undefined ? undefined : JSON.stringify(run.output);
  return {
    status: run.status,
    runId: run.id,
    ...(run.error ? { error: run.error.slice(0, 500) } : {}),
    ...(output
      ? {
          output: output.length > 1_500 ? `${output.slice(0, 1_497)}…` : output,
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
        if (starts >= maxStarts)
          return {
            status: "rejected",
            error: `本轮对话最多启动 ${maxStarts} 个工作流，请等当前运行结束后再请求。`,
          };
        starts++;
        try {
          const started = await task(requestIdFor(callId));
          const workflow = {
            flowId: started.flowId,
            title: started.title,
            runId: started.runId,
            inputPreview: preview(started.input),
          };
          scope.started(workflow);
          return { ...(await settle(started.runId, signal)), workflow };
        } catch (error) {
          starts--;
          return {
            status: "rejected",
            error:
              error instanceof FlowError || error instanceof Error
                ? error.message.slice(0, 500)
                : "工作流启动失败。",
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
        });
        return { runId: run.id, flowId: "image", title: run.flow.title, input };
      }),
  });

  const names = new Set(["aura_tts", "aura_image"]);
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
  return [tts, image, ...plugins];
}
