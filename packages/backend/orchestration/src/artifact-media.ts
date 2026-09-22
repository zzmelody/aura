import { createHash } from "node:crypto";
import sharp from "sharp";
import type { WorkflowArtifact } from "@aura/protocol/types";

export const artifactHash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
export const validArtifactId = (id: string) => /^[a-f0-9]{64}$/.test(id);
export type ArtifactMedia = Pick<
  WorkflowArtifact,
  "kind" | "format" | "mimeType" | "bytes" | "width" | "height" | "status"
>;

/** Do not let a GLB cause browser requests to an external texture/buffer URI. */
export function selfContainedGlb(bytes: Buffer): boolean {
  if (
    bytes.length < 20 ||
    bytes.toString("ascii", 0, 4) !== "glTF" ||
    bytes.readUInt32LE(4) !== 2 ||
    bytes.readUInt32LE(8) !== bytes.length
  )
    return false;
  try {
    let offset = 12;
    let json: Record<string, unknown> | undefined;
    while (offset < bytes.length) {
      if (offset + 8 > bytes.length) return false;
      const size = bytes.readUInt32LE(offset);
      const type = bytes.readUInt32LE(offset + 4);
      if (size % 4 || offset + 8 + size > bytes.length) return false;
      if (offset === 12) {
        if (type !== 0x4e4f534a) return false;
        json = JSON.parse(
          bytes.toString("utf8", offset + 8, offset + 8 + size),
        );
      }
      offset += 8 + size;
    }
    if (!json || (json.asset as { version?: string })?.version !== "2.0")
      return false;
    // URI-bearing extensions follow the same policy, including unusual nested resources.
    const visit = (value: unknown): boolean => {
      if (!value || typeof value !== "object") return true;
      return Object.entries(value).every(([key, item]) =>
        key === "uri"
          ? typeof item === "string" &&
            /^data:(?:application\/octet-stream|application\/gltf-buffer|image\/(?:png|jpeg|webp));base64,[a-zA-Z0-9+/=]*$/.test(
              item,
            )
          : visit(item),
      );
    };
    return visit(json);
  } catch {
    return false;
  }
}

export async function inspectArtifact(bytes: Buffer): Promise<ArtifactMedia> {
  if (bytes.toString("ascii", 0, 4) === "glTF") {
    return {
      kind: "model",
      format: "glb",
      mimeType: "model/gltf-binary",
      bytes: bytes.length,
      status: selfContainedGlb(bytes) ? "ready" : "unsupported",
    };
  }
  const metadata = await sharp(bytes, {
    limitInputPixels: 40_000_000,
    failOn: "error",
  }).metadata();
  if (!["png", "jpeg", "webp"].includes(metadata.format ?? ""))
    throw new Error("Unsupported image");
  if (bytes.length > 32 * 1024 * 1024) throw new Error("Image is too large");
  // Decode once at admission: a valid header alone does not make a valid image.
  await sharp(bytes, { limitInputPixels: 40_000_000, failOn: "error" })
    .resize(1, 1)
    .raw()
    .toBuffer();
  const format = metadata.format as "png" | "jpeg" | "webp";
  return {
    kind: "image",
    format,
    mimeType: `image/${format}`,
    bytes: bytes.length,
    width: metadata.width,
    height: metadata.height,
    status: "ready",
  };
}

export function artifactThumbnail(bytes: Buffer) {
  return sharp(bytes, { limitInputPixels: 40_000_000 })
    .rotate()
    .resize(640, 480, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer();
}
