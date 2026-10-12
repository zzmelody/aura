import { createHash, randomUUID } from "node:crypto";
import { defineTool, type ToolDefinition } from "@deepseek-ai/dsh-tools";
import {
  DEFAULT_RESEARCH_REQUEST,
  type ResearchRequest,
} from "@aura/protocol/research";
import {
  VIDEO_VOICES,
  VIDEO_RESOLUTIONS,
  DEFAULT_VIDEO_RESOLUTION,
  type VideoScript,
  type VideoResolution,
} from "@aura/protocol/video";
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
  createVideo(
    name: string,
    script: VideoScript,
  ): Promise<{ id: string; revisionId: string }>;
  startVideo(
    id: string,
    revisionId: string,
    requestId: string,
  ): Promise<{ runId: string }>;
  startResearch(input: {
    requestId: string;
    request: ResearchRequest;
    mode: FlowMode;
  }): Promise<{ jobId: string; runId: string }>;
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

const summary = (run: FlowRun): JsonValue => {
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
 * The three chat-invocable workflows. Every tool starts at most one durable
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
          scope.started({
            flowId: started.flowId,
            title: started.title,
            runId: started.runId,
            inputPreview: preview(started.input),
          });
          return await settle(started.runId, signal);
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
        enum: [...VIDEO_VOICES],
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

  const video = compileTool({
    name: "aura_multi_shot_video",
    description:
      "运行 Aura「多镜头剧情视频」工作流：按镜头清单新建视频项目并生成整片。用户明确要求把一段故事做成视频时调用。每个镜头旁白不超过 36 字，最多 20 个镜头。",
    parameters: {
      resolution: {
        type: "string",
        enum: [...VIDEO_RESOLUTIONS],
        default: DEFAULT_VIDEO_RESOLUTION,
        description:
          "竖屏分辨率，默认 720p 高清；只有用户明确要求低分辨率快速预览时选 360p。",
      },
      name: {
        type: "string",
        required: true,
        description: "视频项目名称，1–120 字。",
      },
      shots: {
        type: "array",
        required: true,
        description: "按时间顺序排列的镜头。",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string", required: true },
            narration: {
              type: "string",
              required: true,
              description: "旁白，最多 36 字。",
            },
            visualPrompt: {
              type: "string",
              required: true,
              description: "画面与镜头运动提示词。",
            },
            speaker: { type: "string", enum: [...VIDEO_VOICES] },
          },
        },
      },
    },
    output,
    timeoutMs: waitMs + 15_000,
    execute: (
      args: {
        name: string;
        resolution?: VideoResolution;
        shots: Array<{
          title: string;
          narration: string;
          visualPrompt: string;
          speaker?: string;
        }>;
      },
      exec: { callId: string; signal: AbortSignal },
    ) =>
      once(exec.callId, exec.signal, async (requestId) => {
        if (!args.shots.length || args.shots.length > 20)
          throw new FlowError("视频需要 1–20 个镜头。");
        const resolution = args.resolution ?? DEFAULT_VIDEO_RESOLUTION;
        const script: VideoScript = {
          schemaVersion: 1,
          resolution,
          scenes: [
            {
              id: randomUUID(),
              title: args.name.slice(0, 120),
              shots: args.shots.map((shot) => ({
                id: randomUUID(),
                title: shot.title.slice(0, 120),
                narration: shot.narration,
                speaker: shot.speaker ?? "Vivian",
                visualPrompt: shot.visualPrompt,
                firstFrame: { kind: "none" },
                lastFrame: { kind: "none" },
              })),
            },
          ],
        };
        const project = await host.createVideo(args.name, script);
        const { runId } = await host.startVideo(
          project.id,
          project.revisionId,
          requestId,
        );
        return {
          runId,
          flowId: "multi-shot-video",
          title: "多镜头剧情视频",
          input: {
            name: args.name,
            shots: args.shots.length,
            resolution,
          },
        };
      }),
  });

  const research = compileTool({
    name: "aura_topic_research",
    description:
      "运行 Aura「跨平台选题发现」工作流：按研究方向检索公开来源并把选题存入选题库。需要联网模型（Codex）模式。用户明确要求找选题、做选题调研时调用。",
    parameters: {
      direction: {
        type: "string",
        required: true,
        description: "研究方向，一两句话。",
      },
      audience: { type: "string", description: "目标受众。" },
      days: {
        type: "integer",
        description: "回看天数，1–30，默认 7。",
      },
    },
    output,
    timeoutMs: waitMs + 15_000,
    execute: (
      args: { direction: string; audience?: string; days?: number },
      exec: { callId: string; signal: AbortSignal },
    ) =>
      once(exec.callId, exec.signal, async (requestId) => {
        const request: ResearchRequest = {
          ...DEFAULT_RESEARCH_REQUEST,
          direction: args.direction,
          ...(args.audience ? { audience: args.audience } : {}),
          ...(args.days ? { days: Math.min(30, Math.max(1, args.days)) } : {}),
        };
        const { runId } = await host.startResearch({
          requestId,
          request,
          mode: scope.mode,
        });
        return {
          runId,
          flowId: "topic-discovery",
          title: "跨平台选题发现",
          input: { direction: request.direction, days: request.days },
        };
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

  return [tts, image, video, research];
}
