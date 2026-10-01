import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  lstat,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import {
  TripoAPIError,
  TripoRequestError,
  TripoTaskError,
  TripoTimeoutError,
  type ImageToImageParams,
  type MultiviewToModelParams,
  type Task,
  type TextToImageParams,
  type WaitForTaskOptions,
} from "@vastai/tripo-sdk";

const MAX_REFERENCE_BYTES = 20 * 1_024 * 1_024;
const MAX_IMAGE_BYTES = 32 * 1_024 * 1_024;
const MAX_MODEL_BYTES = 200 * 1_024 * 1_024;
const IMAGE_TASK_TIMEOUT_MS = 90_000;
const MODEL_TASK_TIMEOUT_MS = 2 * 60_000;

export const TRIPO_GAME_ASSET_CAPABILITY = "aura.tripo.game-asset";

export type TripoGameAssetStage =
  | "prepare-output"
  | "read-reference"
  | "upload-reference"
  | "generate-front"
  | "generate-left"
  | "generate-back"
  | "generate-right"
  | "download-front"
  | "download-left"
  | "download-back"
  | "download-right"
  | "generate-model"
  | "download-model"
  | "download-preview"
  | "publish-output";

export type TripoGameAssetFailureReason =
  | "timeout"
  | "network"
  | "provider-rejected"
  | "task-failed"
  | "task-cancelled"
  | "content-policy"
  | "local-io"
  | "unexpected";

const stageLabels: Record<TripoGameAssetStage, string> = {
  "prepare-output": "准备输出目录",
  "read-reference": "读取参考图",
  "upload-reference": "上传参考图",
  "generate-front": "生成前视图",
  "generate-left": "生成左视图",
  "generate-back": "生成后视图",
  "generate-right": "生成右视图",
  "download-front": "下载前视图",
  "download-left": "下载左视图",
  "download-back": "下载后视图",
  "download-right": "下载右视图",
  "generate-model": "生成 3D 模型",
  "download-model": "下载 3D 模型",
  "download-preview": "下载模型预览",
  "publish-output": "保存生成结果",
};

const localStageGuidance: Partial<Record<TripoGameAssetStage, string>> = {
  "prepare-output": "无法创建临时目录，请检查输出路径和写入权限。",
  "read-reference":
    "无法读取参考图，请确认文件存在，并且是 20 MiB 以下的 PNG、JPEG 或 WebP。",
  "download-front": "前视图下载或格式校验失败，请检查网络后重试。",
  "download-left": "左视图下载或格式校验失败，请检查网络后重试。",
  "download-back": "后视图下载或格式校验失败，请检查网络后重试。",
  "download-right": "右视图下载或格式校验失败，请检查网络后重试。",
  "download-model": "模型下载或 GLB 格式校验失败，请检查网络后重试。",
  "download-preview": "模型预览下载或格式校验失败，请检查网络后重试。",
  "publish-output": "无法发布生成结果，请检查输出目录的写入权限和剩余空间。",
};

/** A safe, product-facing diagnosis for one bounded game-asset stage. */
export class TripoGameAssetError extends Error {
  readonly stage: TripoGameAssetStage;
  readonly reason: TripoGameAssetFailureReason;

  constructor(
    stage: TripoGameAssetStage,
    reason: TripoGameAssetFailureReason,
    detail: string,
    options?: ErrorOptions,
  ) {
    super(`模型生成未完成 · ${stageLabels[stage]}：${detail}`, options);
    this.name = "TripoGameAssetError";
    this.stage = stage;
    this.reason = reason;
  }
}

