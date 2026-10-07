import { randomInt, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { SubprocessRuntime } from "@deepseek-ai/dsh-subprocess";
import { z } from "zod";
import type { GeneratedArtifacts } from "../artifacts/generated.ts";
import type {
  ImageInput,
  LocalAIClient,
  LocalAIServiceId,
  MediaResult,
  ServiceStatus,
  TTSInput,
  VideoInput,
  ComfyWorkflowInput,
  ComfyWorkflowResult,
} from "./api.ts";
import { imageGraph, videoGraph } from "./graphs.ts";
import {
  comfyDirectories,
  executeWorkflow,
  isolateComfyLaunch,
  prepareWorkflow,
} from "./comfy.ts";
import { jsonValue } from "../schema.ts";
import {
  portOccupied,
  readJSON,
  readReferenceAudio,
  request,
  saveAudio,
} from "./http.ts";
import { acquireGpuLease } from "./ownership.ts";
import { launchOwned, type LaunchSpec, type OwnedProcess } from "./process.ts";

const seed = z
  .number()
  .int()
  .min(0)
  .max(2_147_483_647)
  .default(() => randomInt(2_147_483_647));
const prompt = z.string().trim().min(1).max(10_000);
const imageSchema = z
  .object({
    prompt,
    negative: z.string().max(10_000).default(""),
    seed,
    width: z.number().int().min(256).max(1536).multipleOf(16).default(1024),
    height: z.number().int().min(256).max(1536).multipleOf(16).default(1024),
    steps: z.number().int().min(1).max(50).default(30),
    cfg: z.number().min(1).max(10).default(4),
  })
  .refine(
    (v) => v.width * v.height <= 1328 * 1328,
    "图片总像素不能超过 1328×1328。",
  );
const videoSchema = z
  .object({
    prompt,
    firstFrameAssetId: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    lastFrameAssetId: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    seed,
    width: z.number().int().min(256).max(608).multipleOf(32).default(608),
    height: z.number().int().min(256).max(608).multipleOf(32).default(352),
    frames: z
      .number()
      .int()
      .min(22)
      .max(124)
      .default(39)
      .refine((v) => (v - 5) % 17 === 0, "帧数必须为 17k+5。"),
  })
  .refine(
    (v) => v.width * v.height <= 608 * 352,
    "视频总像素不能超过 608×352。",
  );
const ttsSchema = z
  .object({
    text: prompt,
    seed,
    mode: z
      .enum(["custom-voice", "voice-design", "voice-clone"])
      .default("custom-voice"),
    language: z
      .enum([
        "Auto",
        "Chinese",
        "English",
        "Japanese",
        "Korean",
        "German",
        "French",
        "Russian",
        "Portuguese",
        "Spanish",
        "Italian",
      ])
      .default("Auto"),
    speaker: z
      .enum([
        "Vivian",
        "Serena",
        "Uncle_Fu",
        "Dylan",
        "Eric",
        "Ryan",
        "Aiden",
        "Ono_Anna",
        "Sohee",
      ])
      .default("Vivian"),
    instruct: z.string().max(1000).optional(),
    voiceDescription: z.string().min(1).max(2000).optional(),
    referenceAudio: z.string().min(1).optional(),
    referenceText: z.string().max(10_000).optional(),
    xVectorOnly: z.boolean().default(false),
    maxNewTokens: z.number().int().min(16).max(8192).default(2048),
  })
  .superRefine((v, ctx) => {
    if (v.mode === "voice-design" && !v.voiceDescription)
      ctx.addIssue({
        code: "custom",
        message: "voice-design 需要 voiceDescription。",
      });
    if (
      v.mode === "voice-clone" &&
      (!v.referenceAudio || (!v.xVectorOnly && !v.referenceText?.trim()))
    )
      ctx.addIssue({
        code: "custom",
        message:
          "voice-clone 需要 referenceAudio 和 referenceText（或 xVectorOnly）。",
      });
  });

export interface Deployment {
  id: LocalAIServiceId;
  port: number;
  health: string;
  launch: LaunchSpec;
}
export function deployments(root: string, outputs: string): Deployment[] {
  const env = {
    PYTHONUTF8: "1",
    PYTHONUNBUFFERED: "1",
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
  };
  const image = join(root, "qwenimage", "ComfyUI");
  const video = join(root, "minimaxh3", "ComfyUI");
  const tts = join(root, "qwen3tts");
  return [
    {
      id: "qwen-image",
      port: 8190,
      health: "/system_stats",
      launch: {
        cwd: image,
        env,
        argv: [
          join(image, ".venv", "Scripts", "python.exe"),
          "main.py",
          "--listen",
          "127.0.0.1",
          "--port",
          "8190",
          "--lowvram",
          "--reserve-vram",
          "2",
          "--preview-method",
          "none",
          "--output-directory",
          outputs,
        ],
      },
    },
    {
      id: "minimax-h3",
      port: 8188,
      health: "/system_stats",
      launch: {
        cwd: video,
        env,
        argv: [
          join(video, ".venv311", "Scripts", "python.exe"),
          "main.py",
          "--listen",
          "127.0.0.1",
          "--port",
          "8188",
          "--reserve-vram",
          "1.0",
          "--cache-none",
          "--fast-disk",
          "--disable-pinned-memory",
          "--fp16-intermediates",
          "--use-sage-attention",
          "--output-directory",
          outputs,
        ],
      },
    },
    {
      id: "qwen3-tts",
      port: 8000,
      health: "/healthz",
      launch: {
        cwd: tts,
        env: {
          ...env,
          QWEN_TTS_HOST: "127.0.0.1",
          QWEN_TTS_PORT: "8000",
          QWEN_TTS_DEVICE: "cuda:0",
          QWEN_TTS_MODELS_DIR: join(tts, "models"),
          QWEN_TTS_API_KEY: randomUUID(),
          QWEN_TTS_TRUST_PROXY_HEADERS: "false",
        },
        argv: [
          join(tts, ".venv", "Scripts", "python.exe"),
          "-m",
          "qwen_tts_api.main",
        ],
      },
    },
  ];
}

interface Active {
  deployment: Deployment;
  process: OwnedProcess;
  release: () => void;
}
interface ManagerOptions {
  assets?: GeneratedArtifacts;
  root?: string;
  outputs?: string;
  deployments?: Deployment[];
  idleMs?: number;
  startupMs?: number;
  pollMs?: number;
  launch?: (spec: LaunchSpec) => OwnedProcess | Promise<OwnedProcess>;
  lease?: () => () => void;
}

/** A single GPU lane across direct calls, Flow steps and Agent tool scopes. */
export class LocalAIManager implements LocalAIClient {
  private active?: Active;
  private idle?: ReturnType<typeof setTimeout>;
  private tail: Promise<void> = Promise.resolve();
  private lifecycle = new AbortController();
  private options: ManagerOptions;
  private entries: Deployment[];
  private outputs: string;
  private spawn: (spec: LaunchSpec) => OwnedProcess | Promise<OwnedProcess>;
  private cwd: string;
  private assets?: GeneratedArtifacts;

  constructor(
    subprocess: SubprocessRuntime,
    cwd: string,
    options: ManagerOptions = {},
  ) {
    this.cwd = cwd;
    this.options = options;
    this.assets = options.assets;
    this.outputs = resolve(
      options.outputs ?? join(cwd, ".aura", "local-ai", "outputs"),
    );
    this.entries =
      options.deployments ??
      deployments(
        options.root ?? process.env.AURA_LOCAL_AI_ROOT ?? "D:/workflow/AI",
        this.outputs,
      );
    this.spawn = options.launch ?? ((spec) => launchOwned(subprocess, spec));
  }

  private async exclusive<T>(
    signal: AbortSignal,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const combined = AbortSignal.any([
      signal,
      this.lifecycle.signal,
      AbortSignal.timeout(600_000),
    ]);
    combined.throwIfAborted();
    const previous = this.tail;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tail = previous.then(() => gate);
    let aborted!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      aborted = () => reject(combined.reason);
      combined.addEventListener("abort", aborted, { once: true });
    });
    try {
      await Promise.race([previous, cancelled]);
      combined.throwIfAborted();
      return await work(combined);
    } finally {
      combined.removeEventListener("abort", aborted);
      release();
    }
  }

  private entry(id: LocalAIServiceId) {
    const entry = this.entries.find((d) => d.id === id);
    if (!entry) throw new Error("未知本地 AI 服务。");
    return entry;
  }
  private url(entry: Deployment) {
    return `http://127.0.0.1:${entry.port}`;
  }
  private async stop() {
    clearTimeout(this.idle);
    const active = this.active;
    if (!active) return;
    // Do not release the GPU lease if process teardown cannot establish quiescence.
    await active.process.stop();
    active.release();
    this.active = undefined;
  }
  private async ensure(
    id: LocalAIServiceId,
    signal: AbortSignal,
    override?: Deployment,
  ) {
    signal.throwIfAborted();
    if (override) await this.stop();
    if (this.active?.deployment.id === id && !this.active.process.exited) {
      if (
        await this.active.process.ownsPort(this.active.deployment.port, signal)
      )
        return this.active.deployment;
      await this.stop();
      throw new Error("本地 AI 监听端口不再属于受管进程。");
    }
    await this.stop();
    const deployment = override ?? this.entry(id);
    const release = (this.options.lease ?? acquireGpuLease)();
    try {
      for (const entry of this.entries) {
        if (await portOccupied(entry.port))
          throw new Error(
            `本地端口 ${entry.port} 被外部服务占用，请先手动停止；Aura 不接管或终止外部进程。`,
          );
      }
      await access(deployment.launch.argv[0]);
      await mkdir(this.outputs, { recursive: true, mode: 0o700 });
      signal.throwIfAborted();
      const child = await this.spawn(deployment.launch);
      this.active = { deployment, process: child, release };
      const deadline = AbortSignal.any([
        signal,
        AbortSignal.timeout(this.options.startupMs ?? 180_000),
      ]);
      while (true) {
        deadline.throwIfAborted();
        if (child.exited)
          throw new Error(`${id} 在就绪前退出，请检查部署和模型文件。`);
        let healthy = false;
        try {
          const health = await readJSON(
            await request(this.url(deployment) + deployment.health, deadline),
          );
          healthy =
            id === "qwen3-tts"
              ? z.object({ status: z.literal("prepared") }).safeParse(health)
                  .success
              : z
                  .object({
                    system: z.object({}).passthrough(),
                    devices: z.array(z.unknown()),
                  })
                  .safeParse(health).success;
        } catch {
          deadline.throwIfAborted();
        }
        if (healthy && !child.exited) {
          // A manually started server can win the bind race after our initial
          // port probe. Only send generation requests to a listener in our Job.
          if (!(await child.ownsPort(deployment.port, deadline)))
            throw new Error("本地 AI 监听端口不属于本次受管进程。");
          return deployment;
        }
        await delay(this.options.pollMs ?? 500, undefined, {
          signal: deadline,
        });
      }
    } catch (error) {
      if (this.active) await this.stop();
      else release();
      throw error;
    }
  }

  async service(
    id: LocalAIServiceId,
    operation: "status" | "start" | "stop",
    signal: AbortSignal,
  ): Promise<ServiceStatus> {
    const entry = this.entry(id);
    signal.throwIfAborted();
    if (operation !== "status")
      await this.exclusive(signal, async (signal) => {
        if (operation === "stop") {
          if (this.active?.deployment.id === id) await this.stop();
        } else if (operation === "start") {
          clearTimeout(this.idle);
          try {
            await this.ensure(id, signal);
            signal.throwIfAborted();
          } catch (error) {
            // A cancelled renewal must not strand a warm service without its timer.
            await this.stop();
            throw error;
          }
          this.idle = setTimeout(() => {
            void this.exclusive(this.lifecycle.signal, async () => {
              await this.stop();
            }).catch(() => undefined);
          }, this.options.idleMs ?? 60_000);
          this.idle.unref();
        } else throw new Error("未知本地 AI 操作。");
      });
    const managed =
      this.active?.deployment.id === id && !this.active.process.exited;
    return {
      service: id,
      state: managed
        ? "running"
        : (await portOccupied(entry.port))
          ? "external"
          : "stopped",
      url: this.url(entry),
      managed,
      idleTimeoutMs: this.options.idleMs ?? 60_000,
    };
  }

  private async generate<T>(
    id: LocalAIServiceId,
    signal: AbortSignal,
    work: (entry: Deployment, dir: string, signal: AbortSignal) => Promise<T>,
    isolatedComfy = false,
    setup?: (directory: string, signal: AbortSignal) => Promise<void>,
  ) {
    return this.exclusive(signal, async (signal) => {
      clearTimeout(this.idle);
      let directory: string | undefined;
      let success = false;
      try {
        await mkdir(this.outputs, { recursive: true, mode: 0o700 });
        directory = await mkdtemp(join(this.outputs, "job-"));
        let override: Deployment | undefined;
        if (isolatedComfy) {
          const entry = this.entry(id);
          const dirs = comfyDirectories(directory);
          await mkdir(dirs.input, { recursive: true });
          await mkdir(dirs.output, { recursive: true });
          await mkdir(dirs.temporary, { recursive: true });
          override = {
            ...entry,
            launch: isolateComfyLaunch(entry.launch, directory),
          };
        }
        await setup?.(directory, signal);
        const entry = await this.ensure(id, signal, override);
        const result = await work(entry, directory, signal);
        signal.throwIfAborted();
        success = true;
        return result;
      } finally {
        // Disconnecting TTS HTTP alone does not cancel its Python inference thread.
        // Always stop the owned process tree, including on success, before releasing GPU.
        await this.stop();
        if (
          directory &&
          relative(this.outputs, directory) === basename(directory)
        ) {
          if (!success) await rm(directory, { recursive: true, force: true });
          else if (isolatedComfy) {
            const dirs = comfyDirectories(directory);
            // Only task-local ComfyUI directories inside our mkdtemp job are disposable.
            await rm(dirs.input, { recursive: true, force: true });
            await rm(dirs.output, { recursive: true, force: true });
            await rm(dirs.temporary, { recursive: true, force: true });
          }
        }
      }
    });
  }

  async comfyWorkflow(
    input: ComfyWorkflowInput,
    signal: AbortSignal,
  ): Promise<ComfyWorkflowResult> {
    const prepared = await prepareWorkflow(input, this.cwd, signal);
    return this.generate(
      prepared.service,
      signal,
      async (entry, directory, signal) => {
        const result = {
          service: prepared.service,
          workflowHash: prepared.workflowHash,
          ...(await executeWorkflow({
            base: this.url(entry),
            graph: prepared.graph,
            outputNodeIds: prepared.outputNodeIds,
            directory,
            signal,
            exited: () => Boolean(this.active?.process.exited),
            pollMs: this.options.pollMs,
          })),
        };
        jsonValue(result, "ComfyUI 执行结果");
        return result;
      },
      true,
      prepared.imageBindings.length
        ? async (directory, signal) => {
            if (!this.assets) throw new Error("图片资产服务不可用。");
            const inputDirectory = comfyDirectories(directory).input;
            for (const binding of prepared.imageBindings)
              await this.assets.stageImage(
                binding.assetId,
                inputDirectory,
                signal,
                binding.resize,
              );
          }
        : undefined,
    );
  }

  async image(input: ImageInput, signal: AbortSignal): Promise<MediaResult> {
    const parsed = imageSchema.parse(input);
    const result = await this.comfyWorkflow(
      {
        service: "qwen-image",
        workflow: imageGraph(parsed, "image"),
        outputNodeIds: ["10"],
      },
      signal,
    );
    const imageAssetId =
      !input.deferAdmission && this.assets && result.files[0]
        ? (
            await this.assets.registerFile(
              result.files[0],
              signal,
              dirname(result.files[0]),
            )
          ).artifactId
        : undefined;
    return {
      service: result.service,
      seed: parsed.seed,
      files: result.files,
      ...(imageAssetId ? { imageAssetId } : {}),
    };
  }
  async video(input: VideoInput, signal: AbortSignal): Promise<MediaResult> {
    const parsed = videoSchema.parse(input);
    const result = await this.comfyWorkflow(
      {
        service: "minimax-h3",
        workflow: videoGraph(parsed, "video"),
        imageBindings: [
          ...(parsed.firstFrameAssetId
            ? [
                {
                  nodeId: "16",
                  assetId: parsed.firstFrameAssetId,
                  resize: { width: parsed.width, height: parsed.height },
                },
              ]
            : []),
          ...(parsed.lastFrameAssetId
            ? [
                {
                  nodeId: "17",
                  assetId: parsed.lastFrameAssetId,
                  resize: { width: parsed.width, height: parsed.height },
                },
              ]
            : []),
        ],
        outputNodeIds: ["15"],
      },
      signal,
    );
    return { service: result.service, seed: parsed.seed, files: result.files };
  }
  async tts(input: TTSInput, signal: AbortSignal): Promise<MediaResult> {
    const parsed = ttsSchema.parse(input);
    // Check the explicitly supplied reference before occupying GPU. Never delete it.
    if (parsed.mode === "voice-clone") {
      if (!isAbsolute(parsed.referenceAudio!))
        throw new Error("referenceAudio 必须是本地绝对路径。");
      const info = await stat(parsed.referenceAudio!);
      if (!info.isFile() || info.size > 30 * 1024 * 1024 || info.size < 1)
        throw new Error("参考音频必须是 1 字节至 30 MiB 的本地文件。");
    }
    return this.generate("qwen3-tts", signal, async (entry, dir, signal) => {
      const fields = {
        text: parsed.text,
        language: parsed.language,
        seed: parsed.seed,
        max_new_tokens: parsed.maxNewTokens,
      };
      let body: string | FormData;
      const headers: Record<string, string> = {
        Authorization: `Bearer ${entry.launch.env.QWEN_TTS_API_KEY}`,
      };
      if (parsed.mode === "voice-clone") {
        const reference = await readReferenceAudio(
          parsed.referenceAudio!,
          signal,
        );
        const form = new FormData();
        for (const [key, value] of Object.entries(fields))
          form.set(key, String(value));
        form.set(
          "reference_audio",
          new Blob([reference]),
          basename(parsed.referenceAudio!),
        );
        form.set("reference_text", parsed.referenceText ?? "");
        form.set("x_vector_only", String(parsed.xVectorOnly));
        body = form;
      } else {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify({
          ...fields,
          ...(parsed.mode === "voice-design"
            ? { voice_description: parsed.voiceDescription }
            : { speaker: parsed.speaker, instruct: parsed.instruct }),
        });
      }
      const response = await fetch(`${this.url(entry)}/v1/tts/${parsed.mode}`, {
        method: "POST",
        body,
        headers,
        signal,
        redirect: "error",
      });
      const path = join(dir, "speech.wav");
      await saveAudio(response, path, signal);
      return { service: entry.id, seed: parsed.seed, files: [path] };
    });
  }
  async close() {
    this.lifecycle.abort(new Error("Aura 本地 AI 管理器已关闭。"));
    clearTimeout(this.idle);
    await this.tail;
    await this.stop();
  }
}
