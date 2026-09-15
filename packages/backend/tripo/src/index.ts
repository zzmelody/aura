import { readFile } from "node:fs/promises";
import type {
  TripoImageToModelRequest,
  TripoIntegrationStatus,
  TripoGenerationOptions,
  TripoTask,
  TripoTextToModelRequest,
} from "@aura/protocol/types";
import {
  TripoClient,
  type ImageToModelParams,
  type Task,
  type TextToModelParams,
} from "@vastai/tripo-sdk";

export const TRIPO_BASE_URLS = {
  global: "https://openapi.tripo3d.ai/v3",
  china: "https://openapi.tripo3d.com/v3",
} as const;

export type TripoRegion = keyof typeof TRIPO_BASE_URLS;

export interface TripoPort {
  readonly configured: boolean;
  status(): TripoIntegrationStatus;
  textToModel(input: TripoTextToModelRequest): Promise<string>;
  imageToModel(input: TripoImageToModelRequest): Promise<string>;
  getTask(taskId: string): Promise<TripoTask>;
}

interface TripoSdkPort {
  textToModel(params: TextToModelParams): Promise<string>;
  imageToModel(params: ImageToModelParams): Promise<string>;
  getTask(taskId: string): Promise<Task>;
}

export interface CreateTripoServiceOptions {
  credentialPath: string;
  region: TripoRegion;
  /** Backend-only deployment override. Prefer the ignored credential file locally. */
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
  clientFactory?: (apiKey: string, baseUrl: string) => TripoSdkPort;
}

export class TripoNotConfiguredError extends Error {
  constructor() {
    super("Tripo API key is not configured.");
    this.name = "TripoNotConfiguredError";
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optionalEpochMilliseconds(value: unknown): number | undefined {
  const timestamp = optionalNumber(value);
  if (timestamp === undefined) return undefined;
  return timestamp < 100_000_000_000 ? timestamp * 1_000 : timestamp;
}

function safeUrl(value: unknown): string | undefined {
  const text = optionalString(value);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    return ["http:", "https:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function compactOutput(output: Task["output"]): TripoTask["output"] {
  if (!output || typeof output !== "object") return undefined;
  const result = {
    modelUrl: safeUrl(output.model_url ?? output.model),
    modelUrls: Array.isArray(output.model_urls)
      ? output.model_urls.flatMap((value) => {
          const url = safeUrl(value);
          return url ? [url] : [];
        })
      : undefined,
    baseModelUrl: safeUrl(output.base_model),
    pbrModelUrl: safeUrl(output.pbr_model),
    renderedImageUrl: safeUrl(
      output.rendered_image_url ?? output.rendered_image,
    ),
    riggable: optionalBoolean(output.riggable),
    rigType: optionalString(output.rig_type),
  };
  return Object.values(result).some((value) => value !== undefined)
    ? result
    : undefined;
}

function toPublicTask(task: Task): TripoTask {
  return {
    taskId: task.task_id,
    type: task.type,
    status: task.status,
    progress: optionalNumber(task.progress),
    createdAt: optionalEpochMilliseconds(task.create_time),
    output: compactOutput(task.output),
    error:
      task.error_msg || task.error_code !== undefined
        ? {
            code: optionalNumber(task.error_code),
            message: optionalString(task.error_msg),
          }
        : undefined,
  };
}

function generationParams(input: TripoGenerationOptions) {
  return {
    model: input.model,
    texture: input.texture,
    pbr: input.pbr,
    face_limit: input.faceLimit,
    texture_quality: input.textureQuality,
    geometry_quality: input.geometryQuality,
    quad: input.quad,
    generate_parts: input.generateParts,
  };
}

async function readStoredApiKey(path: string): Promise<string | undefined> {
  try {
    const value = (await readFile(path, "utf8")).trim();
    return value || undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Backend-only Tripo v3 adapter. It never exposes the API key or raw envelopes. */
export class TripoService implements TripoPort {
  readonly #client?: TripoSdkPort;
  readonly #region: TripoRegion;

  constructor(region: TripoRegion, client?: TripoSdkPort) {
    this.#region = region;
    this.#client = client;
  }

  get configured(): boolean {
    return this.#client !== undefined;
  }

  status(): TripoIntegrationStatus {
    return {
      configured: this.configured,
      region: this.#region,
      apiVersion: "v3",
      features: ["text-to-model", "image-to-model", "task-status"],
    };
  }

  async textToModel(input: TripoTextToModelRequest): Promise<string> {
    const client = this.#requireClient();
    return client.textToModel({
      prompt: input.prompt,
      negative_prompt: input.negativePrompt,
      ...generationParams(input),
    });
  }

  async imageToModel(input: TripoImageToModelRequest): Promise<string> {
    const client = this.#requireClient();
    const file =
      "url" in input.image
        ? { url: input.image.url }
        : { file_token: input.image.fileToken };
    return client.imageToModel({ file, ...generationParams(input) });
  }

  async getTask(taskId: string): Promise<TripoTask> {
    return toPublicTask(await this.#requireClient().getTask(taskId));
  }

  #requireClient(): TripoSdkPort {
    if (!this.#client) throw new TripoNotConfiguredError();
    return this.#client;
  }
}

/** Loads a local ignored secret first, with an environment override for deployment. */
export async function createTripoService(
  options: CreateTripoServiceOptions,
): Promise<TripoService> {
  const apiKey =
    options.apiKey?.trim() || (await readStoredApiKey(options.credentialPath));
  if (!apiKey) return new TripoService(options.region);
  const baseUrl = TRIPO_BASE_URLS[options.region];
  const client = options.clientFactory
    ? options.clientFactory(apiKey, baseUrl)
    : new TripoClient({
        apiKey,
        baseUrl,
        fetch: options.fetch,
        timeoutMs: 60_000,
        retries: 2,
        userAgent: "aura-runtime/0.1",
      });
  return new TripoService(options.region, client);
}
