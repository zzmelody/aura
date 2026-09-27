import type { ActionContext } from "../action-api.ts";
import type { JsonValue } from "@aura/protocol/types";

export type LocalAIServiceId = "qwen-image" | "minimax-h3" | "qwen3-tts";
export interface MediaResult {
  service: LocalAIServiceId;
  files: string[];
  seed: number;
  imageAssetId?: string;
}
export type ComfyServiceId = "qwen-image" | "minimax-h3";
export interface ComfyWorkflowInput {
  service: ComfyServiceId;
  /** ComfyUI API graph, or { prompt: graph }; mutually exclusive with workflowFile. */
  workflow?: Record<string, unknown>;
  /** Absolute path, or relative to the Aura backend workspace. Read afresh per invocation. */
  workflowFile?: string;
  /** Node ID -> existing input names and replacement JSON values. */
  overrides?: Record<string, Record<string, JsonValue>>;
  /** Bind managed images to existing LoadImage nodes; no filesystem paths cross this boundary. */
  imageBindings?: Array<{
    nodeId: string;
    assetId: string;
    resize?: { width: number; height: number };
  }>;
  /** Filter returned UI outputs, not which nodes execute. Omit to return all outputs. */
  outputNodeIds?: string[];
}
export interface ComfyWorkflowResult {
  service: ComfyServiceId;
  promptId: string;
  workflowHash: string;
  files: string[];
  /** ComfyUI UI outputs; saved file descriptors additionally contain a local path. */
  outputs: Record<string, JsonValue>;
}
export interface ServiceStatus {
  service: LocalAIServiceId;
  state: "stopped" | "running" | "external";
  url: string;
  managed: boolean;
  idleTimeoutMs: number;
}
export interface ImageInput {
  /** Durable workflows admit the generated file in a separate step. */
  deferAdmission?: boolean;
  prompt: string;
  negative?: string;
  width?: number;
  height?: number;
  steps?: number;
  cfg?: number;
  seed?: number;
}
export interface VideoInput {
  prompt: string;
  firstFrameAssetId?: string;
  lastFrameAssetId?: string;
  width?: number;
  height?: number;
  frames?: number;
  seed?: number;
}
export interface TTSInput {
  text: string;
  mode?: "custom-voice" | "voice-design" | "voice-clone";
  language?: string;
  speaker?: string;
  instruct?: string;
  voiceDescription?: string;
  referenceAudio?: string;
  referenceText?: string;
  xVectorOnly?: boolean;
  maxNewTokens?: number;
  seed?: number;
}
/** Owned by the orchestration host, not by hot-reloadable Action modules. */
export interface LocalAIClient {
  service(
    id: LocalAIServiceId,
    operation: "status" | "start" | "stop",
    signal: AbortSignal,
  ): Promise<ServiceStatus>;
  image(input: ImageInput, signal: AbortSignal): Promise<MediaResult>;
  video(input: VideoInput, signal: AbortSignal): Promise<MediaResult>;
  tts(input: TTSInput, signal: AbortSignal): Promise<MediaResult>;
  comfyWorkflow(
    input: ComfyWorkflowInput,
    signal: AbortSignal,
  ): Promise<ComfyWorkflowResult>;
}
export function localAI(context: ActionContext): LocalAIClient {
  if (!context.localAI)
    throw new Error("此 Action 需要 Aura 后端本地 AI 服务管理器。");
  return context.localAI;
}
