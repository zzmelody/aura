import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import type {
  FlowRun,
  WorkflowArtifact,
  WorkflowArtifacts,
} from "@aura/protocol/types";
import type { GeneratedArtifacts } from "./generated.ts";
import { publishBytes } from "./generated.ts";
import { artifactHash, validArtifactId } from "./media.ts";
import { FlowError } from "../schema.ts";

export interface ArtifactOwner {
  runId: string;
  stepKey: string;
  attempt?: number;
  callId?: string;
}
interface Candidate {
  path: string;
  root: string;
  poster?: string;
  admitted: boolean;
}
interface RecordEntry {
  artifact: WorkflowArtifact;
  candidate: Candidate;
}
interface Index {
  version: 1;
  migration?: string;
  records: Record<string, RecordEntry>;
}
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const fileFormat = (path: string): WorkflowArtifact["format"] | undefined =>
  ({
    ".png": "png",
    ".jpg": "jpeg",
    ".jpeg": "jpeg",
    ".webp": "webp",
    ".glb": "glb",
    ".mp4": "mp4",
    ".wav": "wav",
  })[extname(path).toLowerCase()] as WorkflowArtifact["format"] | undefined;

/** Sidecar-only indexing: never rewrites durable Action output or replay identity. */
export class WorkflowArtifactIndex {
  readonly store: GeneratedArtifacts;
  readonly cwd: string;
  private locks = new Map<string, Promise<unknown>>();
  private queue = new Map<string, boolean>();
  private active?: string;
  private worker?: Promise<void>;
  private closed = false;
  private run?: (id: string) => FlowRun;
  private history?: (
    run: FlowRun,
    capture: (
      owner: ArtifactOwner,
      output: unknown,
      producer: string,
    ) => Promise<void>,
  ) => Promise<boolean>;
  private candidates?: (
    output: unknown,
    producer: string,
  ) => ReadonlyArray<{ path: string; name?: string; admitted: boolean }>;
  setPluginCandidates(
    resolve: NonNullable<WorkflowArtifactIndex["candidates"]>,
  ) {
    this.candidates = resolve;
  }
  constructor(store: GeneratedArtifacts, cwd: string) {
    this.store = store;
    this.cwd = cwd;
  }
  attach(
    run: (id: string) => FlowRun,
    history?: WorkflowArtifactIndex["history"],
  ) {
    this.run = run;
    this.history = history;
  }
  private indexPath(id: string) {
    return join(this.store.root, "runs", `${artifactHash(id)}.json`);
  }
  private async read(id: string): Promise<Index> {
    try {
      return JSON.parse(await readFile(this.indexPath(id), "utf8")) as Index;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { version: 1, records: {} };
      throw error;
    }
  }
  private async update(id: string, mutate: (index: Index) => void) {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const task = previous
      .catch(() => {})
      .then(async () => {
        const index = await this.read(id);
        mutate(index);
        await publishBytes(
          dirname(this.indexPath(id)),
          basename(this.indexPath(id)),
          Buffer.from(JSON.stringify(index)),
          AbortSignal.timeout(30_000),
        );
      });
    this.locks.set(id, task);
    try {
      await task;
    } finally {
      if (this.locks.get(id) === task) this.locks.delete(id);
    }
  }
  /** Public backend port for trusted Actions. Paths never become HTTP parameters. */
  async register(
    owner: ArtifactOwner,
    path: string,
    options: { name?: string; poster?: string } = {},
    admitted = true,
  ) {
    const format = fileFormat(path);
    if (!format) return;
    const key = artifactHash(
      JSON.stringify([
        owner.runId,
        owner.stepKey,
        owner.attempt,
        resolve(path),
      ]),
    );
    const previous = (await this.read(owner.runId)).records[key];
    if (previous?.artifact.status === "ready") return previous.artifact;
    const candidate = {
      path: resolve(path),
      root: dirname(resolve(path)),
      poster: options.poster,
      admitted,
    };
    const artifact: WorkflowArtifact = {
      ...owner,
      id: key,
      artifactId: key,
      name: (options.name ?? path).split(/[\\/]/).at(-1)!.slice(0, 180),
      kind:
        format === "glb"
          ? "model"
          : format === "mp4"
            ? "video"
            : format === "wav"
              ? "audio"
              : "image",
      format,
      mimeType:
        format === "glb"
          ? "model/gltf-binary"
          : format === "mp4"
            ? "video/mp4"
            : format === "wav"
              ? "audio/wav"
              : `image/${format}`,
      bytes: 0,
      status: "unavailable",
    };
    // Keep a recoverable receipt before local copying/decoding. This is never a generation retry.
    await this.update(owner.runId, (index) => {
      index.records[key] = { artifact, candidate };
    });
    if (admitted) {
      try {
        // Exact canonical path rejects symlinks, including symlinked parents.
        if (resolve(await realpath(candidate.path)) !== candidate.path)
          throw new Error("Symlink");
        Object.assign(
          artifact,
          await this.store.registerFile(
            candidate.path,
            AbortSignal.timeout(60_000),
            candidate.root,
          ),
        );
        if (
          artifact.kind === "model" &&
          options.poster &&
          dirname(resolve(options.poster)) === candidate.root
        ) {
          try {
            const poster = await this.store.registerFile(
              options.poster,
              AbortSignal.timeout(30_000),
              candidate.root,
            );
            if (poster.kind === "image")
              artifact.thumbnailId = poster.thumbnailId;
          } catch {
            /* Optional poster cannot invalidate a model. */
          }
        }
      } catch {
        /* Failure is isolated from the successful producer. */
      }
    }
    await this.update(owner.runId, (index) => {
      index.records[key] = { artifact, candidate };
    });
    return artifact;
  }

