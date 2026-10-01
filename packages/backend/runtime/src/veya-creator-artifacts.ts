import { createHash } from "node:crypto";
import { open, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const hash = /^[a-f0-9]{64}$/u;
const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Read only a bounded regular file directly below the trusted, canonical directory. */
async function bounded(container: string, section: "artifacts" | "blobs", name: string, limit: number): Promise<Buffer> {
  const parent = await realpath(container), root = await realpath(join(parent, section));
  if (dirname(root) !== parent || basename(root) !== section) throw new Error("artifact_path_invalid");
  const path = await realpath(join(root, name));
  if (dirname(path) !== root || basename(path) !== name) throw new Error("artifact_path_invalid");
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 1 || info.size > limit) throw new Error("artifact_size_invalid");
    const buffer = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const item = await file.read(buffer, length, buffer.length - length, null);
      if (!item.bytesRead) break;
      length += item.bytesRead;
    }
    if (length !== info.size) throw new Error("artifact_changed");
    return buffer.subarray(0, length);
  } finally { await file.close(); }
}

export async function creatorArtifact(sessionPath: string, output: unknown, creationSessionId?: string) {
  const result = object(output), ref = object(result?.artifact);
  if (result?.status !== "ready" || ref?.schema_version !== 1 || ref.verified !== true || typeof ref.artifact_id !== "string" ||
      !hash.test(ref.artifact_id) || ref.content_hash !== ref.artifact_id ||
      typeof ref.candidate_hash !== "string" || !hash.test(ref.candidate_hash) ||
      !["world", "prop", "patch"].includes(ref.kind as string)) throw new Error("artifact_not_ready");
  const descriptorBytes = await readFile(sessionPath);
  if (descriptorBytes.length > 8192) throw new Error("worker_invalid");
  const descriptor = object(JSON.parse(descriptorBytes.toString("utf8")));
  if (descriptor?.role !== "creator-worker" || !creationSessionId || descriptor.creation_session_id !== creationSessionId || typeof descriptor.creation_root !== "string" || !isAbsolute(descriptor.creation_root))
    throw new Error("worker_invalid");
  const root = descriptor.creation_root;
  const bytes = await bounded(root, "artifacts", `${ref.artifact_id}.json`, 2 * 1024 * 1024);
  if (digest(bytes) !== ref.artifact_id) throw new Error("artifact_hash_mismatch");
  const manifest = object(JSON.parse(bytes.toString("utf8")));
  if (manifest?.schema_version !== 1 || manifest.candidate_hash !== ref.candidate_hash || manifest.kind !== ref.kind)
    throw new Error("artifact_candidate_mismatch");
  const blobs = new Map<string, number>();
  const visit = (value: unknown) => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const item = object(value);
    if (!item) return;
    if (item.blob_id !== undefined) {
      if (typeof item.blob_id !== "string" || !hash.test(item.blob_id) || !Number.isSafeInteger(item.bytes) ||
          (item.bytes as number) < 1 || (item.bytes as number) > 128 * 1024 * 1024)
        throw new Error("artifact_blob_invalid");
      if (blobs.has(item.blob_id) && blobs.get(item.blob_id) !== item.bytes) throw new Error("artifact_blob_invalid");
      blobs.set(item.blob_id, item.bytes as number);
    }
    Object.values(item).forEach(visit);
  };
  visit(manifest);
  if (blobs.size > 512 || [...blobs.values()].reduce((sum, value) => sum + value, 0) > 512 * 1024 * 1024)
    throw new Error("artifact_capacity_exceeded");
  return {
    bytes,
    metadata: { artifactId: ref.artifact_id, candidateHash: ref.candidate_hash, kind: ref.kind },
    async blob(blobId: string) {
      const size = blobs.get(blobId);
      if (!size) throw new Error("artifact_blob_not_found");
      const content = await bounded(root, "blobs", `${blobId}.bin`, size);
      if (content.length !== size || digest(content) !== blobId) throw new Error("artifact_blob_hash_mismatch");
      return content;
    },
  };
}