function productStageError(
  stage: TripoGameAssetStage,
  error: unknown,
): TripoGameAssetError {
  if (error instanceof TripoGameAssetError) return error;
  if (error instanceof TripoTimeoutError) {
    const seconds = Math.max(1, Math.ceil(error.timeoutMs / 1_000));
    return new TripoGameAssetError(
      stage,
      "timeout",
      `等待超过 ${seconds} 秒，任务可能仍在 Tripo 后台处理。请勿立即重复提交，以免重复计费。`,
      { cause: error },
    );
  }
  if (error instanceof TripoTaskError) {
    if (error.status === "banned")
      return new TripoGameAssetError(
        stage,
        "content-policy",
        "内容未通过生成服务检查，请调整描述或参考图后重试。",
        { cause: error },
      );
    if (error.status === "cancelled")
      return new TripoGameAssetError(
        stage,
        "task-cancelled",
        "上游任务已取消，请确认服务状态后重试。",
        { cause: error },
      );
    return new TripoGameAssetError(
      stage,
      "task-failed",
      "上游任务执行失败，请稍后重试；若持续发生，请查看 Aura 后端日志。",
      { cause: error },
    );
  }
  if (error instanceof TripoRequestError)
    return new TripoGameAssetError(
      stage,
      "network",
      error.indeterminate
        ? "与 Tripo 的连接中断，服务端可能已经接收任务。请先确认任务状态，不要立即重复提交。"
        : "无法连接 Tripo 服务，请检查网络或代理后重试。",
      { cause: error },
    );
  if (error instanceof TripoAPIError)
    return new TripoGameAssetError(
      stage,
      "provider-rejected",
      error.code === 2
        ? "Tripo 凭据无效，请更新 Aura 的 Tripo 配置后重试。"
        : `Tripo 拒绝了请求（错误码 ${error.code}），请检查输入或服务配置。`,
      { cause: error },
    );
  const localGuidance = localStageGuidance[stage];
  return new TripoGameAssetError(
    stage,
    localGuidance ? "local-io" : "unexpected",
    localGuidance ?? "该环节发生未预期异常，请查看 Aura 后端日志后重试。",
    { cause: error },
  );
}

async function atStage<T>(
  stage: TripoGameAssetStage,
  signal: AbortSignal,
  execute: () => Promise<T>,
): Promise<T> {
  try {
    return await execute();
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof Error && error.name === "TripoBudgetError") throw error;
    throw productStageError(stage, error);
  }
}

export type TripoGameAssetImageModel =
  "chat_image_2.5_flare" | "chat_image_2.5_sunburst";

export type TripoGameAssetImageQuality =
  "low" | "medium" | "high" | "xhigh" | "max";

export interface TripoGameAssetRequest {
  prompt: string;
  referenceImagePath?: string;
  referenceImage?: { bytes: Uint8Array; contentType: "image/png" | "image/jpeg" | "image/webp" };
  outputDirectory: string;
  assetName?: string;
  imageModel?: TripoGameAssetImageModel;
  imageQuality?: TripoGameAssetImageQuality;
  faceLimit?: number;
}

/** Host-owned journal. `prepare` reserves credits before any provider submit. */
export interface TripoPaidTaskJournal {
  readonly workId: string;
  prepare(stage: "front" | "left" | "back" | "right" | "model", kind: "image" | "model"): Promise<string | undefined>;
  submitted(stage: "front" | "left" | "back" | "right" | "model", taskId: string): Promise<void>;
  completed(stage: "front" | "left" | "back" | "right" | "model", credits: number): Promise<void>;
  costUnknown?(stage: "front" | "left" | "back" | "right" | "model"): Promise<void>;
  result(): Promise<TripoGameAssetResult | undefined>;
  published(result: TripoGameAssetResult): Promise<void>;
}

export interface TripoGameAssetResult {
  outputDirectory: string;
  modelPath: string;
  previewPath?: string;
  imagePaths: {
    front: string;
    left: string;
    back: string;
    right: string;
  };
  manifestPath: string;
  taskIds: {
    front: string;
    left: string;
    back: string;
    right: string;
    model: string;
  };
  creditsConsumed: number;
  imageModel: TripoGameAssetImageModel;
  modelVersion: "P1-20260311";
  faceLimit: number;
}

export interface TripoGameAssetSdkPort {
  uploadFile(
    file: Uint8Array,
    options: { filename: string; contentType: string },
  ): Promise<{ file_token: string }>;
  textToImage(params: TextToImageParams): Promise<string>;
  imageToImage(params: ImageToImageParams): Promise<string>;
  multiviewToModel(params: MultiviewToModelParams): Promise<string>;
  waitForTask(taskId: string, options?: WaitForTaskOptions): Promise<Task>;
}

interface ImageType {
  extension: "jpg" | "png" | "webp";
  contentType: "image/jpeg" | "image/png" | "image/webp";
}

