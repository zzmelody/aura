import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import sharp from "sharp";
import { ActionFailure } from "./action-api.ts";
import {
  artifactHash,
  artifactThumbnail,
  inspectArtifact,
} from "./artifact-media.ts";

const MAX_MODEL_BYTES = 200 * 1024 * 1024;
export interface ModelArtifact {
  artifactId: string;
  sha256: string;
  bytes: number;
  format: "glb";
}

/** Only trusted producers register bytes. No Action exposes an arbitrary file reader. */
export class GeneratedArtifacts {
  readonly root: string;
  constructor(root: string) {
    this.root = root;
  }

  /** Admit a user image into the same content-addressed store as generated media. */
  async registerImage(bytes: Uint8Array, signal: AbortSignal) {
    signal.throwIfAborted();
    if (bytes.length < 1 || bytes.length > 32 * 1024 * 1024)
      throw new ActionFailure("image_size_limit: 图片必须小于 32 MiB。");
    let media;
    try {
      media = await inspectArtifact(Buffer.from(bytes));
    } catch {
      throw new ActionFailure("invalid_image: 图片内容无效。");
    }
    if (media.kind !== "image")
      throw new ActionFailure("invalid_image: 只接受 PNG、JPEG 或 WebP 图片。");
    const artifactId = artifactHash(bytes);
    await publishBytes(
      this.root,
      `${artifactId}.${media.format}`,
      bytes,
      signal,
    );
    return { artifactId, ...media };
  }

