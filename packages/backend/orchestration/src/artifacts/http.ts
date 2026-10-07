import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import type { WorkflowArtifact } from "@aura/protocol/types";
import { validArtifactId } from "./media.ts";
import { FlowError } from "../schema.ts";

export interface ArtifactFile {
  artifact: Pick<WorkflowArtifact, "name" | "mimeType"> &
    Partial<Pick<WorkflowArtifact, "status">>;
  fileId: string;
  format: WorkflowArtifact["format"] | "md" | "json" | "zip";
}
export function byteRange(
  header: string,
  size: number,
): { start: number; end: number } | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return;
  let start: number;
  let end: number;
  if (!match[1]) {
    const count = Number(match[2]);
    if (!Number.isSafeInteger(count) || count <= 0) return;
    start = Math.max(0, size - count);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start
  )
    return;
  return { start, end };
}

/** Only an already-authorized immutable id reaches the filesystem boundary. */
export async function artifactResponse(
  root: string,
  descriptor: ArtifactFile,
  request: Request,
  thumbnail: boolean,
): Promise<Response> {
  const { artifact, fileId, format } = descriptor;
  if (
    !validArtifactId(fileId) ||
    ![
      "png",
      "jpeg",
      "webp",
      "glb",
      "mp4",
      "wav",
      "srt",
      "md",
      "json",
      "zip",
    ].includes(format)
  )
    throw new FlowError("产物不存在。", 404);
  const download = new URL(request.url).searchParams.get("download") === "1";
  if (!thumbnail && artifact.status === "unsupported" && !download)
    throw new FlowError("文件格式不支持预览，请下载查看。", 415);
  const path = join(root, `${fileId}.${format}`);
  let file;
  try {
    if (resolve(await realpath(path)) !== resolve(path))
      throw new Error("Symlink");
    file = await open(path, "r");
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > 200 * 1024 * 1024)
      throw new Error("Size");
    // Verify using this same descriptor, then stream bounded chunks. No GLB/base64 over JSON-RPC.
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(1024 * 1024);
    for (let position = 0; position < stat.size;) {
      request.signal.throwIfAborted();
      const { bytesRead } = await file.read(
        chunk,
        0,
        Math.min(chunk.length, stat.size - position),
        position,
      );
      if (!bytesRead) throw new Error("Truncated");
      hash.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
    if (hash.digest("hex") !== fileId) throw new Error("Hash");
    const etag = `"${fileId}"`;
    const headers = new Headers({
      "Content-Type": thumbnail ? "image/webp" : artifact.mimeType,
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Accept-Ranges": "bytes",
      ETag: etag,
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="artifact.${format}"; filename*=UTF-8''${encodeURIComponent(artifact.name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`,
    });
    const matches = request.headers
      .get("if-none-match")
      ?.split(",")
      .map((value) => value.trim().replace(/^W\//, ""));
    if (matches?.includes(etag) || matches?.includes("*")) {
      await file.close();
      return new Response(null, { status: 304, headers });
    }
    let range: { start: number; end: number } | undefined;
    const rangeHeader = request.headers.get("range");
    if (
      rangeHeader &&
      request.method !== "HEAD" &&
      (!request.headers.has("if-range") ||
        request.headers.get("if-range") === etag)
    ) {
      range = byteRange(rangeHeader, stat.size);
      if (!range) {
        await file.close();
        headers.set("Content-Range", `bytes */${stat.size}`);
        return new Response(null, { status: 416, headers });
      }
      headers.set(
        "Content-Range",
        `bytes ${range.start}-${range.end}/${stat.size}`,
      );
    }
    headers.set(
      "Content-Length",
      String(range ? range.end - range.start + 1 : stat.size),
    );
    if (request.method === "HEAD") {
      await file.close();
      return new Response(null, { headers });
    }
    const stream = file.createReadStream({
      start: range?.start ?? 0,
      end: range?.end ?? stat.size - 1,
      autoClose: true,
    });
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
      status: range ? 206 : 200,
      headers,
    });
  } catch {
    await file?.close().catch(() => {});
    throw new FlowError("产物文件不可用，请重试或检查原生成文件。", 404);
  }
}