const viewInstructions = {
  front:
    "front orthographic view, centered, perfectly level, the complete object visible",
  left: "left orthographic side view of the exact same object, centered and perfectly level",
  back: "back orthographic view of the exact same object, centered and perfectly level",
  right:
    "right orthographic side view of the exact same object, centered and perfectly level",
} as const;

function assertRequest(
  input: TripoGameAssetRequest,
): Required<
  Pick<
    TripoGameAssetRequest,
    "prompt" | "outputDirectory" | "imageModel" | "imageQuality" | "faceLimit"
  >
> &
  Pick<TripoGameAssetRequest, "referenceImagePath" | "referenceImage" | "assetName"> {
  const prompt = input.prompt.trim();
  if (!prompt || prompt.length > 4_000)
    throw new Error("Model prompt must contain 1-4000 characters.");
  if (
    !isAbsolute(input.outputDirectory) ||
    input.outputDirectory.length > 4_096
  )
    throw new Error("Model outputDirectory must be a bounded absolute path.");
  if (
    input.referenceImagePath !== undefined &&
    (!isAbsolute(input.referenceImagePath) ||
      input.referenceImagePath.length > 4_096)
  )
    throw new Error(
      "Model referenceImagePath must be a bounded absolute path.",
    );
  if (input.referenceImage && input.referenceImagePath)
    throw new Error("Provide one reference image source, not both.");
  if (input.assetName !== undefined && input.assetName.length > 80)
    throw new Error("Model assetName must not exceed 80 characters.");
  const imageModel = input.imageModel ?? "chat_image_2.5_sunburst";
  if (
    imageModel !== "chat_image_2.5_flare" &&
    imageModel !== "chat_image_2.5_sunburst"
  )
    throw new Error("Unsupported GPT Image 2.5 model.");
  const imageQuality = input.imageQuality ?? "medium";
  if (!new Set(["low", "medium", "high", "xhigh", "max"]).has(imageQuality))
    throw new Error("Unsupported GPT Image 2.5 quality.");
  const faceLimit = input.faceLimit ?? 15_000;
  if (!Number.isSafeInteger(faceLimit) || faceLimit < 500 || faceLimit > 20_000)
    throw new Error("P1 faceLimit must be an integer from 500 to 20000.");
  return {
    prompt,
    outputDirectory: resolve(input.outputDirectory),
    referenceImagePath: input.referenceImagePath,
    referenceImage: input.referenceImage,
    assetName: input.assetName,
    imageModel,
    imageQuality,
    faceLimit,
  };
}

function safeAssetName(value: string | undefined): string {
  const normalized = (value?.trim() || "generated-model")
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "-")
    .replace(/[. ]+$/gu, "")
    .replace(/\s+/gu, "-")
    .slice(0, 64);
  return normalized || "generated-model";
}

