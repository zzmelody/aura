import { createConnection } from "node:net";
import { open, unlink } from "node:fs/promises";

export function portOccupied(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (occupied: boolean) => {
      socket.destroy();
      resolve(occupied);
    };
    socket.setTimeout(500, () => finish(true)); // Uncertain ownership: fail closed.
    socket.once("connect", () => finish(true));
    socket.once("error", (error: NodeJS.ErrnoException) =>
      finish(error.code !== "ECONNREFUSED"),
    );
  });
}

export async function request(
  url: string,
  signal: AbortSignal,
  body?: unknown,
  token?: string,
) {
  return fetch(url, {
    method: body === undefined ? "GET" : "POST",
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export async function readJSON(response: Response): Promise<unknown> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`本地 AI HTTP 请求失败 (${response.status})。`);
  }
  if (!response.body) throw new Error("本地 AI 返回空响应。");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2 * 1024 * 1024)
        throw new Error("本地 AI JSON 响应超过 2 MiB。");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Bounded streaming; partial downloads are removed, successful artifacts are retained. */
export async function saveAudio(
  response: Response,
  path: string,
  signal: AbortSignal,
) {
  if (
    !response.ok ||
    !response.headers.get("content-type")?.includes("audio/wav")
  ) {
    await response.body?.cancel();
    throw new Error(`本地 TTS 未返回 WAV (${response.status})。`);
  }
  if (!response.body) throw new Error("本地 TTS 返回空音频。");
  const reader = response.body.getReader();
  let file;
  let complete = false;
  let bytes = 0;
  try {
    file = await open(path, "wx", 0o600);
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 64 * 1024 * 1024) throw new Error("TTS 音频超过 64 MiB。");
      await file.writeFile(value);
    }
    if (bytes < 44) throw new Error("TTS 音频不完整。");
    signal.throwIfAborted();
    complete = true;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
    await file?.close();
    if (!complete && file) await unlink(path).catch(() => undefined);
  }
}

export async function readReferenceAudio(path: string, signal: AbortSignal) {
  const file = await open(path, "r");
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 1 || info.size > 30 * 1024 * 1024)
      throw new Error("参考音频必须是 1 字节至 30 MiB 的本地文件。");
    while (true) {
      signal.throwIfAborted();
      const buffer = Buffer.alloc(64 * 1024);
      const result = await file.read(buffer);
      if (!result.bytesRead) break;
      bytes += result.bytesRead;
      // Bound the actual read, not only a previous stat (the file can grow).
      if (bytes > 30 * 1024 * 1024) throw new Error("参考音频超过 30 MiB。");
      chunks.push(buffer.subarray(0, result.bytesRead));
    }
    if (!bytes) throw new Error("参考音频为空。");
    return Buffer.concat(chunks);
  } finally {
    await file.close();
  }
}