  async capture(
    owner: ArtifactOwner,
    output: unknown,
    producer: string,
  ): Promise<void> {
    for (const candidate of this.candidates?.(output, producer) ?? [])
      await this.register(
        owner,
        candidate.path,
        { name: candidate.name },
        candidate.admitted,
      );
    const visit = async (value: unknown, depth: number): Promise<void> => {
      if (depth > 8) return;
      if (Array.isArray(value)) {
        for (const item of value.slice(0, 100)) await visit(item, depth + 1);
        return;
      }
      const result = object(value);
      if (!result) return;
      if (
        typeof result.artifactId === "string" &&
        validArtifactId(result.artifactId) &&
        result.format === "glb"
      ) {
        await this.register(
          owner,
          join(this.store.root, `${result.artifactId}.glb`),
        );
        return;
      }
      for (const item of Object.values(result)) await visit(item, depth + 1);
    };
    await visit(output, 0);
  }

  private fingerprint(run: FlowRun) {
    // Version 2 admits local TTS audio; bumping it rescans earlier runs once.
    return artifactHash(JSON.stringify([2, run.status, run.steps, run.output]));
  }
  private async migrate(id: string, retry: boolean) {
    const run = this.run!(id);
    const fingerprint = this.fingerprint(run);
    const index = await this.read(id);
    if (!retry && index.migration === fingerprint) return;
    for (const step of run.steps) {
      const owner = {
        runId: id,
        stepKey: step.stepKey ?? step.id,
        attempt: step.attempts?.at(-1)?.number,
      };
      if (step.kind === "action")
        await this.capture(owner, step.output, step.actionId);
    }
    await this.capture({ runId: id, stepKey: "$output" }, run.output, "flow");
    const complete = this.history
      ? await this.history(run, (owner, output, producer) =>
          this.capture(owner, output, producer),
        )
      : true;
    if (retry)
      for (const entry of Object.values(index.records)) {
        if (entry.artifact.status === "unavailable" && entry.candidate.admitted)
          await this.register(entry.artifact, entry.candidate.path, {
            name: entry.artifact.name,
            poster: entry.candidate.poster,
          });
      }
    if (complete)
      await this.update(id, (next) => {
        next.migration = fingerprint;
      });
  }
  enqueue(id: string, retry = false, priority = false) {
    if (this.closed || this.active === id) return;
    if (priority)
      this.queue = new Map([
        [id, retry || this.queue.get(id) || false],
        ...[...this.queue].filter(([key]) => key !== id),
      ]);
    else this.queue.set(id, retry || this.queue.get(id) || false);
    if (!this.worker)
      this.worker = Promise.resolve()
        .then(async () => {
          while (this.queue.size && !this.closed) {
            const [next, force] = this.queue.entries().next().value!;
            this.queue.delete(next);
            this.active = next;
            try {
              await this.migrate(next, force);
            } catch {
              /* Keep the old migration marker; a later read retries. */
            }
            this.active = undefined;
          }
        })
        .finally(() => {
          this.worker = undefined;
        });
  }
  async close() {
    this.closed = true;
    this.queue.clear();
    await this.worker;
  }
  async settle() {
    await this.worker;
  }
  private runs(id: string, seen = new Set<string>()): FlowRun[] {
    if (seen.has(id) || seen.size > 500) return [];
    seen.add(id);
    const run = this.run!(id);
    return [
      run,
      ...run.steps.flatMap((step) =>
        step.kind === "flow" && step.childRunId
          ? this.runs(step.childRunId, seen)
          : [],
      ),
    ];
  }
  async list(id: string, retry = false): Promise<WorkflowArtifacts> {
    const runs = this.runs(id);
    const artifacts: WorkflowArtifact[] = [];
    let pending = false;
    for (const run of runs) {
      const index = await this.read(run.id);
      if (retry || index.migration !== this.fingerprint(run))
        this.enqueue(run.id, retry, true);
      pending ||= this.active === run.id || this.queue.has(run.id);
      artifacts.push(
        ...Object.values(index.records).map(({ artifact }) => artifact),
      );
    }
    return { artifacts, pending };
  }
  async resolve(
    id: string,
    artifactId: string,
    thumbnail: boolean,
  ): Promise<{
    artifact: WorkflowArtifact;
    fileId: string;
    format: WorkflowArtifact["format"];
  }> {
    if (!validArtifactId(artifactId)) throw new FlowError("产物不存在。", 404);
    for (const run of this.runs(id)) {
      const entry = Object.values((await this.read(run.id)).records).find(
        ({ artifact }) =>
          artifact.artifactId === artifactId &&
          artifact.status !== "unavailable",
      );
      if (!entry) continue;
      if (thumbnail && !entry.artifact.thumbnailId)
        throw new FlowError("预览图不可用。", 404);
      return {
        artifact: entry.artifact,
        fileId: thumbnail ? entry.artifact.thumbnailId! : artifactId,
        format: thumbnail ? "webp" : entry.artifact.format,
      };
    }
    throw new FlowError("产物不存在或文件不可用。", 404);
  }
}
