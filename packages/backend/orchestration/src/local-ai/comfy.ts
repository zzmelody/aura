import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, realpath, rename, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { JsonValue } from "@aura/protocol/types";
import { jsonValue } from "../schema.ts";
import type { ComfyWorkflowInput } from "./api.ts";
import type { LaunchSpec } from "./process.ts";
import { readJSON, request } from "./http.ts";

const limit = 256 * 1024;
const nodeId = z
  .string()
  .min(1)
  .max(128)
  .refine((s) => !["__proto__", "prototype", "constructor"].includes(s));
const graphSchema = z
  .record(
    nodeId,
    z
      .object({
        class_type: z.string().min(1).max(256),
        inputs: z.record(z.string(), z.json()),
      })
      .passthrough(),
  )
  .refine(
    (v) => Object.keys(v).length > 0 && Object.keys(v).length <= 512,
    "ComfyUI workflow 需要 1–512 个节点。",
  );
type Graph = z.infer<typeof graphSchema>;
const inputSchema = z
  .object({
    service: z.enum(["qwen-image", "minimax-h3"]),
    workflow: z.record(z.string(), z.unknown()).optional(),
    workflowFile: z.string().trim().min(1).optional(),
    overrides: z.record(nodeId, z.record(z.string(), z.json())).default({}),
    imageBindings: z
      .array(
        z
          .object({
            nodeId,
            assetId: z.string().regex(/^[a-f0-9]{64}$/u),
            resize: z
              .object({
                width: z.number().int().min(32).max(2048),
                height: z.number().int().min(32).max(2048),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .max(8)
      .default([]),
    outputNodeIds: z.array(nodeId).min(1).max(64).optional(),
  })
  .strict()
  .refine(
    (v) => (v.workflow !== undefined) !== (v.workflowFile !== undefined),
    "workflow 和 workflowFile 必须且只能提供一个。",
  );

async function readWorkflow(
  path: string,
  signal: AbortSignal,
): Promise<unknown> {
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 1 || info.size > limit)
      throw new Error(
        "ComfyUI workflow 文件必须是 1 字节至 256 KiB 的 JSON 文件。",
      );
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(buffer, size, buffer.length - size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > limit) throw new Error("ComfyUI workflow 文件超过 256 KiB。");
    return JSON.parse(
      buffer
        .subarray(0, size)
        .toString("utf8")
        .replace(/^\uFEFF/, ""),
    ) as unknown;
  } finally {
    await file.close();
  }
}

/** Snapshot before queue admission: edits affect the next invocation, never this one. */
export async function prepareWorkflow(
  input: ComfyWorkflowInput,
  cwd: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const parsed = inputSchema.parse(jsonValue(input, "ComfyUI 入参"));
  const source =
    parsed.workflow ??
    (await readWorkflow(resolve(cwd, parsed.workflowFile!), signal));
  const value = jsonValue(source, "ComfyUI workflow");
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("ComfyUI workflow 必须是 API 格式对象。");
  if (Array.isArray(value.nodes))
    throw new Error(
      "这是 ComfyUI 界面画布格式，请导出 API 格式（节点包含 class_type 和 inputs）。",
    );
  const wrapped =
    value.prompt &&
    typeof value.prompt === "object" &&
    !Array.isArray(value.prompt) &&
    !Object.hasOwn(value.prompt, "class_type");
  const graph = graphSchema.parse(wrapped ? value.prompt : value);
  for (const [id, inputs] of Object.entries(parsed.overrides)) {
    if (!Object.hasOwn(graph, id))
      throw new Error(`ComfyUI 覆盖参数引用未知节点：${id}`);
    for (const [name, value] of Object.entries(inputs)) {
      if (!Object.hasOwn(graph[id].inputs, name))
        throw new Error(`ComfyUI 节点 ${id} 不存在输入：${name}`);
      // defineProperty prevents __proto__ setters even in trusted JSON input maps.
      Object.defineProperty(graph[id].inputs, name, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  const boundNodes = new Set<string>();
  for (const binding of parsed.imageBindings) {
    const node = graph[binding.nodeId];
    if (
      !node ||
      node.class_type !== "LoadImage" ||
      !Object.hasOwn(node.inputs, "image")
    )
      throw new Error(
        `图片绑定必须指向已有的 LoadImage.image 节点：${binding.nodeId}`,
      );
    if (boundNodes.has(binding.nodeId))
      throw new Error(`同一 LoadImage 节点不能重复绑定图片：${binding.nodeId}`);
    boundNodes.add(binding.nodeId);
    node.inputs.image = `${binding.assetId}${binding.resize ? `-${binding.resize.width}x${binding.resize.height}` : ""}.png`;
  }
  const outputNodeIds = parsed.outputNodeIds
    ? [...new Set(parsed.outputNodeIds)]
    : undefined;
  for (const id of outputNodeIds ?? []) {
    if (!Object.hasOwn(graph, id))
      throw new Error(`ComfyUI 输出节点不存在：${id}`);
  }
  // Re-check the combined graph after replacements, including its byte budget.
  const snapshot = jsonValue(graph, "ComfyUI 执行图");
  const workflowHash = createHash("sha256")
    .update(JSON.stringify(snapshot))
    .digest("hex");
  return {
    service: parsed.service,
    graph,
    outputNodeIds,
    workflowHash,
    imageBindings: parsed.imageBindings,
  };
}

export function comfyDirectories(directory: string) {
  return {
    input: join(directory, "comfy-input"),
    output: join(directory, "comfy-output"),
    temporary: join(directory, "comfy-temp"),
    artifacts: join(directory, "artifacts"),
  };
}
export function isolateComfyLaunch(
  launch: LaunchSpec,
  directory: string,
): LaunchSpec {
  const dirs = comfyDirectories(directory);
  const argv: string[] = [];
  for (let i = 0; i < launch.argv.length; i++) {
    if (
      ["--input-directory", "--output-directory", "--temp-directory"].includes(
        launch.argv[i],
      )
    ) {
      i++;
      continue;
    }
    argv.push(launch.argv[i]);
  }
  argv.push(
    "--input-directory",
    dirs.input,
    "--output-directory",
    dirs.output,
    "--temp-directory",
    dirs.temporary,
  );
  return { ...launch, argv };
}

function inside(root: string, path: string) {
  const rel = relative(root, path);
  return Boolean(
    rel &&
    !isAbsolute(rel) &&
    rel !== ".." &&
    !rel.startsWith("..\\") &&
    !rel.startsWith("../"),
  );
}

/** Preserve saved and preview artifacts before ComfyUI's temp cleanup on exit. */
export async function collectOutputs(
  raw: unknown,
  directory: string,
  outputNodeIds: string[] | undefined,
  signal: AbortSignal,
) {
  const dirs = comfyDirectories(directory);
  const outputs = z
    .record(z.string(), z.json())
    .parse(jsonValue(raw, "ComfyUI outputs"));
  const selected = outputNodeIds ?? Object.keys(outputs);
  const result: Record<string, JsonValue> = {};
  const files: string[] = [];
  const moved = new Map<string, string>();
  let bytes = 0;
  await mkdir(dirs.artifacts, { recursive: true, mode: 0o700 });
  const jobRoot = await realpath(directory);
  async function visit(value: JsonValue, depth = 0): Promise<JsonValue> {
    signal.throwIfAborted();
    if (depth > 64) throw new Error("ComfyUI outputs 嵌套过深。");
    if (Array.isArray(value)) {
      const items: JsonValue[] = [];
      for (const item of value) items.push(await visit(item, depth + 1));
      return items;
    }
    if (!value || typeof value !== "object") return value;
    if (
      typeof value.filename === "string" &&
      ["output", "temp"].includes(String(value.type))
    ) {
      const descriptor = z
        .object({
          filename: z.string().min(1),
          subfolder: z.string().default(""),
          type: z.enum(["output", "temp"]),
        })
        .parse(value);
      const root =
        descriptor.type === "output"
          ? dirs.output
          : join(dirs.temporary, "temp");
      const source = resolve(root, descriptor.subfolder, descriptor.filename);
      if (!inside(root, source))
        throw new Error("ComfyUI 输出越过本次任务目录。");
      let path = moved.get(source);
      if (!path) {
        const actual = await realpath(source);
        const actualRoot = await realpath(root);
        if (!inside(jobRoot, actualRoot) || !inside(actualRoot, actual))
          throw new Error("ComfyUI 输出越过本次任务目录。");
        const info = await stat(actual);
        bytes += info.size;
        if (
          !info.isFile() ||
          info.size < 1 ||
          info.size > 512 * 1024 * 1024 ||
          bytes > 1024 * 1024 * 1024 ||
          files.length >= 64
        )
          throw new Error(
            "ComfyUI 产物超限：最多 64 个文件、单文件 512 MiB、总计 1 GiB。",
          );
        path = join(dirs.artifacts, `${files.length + 1}-${basename(source)}`);
        await rename(actual, path);
        moved.set(source, path);
        files.push(path);
      }
      return { ...value, path };
    }
    const entries: Array<[string, JsonValue]> = [];
    for (const [key, item] of Object.entries(value))
      entries.push([key, await visit(item, depth + 1)]);
    return Object.fromEntries(entries);
  }
  for (const id of selected) {
    if (!Object.hasOwn(outputs, id))
      throw new Error(`ComfyUI 节点 ${id} 没有返回 UI 输出。`);
    Object.defineProperty(result, id, {
      value: await visit(outputs[id]),
      enumerable: true,
    });
  }
  return { files, outputs: result };
}

export async function executeWorkflow(options: {
  base: string;
  graph: Graph;
  outputNodeIds?: string[];
  directory: string;
  signal: AbortSignal;
  exited: () => boolean;
  pollMs?: number;
}) {
  const { base, graph, directory, outputNodeIds, signal } = options;
  const promptId = randomUUID();
  try {
    const accepted = z.object({ prompt_id: z.string() }).parse(
      await readJSON(
        await request(base + "/prompt", signal, {
          prompt: graph,
          prompt_id: promptId,
          client_id: randomUUID(),
        }),
      ),
    );
    if (accepted.prompt_id !== promptId)
      throw new Error("ComfyUI 未接受指定的任务 ID。");
    while (true) {
      signal.throwIfAborted();
      if (options.exited()) throw new Error("ComfyUI 在执行 workflow 时退出。");
      const history = z
        .record(
          z.string(),
          z.object({
            status: z.object({
              status_str: z.string(),
              completed: z.boolean(),
            }),
            outputs: z.record(z.string(), z.unknown()),
          }),
        )
        .parse(
          await readJSON(await request(`${base}/history/${promptId}`, signal)),
        );
      const run = history[promptId];
      if (run?.status.status_str === "error")
        throw new Error(
          "ComfyUI 生成失败，请检查 workflow、节点、模型和显存。",
        );
      if (run?.status.completed)
        return {
          promptId,
          ...(await collectOutputs(
            run.outputs,
            directory,
            outputNodeIds,
            signal,
          )),
        };
      await delay(options.pollMs ?? 1_000, undefined, { signal });
    }
  } catch (error) {
    const cleanup = AbortSignal.timeout(2_000);
    await Promise.allSettled([
      request(base + "/queue", cleanup, { delete: [promptId] }).then((r) =>
        r.body?.cancel(),
      ),
      request(base + "/interrupt", cleanup, { prompt_id: promptId }).then((r) =>
        r.body?.cancel(),
      ),
    ]);
    throw error;
  }
}
