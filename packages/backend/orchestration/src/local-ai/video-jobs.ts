import { createHash } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { MediaResult, VideoInput, VideoJob } from "./api.ts";
import { z } from "zod";
import { videoInputSchema } from "./video-input.ts";
import { publishBytes } from "../artifacts/generated.ts";

const receiptSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/u),
  owner: z.string().min(1).max(128),
  revision: z.string().min(1).max(128),
  resumeId: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  input: videoInputSchema,
  state: z.enum([
    "queued",
    "running",
    "completed",
    "failed",
    "cancelled",
    "interrupted",
  ]),
  progress: z.object({
    segment: z.number().int().min(0).max(1000),
    total: z.number().int().min(0).max(1000),
  }),
  error: z.string().max(16000).optional(),
  result: z
    .object({
      service: z.literal("minimax-h3"),
      seed: z.number().int().min(0).max(2147483647),
      files: z.array(z.string().max(4096)).max(64),
      videoPath: z.string().max(4096).optional(),
      segments: z
        .array(
          z.object({
            index: z.number().int().min(0),
            frames: z.number().int().min(1),
            videoPath: z.string().max(4096),
          }),
        )
        .max(60)
        .optional(),
    })
    .optional(),
});

interface Receipt extends VideoJob {
  input: VideoInput;
  resumeId?: string;
  revision: string;
}
type Render = (
  input: VideoInput,
  signal: AbortSignal,
  id: string,
  report: (progress: VideoJob["progress"]) => Promise<void>,
) => Promise<MediaResult>;

