import { CHAT_IMAGE_LIMIT } from "@aura/protocol/types";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Optional list of uploaded chat image asset IDs (sha256 hex). */
export function validCodingImages(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.length <= CHAT_IMAGE_LIMIT &&
      value.every((id) => typeof id === "string" && /^[a-f0-9]{64}$/u.test(id)))
  );
}