function imageType(data: Uint8Array): ImageType | undefined {
  if (
    data.length >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  )
    return { extension: "png", contentType: "image/png" };
  if (
    data.length >= 3 &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data[2] === 0xff
  )
    return { extension: "jpg", contentType: "image/jpeg" };
  if (
    data.length >= 12 &&
    Buffer.from(data.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(data.subarray(8, 12)).toString("ascii") === "WEBP"
  )
    return { extension: "webp", contentType: "image/webp" };
  return undefined;
}

function isGlb(data: Uint8Array): boolean {
  return (
    data.length >= 12 &&
    Buffer.from(data.subarray(0, 4)).toString("ascii") === "glTF"
  );
}

function httpsUrl(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is missing.`);
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error(`${label} is not a safe HTTPS URL.`);
  return url.href;
}

function generatedImageUrl(task: Task): string {
  return httpsUrl(task.output?.generated_image_url, "Generated image URL");
}

function modelUrl(task: Task): string {
  return httpsUrl(
    task.output?.model_url ?? task.output?.pbr_model ?? task.output?.model,
    "Generated model URL",
  );
}

async function download(
  fetcher: typeof globalThis.fetch,
  url: string,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  signal.throwIfAborted();
  const response = await fetcher(url, { signal });
  if (!response.ok)
    throw new Error(`Artifact download failed with HTTP ${response.status}.`);
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maximumBytes)
    throw new Error("Generated artifact exceeds the download size limit.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.length > maximumBytes)
    throw new Error(
      "Generated artifact is empty or exceeds the download size limit.",
    );
  return bytes;
}

async function loadReference(path: string): Promise<{
  bytes: Uint8Array;
  type: ImageType;
}> {
  const metadata = await stat(path);
  if (
    !metadata.isFile() ||
    metadata.size < 1 ||
    metadata.size > MAX_REFERENCE_BYTES
  )
    throw new Error("Reference image must be a file no larger than 20 MiB.");
  const bytes = await readFile(path);
  const type = imageType(bytes);
  if (!type) throw new Error("Reference image must be PNG, JPEG, or WebP.");
  return { bytes, type };
}

function referencePrompt(
  prompt: string,
  view: keyof typeof viewInstructions,
): string {
  return [
    prompt,
    viewInstructions[view],
    "Use a clean neutral studio background and even diffuse lighting.",
    "Preserve identical silhouette, proportions, materials, colors, and distinctive details across every view.",
    "No perspective distortion, labels, text, callouts, turntable, floor crop, extra objects, or duplicated subject.",
    "This is a production reference for reconstructing one game asset in 3D.",
  ].join("\n");
}

function waitOptions(
  signal: AbortSignal,
  timeoutMs: number,
): WaitForTaskOptions {
  return {
    pollingIntervalMs: 2_000,
    timeoutMs,
    signal,
  };
}

function taskCredits(task: Task): number {
  return typeof task.credits_consumed === "number" &&
    Number.isFinite(task.credits_consumed)
    ? task.credits_consumed
    : 0;
}

function assertOwnedTemporaryPath(root: string, path: string): void {
  const child = relative(root, path);
  if (
    !child ||
    child.startsWith("..") ||
    isAbsolute(child) ||
    !basename(path).startsWith(".aura-model-")
  )
    throw new Error("Refusing to remove a non-temporary model output path.");
}

async function uniqueFinalDirectory(
  root: string,
  name: string,
  taskId: string,
) {
  const taskSuffix =
    taskId.replace(/[^A-Za-z0-9_-]/gu, "").slice(-12) ||
    randomUUID().slice(0, 8);
  const preferred = join(root, `${name}-${taskSuffix}`);
  try {
    await stat(preferred);
    return join(root, `${name}-${taskSuffix}-${randomUUID().slice(0, 8)}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return preferred;
    throw error;
  }
}