/** Durable model jobs outlive bounded Action waits; shutdown never replays inference. */
export class VideoJobs {
  private running = new Map<
    string,
    { abort: AbortController; task: Promise<void> }
  >();
  private admission: Promise<unknown> = Promise.resolve();
  private storage: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(privateRoot: string, render: Render, revision = "minimax-h3-v2") {
    this.root = privateRoot;
    this.render = render;
    this.revision = revision;
  }
  private revision: string;
  private root: string;
  private render: Render;
  private path(id: string) {
    return join(this.root, `${id}.json`);
  }
  private stored<T>(operation: () => Promise<T>) {
    const task = this.storage.then(operation);
    this.storage = task.catch(() => undefined);
    return task;
  }
  private save(job: Receipt) {
    const bytes = Buffer.from(JSON.stringify(job));
    return this.stored(async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          await publishBytes(
            this.root,
            `${job.id}.json`,
            bytes,
            new AbortController().signal,
          );
          return;
        } catch (error) {
          // Windows scanners can briefly hold the destination across an atomic rename.
          const code = (error as NodeJS.ErrnoException).code;
          if (
            process.platform !== "win32" ||
            !["EPERM", "EACCES", "EBUSY"].includes(code ?? "") ||
            attempt >= 5
          )
            throw error;
          await delay(25 * 2 ** attempt);
        }
      }
    });
  }
  private read(id: string): Promise<Receipt | undefined> {
    return this.stored(async () => {
      try {
        const receipt = receiptSchema.parse(
          JSON.parse(await readFile(this.path(id), "utf8")) as unknown,
        );
        if (receipt.id !== id) throw new Error("视频作业记录身份无效。");
        return receipt;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return undefined;
        throw error;
      }
    });
  }
  async call(
    operation: "submit" | "wait" | "cancel",
    request: { id: string; owner: string; input?: VideoInput },
    signal: AbortSignal,
  ): Promise<VideoJob> {
    signal.throwIfAborted();
    if (this.closed) throw new Error("视频作业服务已关闭。");
    const id = createHash("sha256")
      .update(JSON.stringify([request.owner, request.id]))
      .digest("hex");
    const normalizedInput = request.input
      ? videoInputSchema.parse({
          ...request.input,
          seed:
            request.input.seed ??
            createHash("sha256")
              .update(request.owner + request.id)
              .digest()
              .readUInt32LE(0) % 2147483647,
        })
      : undefined;
    if (operation === "submit") {
      const task = this.admission.then(async () => {
        let job = await this.read(id);
        if (job) {
          if (
            job.revision !== this.revision ||
            JSON.stringify(job.input) !== JSON.stringify(normalizedInput)
          )
            throw new Error("同一视频任务 ID 的输入不能改变。");
          if (
            ["running", "queued"].includes(job.state) &&
            !this.running.has(id)
          ) {
            job.state = "interrupted";
            job.error = "宿主中断，未自动重复生成；请新建一次重试。";
            await this.save(job);
          }
          return job;
        }
        if (!normalizedInput) throw new Error("提交视频作业需要输入。");
        let resumeId: string | undefined;
        await mkdir(this.root, { recursive: true });
        for (const name of (await readdir(this.root))
          .filter((name) => /^[a-f0-9]{64}\.json$/u.test(name))
          .reverse()) {
          const previous = await this.read(name.slice(0, -5));
          if (
            previous &&
            previous.revision === this.revision &&
            ["failed", "cancelled", "interrupted"].includes(previous.state) &&
            JSON.stringify(previous.input) === JSON.stringify(normalizedInput)
          ) {
            resumeId = previous.resumeId ?? previous.id;
            break;
          }
        }
        job = {
          id,
          revision: this.revision,
          ...(resumeId ? { resumeId } : {}),
          owner: request.owner,
          input: normalizedInput,
          state: "queued",
          progress: { segment: 0, total: 0 },
        };
        await this.save(job);
        const abort = new AbortController();
        const receipt = job;
        const task = Promise.resolve()
          .then(async () => {
            try {
              receipt.state = "running";
              await this.save(receipt);
              receipt.result = await this.render(
                receipt.input,
                abort.signal,
                receipt.resumeId ?? id,
                async (progress) => {
                  receipt.progress = progress;
                  await this.save(receipt);
                },
              );
              receipt.state = "completed";
            } catch (error) {
              receipt.state = abort.signal.aborted ? "cancelled" : "failed";
              receipt.error =
                error instanceof Error ? error.message : "视频生成失败。";
            }
            await this.save(receipt);
          })
          .finally(() => {
            this.running.delete(id);
          });
        this.running.set(id, { abort, task });
        void task.catch(() => undefined);
        return job;
      });
      this.admission = task.catch(() => undefined);
      const {
        input: _,
        resumeId: _resume,
        revision: _revision,
        ...job
      } = await task;
      return structuredClone(job);
    }
    const entry = this.running.get(id);
    if (operation === "cancel") {
      entry?.abort.abort(new Error("视频作业已取消。"));
      await entry?.task;
    }
    if (operation === "wait" && entry) {
      await Promise.race([
        entry.task,
        delay(60_000, undefined, { signal, ref: false }),
      ]);
    }
    const receipt = await this.read(id);
    if (!receipt) throw new Error("视频作业不存在。");
    if (receipt.owner !== request.owner)
      throw new Error("视频作业不属于此运行。");
    if (
      ["queued", "running"].includes(receipt.state) &&
      !this.running.has(id)
    ) {
      receipt.state = "interrupted";
      await this.save(receipt);
    }
    const {
      input: _,
      resumeId: _resume,
      revision: _revision,
      ...job
    } = receipt;
    return job;
  }
  async cancelOwner(owner: string) {
    const tasks: Array<Promise<void>> = [];
    for (const [id, entry] of this.running) {
      if ((await this.read(id))?.owner !== owner) continue;
      entry.abort.abort(new Error("所属工作流已结束。"));
      tasks.push(entry.task);
    }
    await Promise.allSettled(tasks);
  }
  async close() {
    this.closed = true;
    await this.admission;
    for (const entry of this.running.values())
      entry.abort.abort(new Error("宿主关闭。"));
    await Promise.allSettled(
      [...this.running.values()].map((entry) => entry.task),
    );
  }
}
