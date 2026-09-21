import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type {
  ImageToImageParams,
  MultiviewToModelParams,
  Task,
  TextToImageParams,
  WaitForTaskOptions,
} from "@vastai/tripo-sdk";

const MAX_REFERENCE_BYTES = 20 * 1_024 * 1_024;
const MAX_IMAGE_BYTES = 32 * 1_024 * 1_024;
const MAX_MODEL_BYTES = 200 * 1_024 * 1_024;
const IMAGE_TASK_TIMEOUT_MS = 90_000;
const MODEL_TASK_TIMEOUT_MS = 2 * 60_000;

export const TRIPO_GAME_ASSET_CAPABILITY = "aura.tripo.game-asset";

export type TripoGameAssetImageModel =
  "chat_image_2.5_flare" | "chat_image_2.5_sunburst";

export type TripoGameAssetImageQuality =
  "low" | "medium" | "high" | "xhigh" | "max";

export interface TripoGameAssetRequest {
  prompt: string;
  referenceImagePath?: string;
  outputDirectory: string;
  assetName?: string;
  imageModel?: TripoGameAssetImageModel;
  imageQuality?: TripoGameAssetImageQuality;
  faceLimit?: number;
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
  Pick<TripoGameAssetRequest, "referenceImagePath" | "assetName"> {
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
): Promise<TripoGameAssetResult> {
  const input = assertRequest(request);
  signal.throwIfAborted();
  await mkdir(input.outputDirectory, { recursive: true });
  const temporaryDirectory = await mkdtemp(
    join(input.outputDirectory, ".aura-model-"),
  );
  let published = false;

  try {
    let reference: string | undefined;
    if (input.referenceImagePath) {
      const image = await loadReference(input.referenceImagePath);
      const uploaded = await client.uploadFile(image.bytes, {
        filename: `reference.${image.type.extension}`,
        contentType: image.type.contentType,
      });
      reference = uploaded.file_token;
    }

    const commonImage = {
      model: input.imageModel,
      size: "1024x1024",
      quality: input.imageQuality,
      background: "opaque" as const,
      output_format: "png" as const,
    };
    const frontTaskId = reference
      ? await client.imageToImage({
          input: reference,
          prompt: referencePrompt(input.prompt, "front"),
          ...commonImage,
        })
      : await client.textToImage({
          prompt: referencePrompt(input.prompt, "front"),
          ...commonImage,
        });
    const frontTask = await client.waitForTask(
      frontTaskId,
      waitOptions(signal, IMAGE_TASK_TIMEOUT_MS),
    );

    const tasks: Record<"front" | "left" | "back" | "right", Task> = {
      front: frontTask,
      left: frontTask,
      back: frontTask,
      right: frontTask,
    };
    for (const view of ["left", "back", "right"] as const) {
      const taskId = await client.imageToImage({
        input: frontTaskId,
        prompt: referencePrompt(input.prompt, view),
        ...commonImage,
      });
      tasks[view] = await client.waitForTask(
        taskId,
        waitOptions(signal, IMAGE_TASK_TIMEOUT_MS),
      );
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
    for (const view of ["front", "left", "back", "right"] as const) {
      const bytes = await download(
        fetcher,
        imageUrls[view],
        MAX_IMAGE_BYTES,
        signal,
      );
      if (imageType(bytes)?.extension !== "png")
        throw new Error(`Generated ${view} view is not a PNG image.`);
      await writeFile(imagePaths[view], bytes, { flag: "wx" });
    }

    const modelTaskId = await client.multiviewToModel({
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
    });
    const modelTask = await client.waitForTask(
      modelTaskId,
      waitOptions(signal, MODEL_TASK_TIMEOUT_MS),
    );
    const modelBytes = await download(
      fetcher,
      modelUrl(modelTask),
      MAX_MODEL_BYTES,
      signal,
    );
    if (!isGlb(modelBytes))
      throw new Error("Tripo did not return a valid GLB model.");
    const modelPath = join(temporaryDirectory, "model.glb");
    await writeFile(modelPath, modelBytes, { flag: "wx" });

    let previewPath: string | undefined;
    if (modelTask.output?.rendered_image_url) {
      const preview = await download(
        fetcher,
        httpsUrl(modelTask.output.rendered_image_url, "Model preview URL"),
        MAX_IMAGE_BYTES,
        signal,
      );
      const previewType = imageType(preview);
      if (!previewType)
        throw new Error("Tripo model preview is not a supported image.");
      previewPath = join(
        temporaryDirectory,
        `preview.${previewType.extension}`,
      );
      await writeFile(previewPath, preview, { flag: "wx" });
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
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });

    const finalDirectory = await uniqueFinalDirectory(
      input.outputDirectory,
      safeAssetName(input.assetName),
      modelTask.task_id,
    );
    await rename(temporaryDirectory, finalDirectory);
    published = true;

    const finalImages = Object.fromEntries(
      Object.entries(imagePaths).map(([view, path]) => [
        view,
        join(finalDirectory, basename(path)),
      ]),
    ) as TripoGameAssetResult["imagePaths"];
    return {
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
  } finally {
    if (!published) {
      assertOwnedTemporaryPath(input.outputDirectory, temporaryDirectory);
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}
