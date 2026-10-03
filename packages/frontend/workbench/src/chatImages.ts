import type { ChatImage } from "@aura/core/types";
import { CHAT_IMAGE_LIMIT } from "@aura/protocol/types";

export { CHAT_IMAGE_LIMIT };

const types: Record<string, ChatImage["mimeType"]> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/** Accepted type for a picked, pasted or dropped file, or undefined. */
export function chatImageType(file: Pick<File, "type" | "name">) {
  if (Object.values(types).includes(file.type as ChatImage["mimeType"]))
    return file.type as ChatImage["mimeType"];
  return types[file.name.split(".").at(-1)?.toLowerCase() ?? ""];
}

export function chatImageUrl(endpoint: string, assetId: string) {
  return `${endpoint.replace(/\/$/, "")}/flows/assets/images/${assetId}`;
}

/** Uploads once by content; the same picture always returns the same ID. */
export async function uploadChatImage(
  endpoint: string,
  file: File,
  signal?: AbortSignal,
): Promise<ChatImage> {
  const mimeType = chatImageType(file);
  if (!mimeType) throw new Error("只支持 PNG、JPEG 或 WebP 图片。");
  if (file.size < 1 || file.size > 32 * 1024 * 1024)
    throw new Error("图片必须小于 32 MB。");
  const response = await fetch(
    `${endpoint.replace(/\/$/, "")}/flows/assets/images`,
    {
      method: "POST",
      headers: { "Content-Type": mimeType },
      body: file,
      signal,
    },
  );
  const value = (await response.json().catch(() => null)) as {
    assetId?: string;
    mimeType?: string;
    width?: number;
    height?: number;
    message?: string;
  } | null;
  if (!response.ok)
    throw new Error(value?.message || `图片上传失败（${response.status}）。`);
  if (!value?.assetId || !/^[a-f0-9]{64}$/u.test(value.assetId))
    throw new Error("图片上传没有返回有效的资产 ID。");
  return {
    assetId: value.assetId,
    mimeType: (value.mimeType as ChatImage["mimeType"]) ?? mimeType,
    ...(typeof value.width === "number" ? { width: value.width } : {}),
    ...(typeof value.height === "number" ? { height: value.height } : {}),
    name: file.name.slice(0, 180) || "image",
  };
}
