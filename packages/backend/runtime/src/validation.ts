import type { Readable } from "node:stream";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads and parses a bounded JSON request body. */
export async function readJson(
  request: Readable,
  limit = 256 * 1024,
): Promise<unknown> {
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error("请求大小限制无效。");

  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.byteLength;
    if (length > limit) throw new Error("请求过大。");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