/** Runs the billed image + multiview-to-model chain and atomically publishes its files. */
export async function generateTripoGameAsset(
  client: TripoGameAssetSdkPort,
  request: TripoGameAssetRequest,
  fetcher: typeof globalThis.fetch,
  signal: AbortSignal,
  journal?: TripoPaidTaskJournal,
): Promise<TripoGameAssetResult> {
  const input = assertRequest(request);
  signal.throwIfAborted();
  const previous = await journal?.result();
  if (previous) {
    for (const path of [previous.modelPath, previous.manifestPath, ...Object.values(previous.imagePaths)]) {
      const retained = await stat(path).catch(() => undefined);
      if (!retained?.isFile()) throw new TripoGameAssetError("publish-output", "local-io",
        "已付费产物的本地文件缺失；不会重新提交生成任务。请恢复产物或人工核对账本。");
    }
    return previous;
  }
  const temporaryDirectory = await atStage(
    "prepare-output",
    signal,
    async () => {
      await mkdir(input.outputDirectory, { recursive: true });
      if (!journal) return mkdtemp(join(input.outputDirectory, ".aura-model-"));
      const path = join(input.outputDirectory, `.aura-model-${journal.workId.slice(0, 32)}`);
      try {
        const existing = await lstat(path);
        if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error("Model workspace is not a private directory.");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await mkdir(path);
      }
      return path;
    },
  );
  let published = false;

  try {
    let reference: string | undefined;
    if (input.referenceImagePath || input.referenceImage) {
      const image = input.referenceImage
        ? { bytes: input.referenceImage.bytes, type: imageType(input.referenceImage.bytes) }
        : await atStage("read-reference", signal, () => loadReference(input.referenceImagePath!));
      if (!image.type || image.bytes.byteLength > MAX_REFERENCE_BYTES)
        throw new TripoGameAssetError("read-reference", "local-io", "参考图格式无效或超过 20 MiB。");
      const referenceType = image.type;
      const uploaded = await atStage("upload-reference", signal, () =>
        client.uploadFile(image.bytes, {
          filename: `reference.${referenceType.extension}`,
          contentType: referenceType.contentType,
        }),
      );
      reference = uploaded.file_token;
    }

    const commonImage = {
      model: input.imageModel,
      size: "1024x1024",
      quality: input.imageQuality,
      background: "opaque" as const,
      output_format: "png" as const,
    };
    const paid = async (stage: "front" | "left" | "back" | "right" | "model", kind: "image" | "model", submit: () => Promise<string>, timeout: number) => {
      let taskId = journal ? await journal.prepare(stage, kind) : undefined;
      if (!taskId) {
        taskId = await submit();
        if (journal) await journal.submitted(stage, taskId);
      }
      const task = await client.waitForTask(taskId, waitOptions(signal, timeout));
      if (journal) {
        const credits = task.credits_consumed;
        if (typeof credits !== "number" || !Number.isFinite(credits) || credits < 0) {
          await journal.costUnknown?.(stage);
          throw new Error("Paid task completed without verifiable credit usage.");
        }
        await journal.completed(stage, credits);
      }
      return { taskId, task };
    };
    const { taskId: frontTaskId, task: frontTask } = await atStage(
      "generate-front",
      signal,
      async () => {
        return paid("front", "image", () => reference
          ? client.imageToImage({
              input: reference,
              prompt: referencePrompt(input.prompt, "front"),
              ...commonImage,
            })
          : client.textToImage({
              prompt: referencePrompt(input.prompt, "front"),
              ...commonImage,
            }), IMAGE_TASK_TIMEOUT_MS);
      },
    );

    const tasks: Record<"front" | "left" | "back" | "right", Task> = {
      front: frontTask,
      left: frontTask,
      back: frontTask,
      right: frontTask,
    };
    const generationStages = {
      left: "generate-left",
      back: "generate-back",
      right: "generate-right",
    } as const;
    for (const view of ["left", "back", "right"] as const) {
      tasks[view] = await atStage(generationStages[view], signal, async () => {
        const { task } = await paid(view, "image", () => client.imageToImage({
          input: frontTaskId,
          prompt: referencePrompt(input.prompt, view),
          ...commonImage,
        }), IMAGE_TASK_TIMEOUT_MS);
        return task;
      });
    }

    const imagePaths = {
      front: join(temporaryDirectory, "view-front.png"),
      left: join(temporaryDirectory, "view-left.png"),
      back: join(temporaryDirectory, "view-back.png"),
      right: join(temporaryDirectory, "view-right.png"),
    };
    const imageUrls = {
      front: generatedImageUrl(tasks.front),
      left: generatedImageUrl(tasks.left),
      back: generatedImageUrl(tasks.back),
      right: generatedImageUrl(tasks.right),
    };
    const downloadStages = {
      front: "download-front",
      left: "download-left",
      back: "download-back",
      right: "download-right",
    } as const;
    for (const view of ["front", "left", "back", "right"] as const) {
      await atStage(downloadStages[view], signal, async () => {
        if (journal) {
          try {
            const retained = await readFile(imagePaths[view]);
            if (imageType(retained)?.extension !== "png" || retained.byteLength > MAX_IMAGE_BYTES)
              throw new Error("Retained generated view is invalid.");
            return;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        const bytes = await download(
          fetcher,
          imageUrls[view],
          MAX_IMAGE_BYTES,
          signal,
        );
        if (imageType(bytes)?.extension !== "png")
          throw new Error(`Generated ${view} view is not a PNG image.`);
        await writeFile(imagePaths[view], bytes, { flag: "wx" });
      });
    }

    const modelTask = await atStage("generate-model", signal, async () => {
      const { task } = await paid("model", "model", () => client.multiviewToModel({
        inputs: [
          imageUrls.front,
          imageUrls.left,
          imageUrls.back,
          imageUrls.right,
        ],
        model: "P1-20260311",
        face_limit: input.faceLimit,
        texture: true,
        pbr: true,
        texture_alignment: "original_image",
        texture_quality: "standard",
        auto_size: true,
        export_uv: true,
      }), MODEL_TASK_TIMEOUT_MS);
      return task;
    });
    const modelBytes = await atStage("download-model", signal, async () => {
      if (journal) {
        try {
          const retained = await readFile(join(temporaryDirectory, "model.glb"));
          if (!isGlb(retained) || retained.byteLength > MAX_MODEL_BYTES) throw new Error("Retained GLB is invalid.");
          return retained;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      const bytes = await download(
        fetcher,
        modelUrl(modelTask),
        MAX_MODEL_BYTES,
        signal,
      );
      if (!isGlb(bytes))
        throw new Error("Tripo did not return a valid GLB model.");
      return bytes;
    });
    const modelPath = join(temporaryDirectory, "model.glb");
    if (!journal || !(await stat(modelPath).catch(() => undefined)))
      await atStage("publish-output", signal, () => writeFile(modelPath, modelBytes, { flag: "wx" }));

    let previewPath: string | undefined;
    if (modelTask.output?.rendered_image_url) {
      previewPath = await atStage("download-preview", signal, async () => {
        if (journal) {
          for (const extension of ["png", "jpg", "webp"]) {
            const retainedPath = join(temporaryDirectory, `preview.${extension}`);
            const retained = await readFile(retainedPath).catch((error) => {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
              throw error;
            });
            if (retained) {
              if (!imageType(retained) || retained.byteLength > MAX_IMAGE_BYTES)
                throw new Error("Retained model preview is invalid.");
              return retainedPath;
            }
          }
        }
        const preview = await download(
          fetcher,
          httpsUrl(modelTask.output!.rendered_image_url, "Model preview URL"),
          MAX_IMAGE_BYTES,
          signal,
        );
        const previewType = imageType(preview);
        if (!previewType)
          throw new Error("Tripo model preview is not a supported image.");
        const path = join(
          temporaryDirectory,
          `preview.${previewType.extension}`,
        );
        await writeFile(path, preview, { flag: "wx" });
        return path;
      });
    }

    const creditsConsumed = Object.values(tasks).reduce(
      (total, task) => total + taskCredits(task),
      taskCredits(modelTask),
    );
    const manifest = {
      schemaVersion: 1,
      generator: "aura-tripo-game-asset",
      prompt: input.prompt,
      inputMode: reference ? "image-to-image" : "text-to-image",
      image: {
        model: input.imageModel,
        quality: input.imageQuality,
        size: "1024x1024",
        views: ["front", "left", "back", "right"],
      },
      model: {
        version: "P1-20260311",
        format: "glb",
        faceLimit: input.faceLimit,
        texture: true,
        pbr: true,
        autoSizeMeters: true,
      },
      tasks: {
        front: tasks.front.task_id,
        left: tasks.left.task_id,
        back: tasks.back.task_id,
        right: tasks.right.task_id,
        model: modelTask.task_id,
      },
      creditsConsumed,
      files: {
        model: "model.glb",
        preview: previewPath ? basename(previewPath) : null,
        views: {
          front: "view-front.png",
          left: "view-left.png",
          back: "view-back.png",
          right: "view-right.png",
        },
      },
    };
    const manifestPath = join(temporaryDirectory, "manifest.json");
    const finalDirectory = await atStage("publish-output", signal, async () => {
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
        encoding: "utf8",
        flag: journal ? "w" : "wx",
      });
      const directory = await uniqueFinalDirectory(
        input.outputDirectory,
        safeAssetName(input.assetName),
        modelTask.task_id,
      );
      await rename(temporaryDirectory, directory);
      return directory;
    });
    published = true;

    const finalImages = Object.fromEntries(
      Object.entries(imagePaths).map(([view, path]) => [
        view,
        join(finalDirectory, basename(path)),
      ]),
    ) as TripoGameAssetResult["imagePaths"];
    const result: TripoGameAssetResult = {
      outputDirectory: finalDirectory,
      modelPath: join(finalDirectory, basename(modelPath)),
      ...(previewPath
        ? { previewPath: join(finalDirectory, basename(previewPath)) }
        : {}),
      imagePaths: finalImages,
      manifestPath: join(finalDirectory, basename(manifestPath)),
      taskIds: manifest.tasks,
      creditsConsumed,
      imageModel: input.imageModel,
      modelVersion: "P1-20260311",
      faceLimit: input.faceLimit,
    };
    if (journal) await journal.published(result);
    return result;
  } finally {
    if (!published && !journal) {
      assertOwnedTemporaryPath(input.outputDirectory, temporaryDirectory);
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}
