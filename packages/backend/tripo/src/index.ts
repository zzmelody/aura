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
import {
  generateTripoGameAsset,
  type TripoGameAssetRequest,
  type TripoGameAssetResult,
  type TripoPaidTaskJournal,
  type TripoGameAssetSdkPort,
} from "./game-asset.ts";

export {
  TRIPO_GAME_ASSET_CAPABILITY,
  TripoGameAssetError,
  type TripoGameAssetFailureReason,
  type TripoGameAssetImageModel,
  type TripoGameAssetImageQuality,
  type TripoGameAssetRequest,
  type TripoGameAssetResult,
  type TripoPaidTaskJournal,
  type TripoGameAssetStage,
} from "./game-asset.ts";

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

interface TripoSdkPort extends TripoGameAssetSdkPort {
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

async function waitForQueueTurn(
  previous: Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const aborted = () => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = () => signal.removeEventListener("abort", aborted);
    signal.addEventListener("abort", aborted, { once: true });
    previous.then(
      () => {
        cleanup();
        resolve();
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
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
    createdAt:
      optionalEpochMilliseconds(task.create_time) ??
      (typeof task.created_at === "string"
        ? Date.parse(task.created_at) || undefined
        : undefined),
    output: compactOutput(task.output),
    error:
      task.error_message || task.error_msg || task.error_code !== undefined
        ? {
            code: optionalNumber(task.error_code),
            message: optionalString(task.error_message ?? task.error_msg),
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
  readonly #fetch: typeof globalThis.fetch;
  #gameAssetQueue: Promise<void> = Promise.resolve();

  constructor(
    region: TripoRegion,
    client?: TripoSdkPort,
    fetcher: typeof globalThis.fetch = globalThis.fetch,
  ) {
    this.#region = region;
    this.#client = client;
    this.#fetch = fetcher;
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
    return client.imageToModel({ input: file, ...generationParams(input) });
  }

  async getTask(taskId: string): Promise<TripoTask> {
    return toPublicTask(await this.#requireClient().getTask(taskId));
  }

  /** Serializes the image-heavy chain because Tripo's default image pool is one task. */
  async generateGameAsset(
    input: TripoGameAssetRequest,
    signal: AbortSignal,
    journal?: import("./game-asset.ts").TripoPaidTaskJournal,
  ): Promise<TripoGameAssetResult> {
    const client = this.#requireClient();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.#gameAssetQueue.catch(() => undefined);
    this.#gameAssetQueue = previous.then(() => turn);
    try {
      await waitForQueueTurn(previous, signal);
      signal.throwIfAborted();
      return await generateTripoGameAsset(client, input, this.#fetch, signal, journal);
    } finally {
      release();
    }
  }

  /** A billed image task; the caller journals submission before wait/download. */
  async generateCloudImage(
    input: { prompt: string; model: "chat_image_2.5_flare" | "chat_image_2.5_sunburst"; quality: "low" | "medium" | "high" },
    signal: AbortSignal,
    journal?: { taskId?: string; submitted(taskId: string): Promise<void> },
  ): Promise<{ bytes: Uint8Array; taskId: string; creditsConsumed: number | null; actualModel: string | null }> {
    const client = this.#requireClient();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    const previous = this.#gameAssetQueue.catch(() => undefined);
    this.#gameAssetQueue = previous.then(() => turn);
    try {
      await waitForQueueTurn(previous, signal);
      signal.throwIfAborted();
      const taskId = journal?.taskId ?? await client.textToImage({
        prompt: input.prompt, model: input.model, quality: input.quality,
        size: "1024x1024", background: "opaque", output_format: "png",
      });
      if (journal && !journal.taskId) await journal.submitted(taskId);
      // A lost submit response may already be billed. The caller must stop;
      // never issue a second textToImage call to resolve uncertainty.
      const task = await client.waitForTask(taskId, {
        pollingIntervalMs: 2_000, timeoutMs: 90_000, signal,
      });
      const raw = task.output?.generated_image_url;
      if (typeof raw !== "string") throw new Error("Cloud image task returned no image URL; do not regenerate.");
      const url = new URL(raw);
      if (url.protocol !== "https:" || url.username || url.password)
        throw new Error("Cloud image task returned an unsafe URL; do not regenerate.");
      const response = await this.#fetch(url.href, { signal });
      if (!response.ok || Number(response.headers.get("content-length")) > 8 * 1024 * 1024)
        throw new Error("Cloud image download failed or exceeded 8 MiB; do not regenerate.");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Cloud image response has no readable body; do not regenerate.");
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > 8 * 1024 * 1024)
            throw new Error("Cloud image stream exceeded 8 MiB; do not regenerate.");
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      if (bytes.length < 64 || bytes.length > 8 * 1024 * 1024)
        throw new Error("Cloud image bytes are missing or oversized; do not regenerate.");
      const credits = task.credits_consumed;
      return { bytes, taskId,
        creditsConsumed: typeof credits === "number" && Number.isFinite(credits) && credits >= 0 ? credits : null,
        actualModel: typeof task.input?.model === "string" ? task.input.model : null };
    } finally {
      release();
    }
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
  if (!apiKey)
    return new TripoService(options.region, undefined, options.fetch);
  const baseUrl = TRIPO_BASE_URLS[options.region];
  const client = options.clientFactory
    ? options.clientFactory(apiKey, baseUrl)
    : new TripoClient({
        apiKey,
        baseUrl,
        fetch: options.fetch,
        timeoutMs: 60_000,
        // Paid submissions have no idempotency key. A lost response may have
        // created a billable task, so the SDK must not retry POSTs implicitly.
        retries: 0,
        userAgent: "aura-runtime/0.1",
      });
  return new TripoService(options.region, client, options.fetch);
}
