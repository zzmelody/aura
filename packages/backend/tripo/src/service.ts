import { toPublicTask } from "./task.ts";
import { readStoredApiKey } from "./credentials.ts";
import type { TripoPaidTaskJournal } from "./game-asset.ts";
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
  getBalance?(): Promise<{ balance: number }>;
  textToModel(params: TextToModelParams): Promise<string>;
  imageToModel(params: ImageToModelParams): Promise<string>;
  getTask(taskId: string): Promise<Task>;
}

export interface CreateTripoServiceOptions {
  /** Re-read backend configuration at each operation; a paid chain pins one client. */
  resolveOptions?: () => Promise<
    Pick<CreateTripoServiceOptions, "credentialPath" | "region" | "apiKey">
  >;
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

export class TripoService implements TripoPort {
  #client?: TripoSdkPort;
  #region: TripoRegion;
  #options?: CreateTripoServiceOptions;
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

  setOptions(options: CreateTripoServiceOptions) {
    this.#options = options;
  }

  async refresh(
    timeoutMs = 60_000,
    signal?: AbortSignal,
  ): Promise<TripoSdkPort | undefined> {
    const options = this.#options;
    if (!options) return this.#client;
    const current = options.resolveOptions
      ? await options.resolveOptions()
      : options;
    const key =
      current.apiKey?.trim() ||
      (await readStoredApiKey(current.credentialPath));
    this.#region = current.region;
    const fetcher = options.fetch ?? globalThis.fetch;
    this.#client = !key
      ? undefined
      : options.clientFactory
        ? options.clientFactory(key, TRIPO_BASE_URLS[current.region])
        : new TripoClient({
            apiKey: key,
            baseUrl: TRIPO_BASE_URLS[current.region],
            fetch: signal
              ? (input, init) =>
                  fetcher(input, {
                    ...init,
                    signal: AbortSignal.any([
                      signal,
                      ...(init?.signal ? [init.signal] : []),
                    ]),
                  })
              : fetcher,
            timeoutMs,
            retries: 0,
            userAgent: "aura-runtime/0.1",
          });
    return this.#client;
  }

  /** Read-only authentication check; never submits a generation task. */
  async checkConnection(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const client = await this.refresh(15_000, signal);
    if (!client) throw new TripoNotConfiguredError();
    if (!client.getBalance)
      throw new Error("Tripo balance check is unavailable.");
    await client.getBalance();
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
    await this.refresh();
    const client = this.#requireClient();
    return client.textToModel({
      prompt: input.prompt,
      negative_prompt: input.negativePrompt,
      ...generationParams(input),
    });
  }

  async imageToModel(input: TripoImageToModelRequest): Promise<string> {
    await this.refresh();
    const client = this.#requireClient();
    const file =
      "url" in input.image
        ? { url: input.image.url }
        : { file_token: input.image.fileToken };
    return client.imageToModel({ input: file, ...generationParams(input) });
  }

  async getTask(taskId: string): Promise<TripoTask> {
    await this.refresh();
    return toPublicTask(await this.#requireClient().getTask(taskId));
  }

  /** Serializes the image-heavy chain because Tripo's default image pool is one task. */
  async generateGameAsset(
    input: TripoGameAssetRequest,
    signal: AbortSignal,
    journal?: TripoPaidTaskJournal,
  ): Promise<TripoGameAssetResult> {
    await this.refresh();
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
      return await generateTripoGameAsset(
        client,
        input,
        this.#fetch,
        signal,
        journal,
      );
    } finally {
      release();
    }
  }

  /** A billed image task; the caller journals submission before wait/download. */
  async generateCloudImage(
    input: {
      prompt: string;
      model: "chat_image_2.5_flare" | "chat_image_2.5_sunburst";
      quality: "low" | "medium" | "high";
    },
    signal: AbortSignal,
    journal?: { taskId?: string; submitted(taskId: string): Promise<void> },
  ): Promise<{
    bytes: Uint8Array;
    taskId: string;
    creditsConsumed: number | null;
    actualModel: string | null;
  }> {
    await this.refresh();
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
      const taskId =
        journal?.taskId ??
        (await client.textToImage({
          prompt: input.prompt,
          model: input.model,
          quality: input.quality,
          size: "1024x1024",
          background: "opaque",
          output_format: "png",
        }));
      if (journal && !journal.taskId) await journal.submitted(taskId);
      // A lost submit response may already be billed. The caller must stop;
      // never issue a second textToImage call to resolve uncertainty.
      const task = await client.waitForTask(taskId, {
        pollingIntervalMs: 2_000,
        timeoutMs: 90_000,
        signal,
      });
      const raw = task.output?.generated_image_url;
      if (typeof raw !== "string")
        throw new Error(
          "Cloud image task returned no image URL; do not regenerate.",
        );
      const url = new URL(raw);
      if (url.protocol !== "https:" || url.username || url.password)
        throw new Error(
          "Cloud image task returned an unsafe URL; do not regenerate.",
        );
      const response = await this.#fetch(url.href, { signal });
      if (
        !response.ok ||
        Number(response.headers.get("content-length")) > 8 * 1024 * 1024
      )
        throw new Error(
          "Cloud image download failed or exceeded 8 MiB; do not regenerate.",
        );
      const reader = response.body?.getReader();
      if (!reader)
        throw new Error(
          "Cloud image response has no readable body; do not regenerate.",
        );
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > 8 * 1024 * 1024)
            throw new Error(
              "Cloud image stream exceeded 8 MiB; do not regenerate.",
            );
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      if (bytes.length < 64 || bytes.length > 8 * 1024 * 1024)
        throw new Error(
          "Cloud image bytes are missing or oversized; do not regenerate.",
        );
      const credits = task.credits_consumed;
      return {
        bytes,
        taskId,
        creditsConsumed:
          typeof credits === "number" &&
          Number.isFinite(credits) &&
          credits >= 0
            ? credits
            : null,
        actualModel:
          typeof task.input?.model === "string" ? task.input.model : null,
      };
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
  if (!apiKey) {
    const service = new TripoService(options.region, undefined, options.fetch);
    service.setOptions(options);
    return service;
  }
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
  const service = new TripoService(options.region, client, options.fetch);
  service.setOptions(options);
  return service;
}