  /** Stage only a verified image ID into one isolated ComfyUI input directory. */
  async stageImage(
    artifactId: string,
    exchange: string,
    signal: AbortSignal,
    size?: { width: number; height: number },
  ) {
    if (!/^[a-f0-9]{64}$/u.test(artifactId))
      throw new ActionFailure("invalid_image_id: 需要图片资产 ID。");
    let bytes: Buffer | undefined;
    for (const format of ["png", "jpeg", "webp"] as const) {
      try {
        bytes = await readBoundedFile(
          join(this.root, `${artifactId}.${format}`),
          32 * 1024 * 1024,
          signal,
          this.root,
        );
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (!bytes || artifactHash(bytes) !== artifactId)
      throw new ActionFailure("invalid_image_id: 图片资产不存在或内容已改变。");
    const media = await inspectArtifact(bytes);
    if (media.kind !== "image")
      throw new ActionFailure("invalid_image: 图片资产格式错误。");
    const filename = `${artifactId}${size ? `-${size.width}x${size.height}` : ""}.png`;
    const image = sharp(bytes, {
      limitInputPixels: 40_000_000,
      failOn: "error",
    }).rotate();
    const normalized = await (
      size
        ? image.resize(size.width, size.height, {
            fit: "cover",
            position: "centre",
          })
        : image
    )
      .png()
      .toBuffer();
    await publishBytes(exchange, filename, normalized, signal);
    return filename;
  }

  async registerFile(path: string, signal: AbortSignal, root?: string) {
    const bytes = await readBoundedFile(path, MAX_MODEL_BYTES, signal, root);
    const media = await inspectArtifact(bytes);
    const artifactId = artifactHash(bytes);
    await publishBytes(
      this.root,
      `${artifactId}.${media.format}`,
      bytes,
      signal,
    );
    let thumbnailId: string | undefined;
    if (media.kind === "image") {
      try {
        const thumbnail = await artifactThumbnail(bytes);
        thumbnailId = artifactHash(thumbnail);
        await publishBytes(this.root, `${thumbnailId}.webp`, thumbnail, signal);
      } catch {
        /* The original is retained even when thumbnail generation fails. */
      }
    }
    return { ...media, artifactId, ...(thumbnailId ? { thumbnailId } : {}) };
  }

  async registerModel(
    path: string,
    signal: AbortSignal,
  ): Promise<ModelArtifact> {
    const bytes = await readBoundedFile(path, MAX_MODEL_BYTES, signal);
    validateGlb(bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await publishBytes(this.root, `${sha256}.glb`, bytes, signal);
    return { artifactId: sha256, sha256, bytes: bytes.length, format: "glb" };
  }

  async stageModel(artifactId: unknown, exchange: string, signal: AbortSignal) {
    if (typeof artifactId !== "string" || !/^[a-f0-9]{64}$/u.test(artifactId))
      throw new ActionFailure(
        "invalid_artifact_id: Expected a generated model reference, not a path.",
      );
    const bytes = await readBoundedFile(
      join(this.root, `${artifactId}.glb`),
      MAX_MODEL_BYTES,
      signal,
      this.root,
    );
    if (createHash("sha256").update(bytes).digest("hex") !== artifactId)
      throw new ActionFailure(
        "artifact_hash_mismatch: Generated model bytes changed.",
      );
    validateGlb(bytes);
    await publishBytes(exchange, `${artifactId}.glb`, bytes, signal);
  }

  /** Stage only an immutable, already-registered square PNG for Veya clouds. */
  async stageCloudPng(artifactId: unknown, exchange: string, signal: AbortSignal) {
    if (typeof artifactId !== "string" || !/^[a-f0-9]{64}$/u.test(artifactId))
      throw new ActionFailure("invalid_image_artifact: Expected a registered PNG hash.");
    const bytes = await readBoundedFile(join(this.root, `${artifactId}.png`), 8 * 1024 * 1024, signal, this.root);
    if (createHash("sha256").update(bytes).digest("hex") !== artifactId)
      throw new ActionFailure("artifact_hash_mismatch: Cloud PNG bytes changed.");
    const metadata = await sharp(bytes, { limitInputPixels: 4_194_304, failOn: "error" }).metadata();
    if (metadata.format !== "png" || !metadata.width || metadata.width !== metadata.height ||
        metadata.width < 256 || metadata.width > 2048)
      throw new ActionFailure("invalid_image_artifact: Cloud PNG must be square 256–2048 px.");
    await publishBytes(exchange, `${artifactId}.png`, bytes, signal);
  }
}

export async function readBoundedFile(
  path: string,
  limit: number,
  signal: AbortSignal,
  root?: string,
) {
  signal.throwIfAborted();
  const canonical = await realpath(path);
  // Compare canonical directories so aliases such as macOS /var and /private/var
  // are equivalent. The original basename still rejects symlinked files.
  if (
    root &&
    (dirname(canonical) !== (await realpath(root)) ||
      canonical !== join(dirname(canonical), basename(path)))
  )
    throw new ActionFailure(
      "invalid_artifact_path: File escaped its managed directory.",
    );
  const file = await open(canonical, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > limit)
      throw new ActionFailure(
        "artifact_size_limit: Artifact is empty or exceeds the size limit.",
      );
    // Read at most limit+1 even if the producer changes the file after stat().
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      signal.throwIfAborted();
      const read = await file.read(bytes, length, bytes.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length !== stat.size)
      throw new ActionFailure(
        "artifact_changed: Artifact changed during reading.",
      );
    return bytes.subarray(0, length);
  } finally {
    await file.close();
  }
}

export async function publishBytes(
  root: string,
  name: string,
  bytes: Uint8Array,
  signal: AbortSignal,
) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const canonical = await realpath(root);
  const temporary = join(canonical, `.${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(bytes, { signal });
    await file.sync();
    await file.close();
    signal.throwIfAborted();
    await rename(temporary, join(canonical, name));
  } finally {
    await file.close();
    await rm(temporary, { force: true });
  }
}

function validateGlb(bytes: Buffer) {
  if (
    bytes.length < 20 ||
    bytes.toString("ascii", 0, 4) !== "glTF" ||
    bytes.readUInt32LE(4) !== 2 ||
    bytes.readUInt32LE(8) !== bytes.length
  )
    throw new ActionFailure(
      "invalid_model_artifact: Expected a complete GLB v2 file.",
    );
}
