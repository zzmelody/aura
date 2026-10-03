import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import sharp from "sharp";
import { z } from "zod";
import type { Context } from "@deepseek-ai/cordis";
import type { JsonValue } from "@aura/protocol/types";
import { ActionFailure, type AuraCapabilityClient } from "./action-api.ts";
import type { GeneratedArtifacts } from "./generated-artifacts.ts";

export const VEYA_MATERIAL_MAKER_CAPABILITY = "aura.veya.material-maker";
export const MATERIAL_MAKER_VERSION = "1.7";
const MAX_PTEX_BYTES = 256 * 1024;
const MAX_NODES = 32;
const MAX_CONNECTIONS = 64;
const MAP_SIZE = 2048;
const MAP_BYTES = 32 * 1024 * 1024;

export const ALLOWED_NODE_TYPES = [
  "blend", "bricks", "buffer", "colorize", "combine", "fbm", "graph", "invert",
  "kaleidoscope", "material", "math", "mirror", "normal_map", "pattern", "perlin",
  "quantize", "rotate", "scale", "shader", "shape", "tile2x2", "tiler", "tones_range",
  "transform", "transform2", "translate", "uniform", "uniform_greyscale",
] as const;

const FORBIDDEN_KEYS = new Set([
  "shader_model", "code", "global", "instance", "preview_shader", "custom", "exports",
  "website", "remote",
]);

const inputSchema = z.object({
  generationKey: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  ptex: z.record(z.string(), z.unknown()),
}).strict();

type MaterialPreviewAttachments = Pick<Context["attachments"], "saveImage">;

export interface MaterialMakerPort {
  bake(input: { ptexPath: string; outputDir: string; executable: string }, signal: AbortSignal): Promise<{ exitCode: number | null }>;
}

export function validatePtex(value: unknown): { ok: true; graph: Record<string, unknown> } | { ok: false; reason: string } {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { ok: false, reason: "ptex must be a graph object." };
  const encoded = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (encoded > MAX_PTEX_BYTES) return { ok: false, reason: "ptex exceeds 256 KiB." };
  try {
    walk(value, 0);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "ptex is invalid." };
  }
  return { ok: true, graph: value as Record<string, unknown> };
}

function walk(node: unknown, depth: number, materials = { count: 0 }): void {
  if (depth > 8) throw new Error("ptex nesting exceeds the limit.");
  if (!node || typeof node !== "object" || Array.isArray(node)) throw new Error("ptex nodes must be objects.");
  const record = node as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_KEYS.has(key) || key === "image") throw new Error(`ptex must not contain ${key}.`);
  }
  const type = record.type;
  if (typeof type !== "string" || !(ALLOWED_NODE_TYPES as readonly string[]).includes(type))
    throw new Error(`unsupported node type ${String(type)}.`);
  if (type === "material") materials.count += 1;
  const nodes = record.nodes;
  if (nodes !== undefined) {
    if (!Array.isArray(nodes) || nodes.length > MAX_NODES) throw new Error("ptex nodes exceed the 32-node limit.");
    for (const child of nodes) walk(child, depth + 1, materials);
  }
  const connections = record.connections;
  if (connections !== undefined) {
    if (!Array.isArray(connections) || connections.length > MAX_CONNECTIONS) throw new Error("ptex connections exceed the 64-connection limit.");
    for (const item of connections) {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("connections must be objects.");
      const link = item as Record<string, unknown>;
      if (typeof link.from !== "string" || typeof link.to !== "string") throw new Error("connections require from/to names.");
    }
  }
  if (depth === 0 && materials.count !== 1) throw new Error("ptex must contain exactly one material node.");
}

function defaultPort(): MaterialMakerPort {
  return {
    async bake({ ptexPath, outputDir, executable }, signal) {
      return await new Promise((resolve, reject) => {
        const child = spawn(executable, [
          "--export-material", "--target", "Godot/Godot 4 Standard", "-o", outputDir, ptexPath,
        ], { windowsHide: true, cwd: dirname(executable), stdio: ["ignore", "pipe", "pipe"] });
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new ActionFailure("bake_failed: Material Maker exceeded 120 seconds."));
        }, 120_000);
        const abort = () => child.kill("SIGKILL");
        signal.addEventListener("abort", abort, { once: true });
        child.on("error", (error) => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(error); });
        child.on("close", (exitCode) => { clearTimeout(timer); signal.removeEventListener("abort", abort); resolve({ exitCode }); });
      });
    },
  };
}

/**
 * VEYA_MATERIAL_MAKER overrides; otherwise use the pinned build produced by the
 * Veya project's tools/build-material-maker.ps1. Returns "" when neither exists.
 */
export function resolveMaterialMakerExecutable(veyaProjectRoots: readonly string[], env = process.env): string {
  if (env.VEYA_MATERIAL_MAKER) return env.VEYA_MATERIAL_MAKER;
  for (const root of veyaProjectRoots) {
    try {
      // Bundled plugin: aura/app/plugins/veya; source baker: aura/material-maker.
      const bundled = join(root, "..", "..", "material-maker");
      const name = process.platform === "win32" ? "material_maker.exe" : "material_maker";
      if (existsSync(join(bundled, "BUILD_OK")) && existsSync(join(bundled, name))) return join(bundled, name);
      const pin = JSON.parse(readFileSync(join(root, "tools", "material-maker-dependency.json"), "utf8")) as { commit?: unknown };
      if (typeof pin.commit !== "string" || !/^[a-f0-9]{40}$/u.test(pin.commit)) continue;
      const output = join(root, "build", "material-maker", pin.commit);
      const executable = join(output, process.platform === "win32" ? "material_maker.exe" : "material_maker");
      if (existsSync(join(output, "BUILD_OK")) && existsSync(executable)) return executable;
    } catch { /* Not a Veya project root. */ }
  }
  return "";
}

/** A local plugin root such as F:/creative/aura-plugin sits inside its Veya project. */
export function veyaProjectRootsFromPlugins(pluginRoots: readonly (string | undefined)[]): string[] {
  return [...new Set(pluginRoots.filter((root): root is string => Boolean(root)).map((root) => dirname(root)))];
}

export class VeyaMaterialMakerCapability implements AuraCapabilityClient {
  private readonly artifacts: GeneratedArtifacts;
  private readonly attachments: MaterialPreviewAttachments;
  private readonly port: MaterialMakerPort;
  private readonly executable: string;
  private readonly projectRoot?: string;

  constructor(
    artifacts: GeneratedArtifacts,
    attachments: MaterialPreviewAttachments,
    port?: MaterialMakerPort,
    executable = process.env.VEYA_MATERIAL_MAKER ?? "",
    projectRoot?: string,
  ) {
    this.artifacts = artifacts;
    this.attachments = attachments;
    this.port = port ?? defaultPort();
    this.executable = executable;
    this.projectRoot = projectRoot;
  }

  async invoke(capability: string, operation: string, input: JsonValue, signal: AbortSignal): Promise<JsonValue> {
    if (capability !== VEYA_MATERIAL_MAKER_CAPABILITY || !["bake","capabilities"].includes(operation))
      throw new Error("Unsupported Veya material-maker capability operation.");
    if(operation==="capabilities")return {available:Boolean(this.executable)&&existsSync(this.executable),version:MATERIAL_MAKER_VERSION,mapSize:MAP_SIZE,maxNodes:MAX_NODES,maxConnections:MAX_CONNECTIONS};
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) throw new ActionFailure("invalid_material_request: generationKey/ptex is invalid.");
    const admitted = validatePtex(parsed.data.ptex);
    if (!admitted.ok) return { status: "ptex_invalid", reason: admitted.reason };
    const ptexBytes = Buffer.from(JSON.stringify(admitted.graph));
    const ptexSha256 = createHash("sha256").update(ptexBytes).digest("hex");
    const cached = await this.loadCache(parsed.data.generationKey, ptexSha256);
    if (cached) return cached;
    if (!this.executable) return { status: "bake_failed", reason: "VEYA_MATERIAL_MAKER is not configured.", ptexSha256 };
    const work = await mkdtemp(join(tmpdir(), "veya-material-maker-"));
    try {
      const ptexPath = join(work, "material.ptex");
      const outputDir = join(work, "out");
      await mkdir(outputDir, { recursive: true, mode: 0o700 });
      await writeFile(ptexPath, ptexBytes);
      try {
        await this.port.bake({ ptexPath, outputDir, executable: this.executable }, signal);
      } catch (error) {
        signal.throwIfAborted();
        return { status: "bake_failed", reason: error instanceof Error ? error.message.slice(0, 400) : "bake failed", ptexSha256 };
      }
      const prefix = join(outputDir, "material");
      const maps: Record<string, JsonValue> = {};
      for (const [slot, suffix] of [
        ["albedo", "_albedo.png"], ["orm", "_orm.png"], ["normal", "_normal.png"],
        ["emission", "_emission.png"], ["height", "_heightmap.png"],
      ] as const) {
        let bytes: Buffer;
        try { bytes = await readFile(prefix + suffix); } catch { continue; }
        if (bytes.length > MAP_BYTES) return { status: "bake_failed", reason: `${slot} PNG exceeds 32 MiB.`, ptexSha256 };
        const metadata = await sharp(bytes, { limitInputPixels: MAP_SIZE * MAP_SIZE, failOn: "error" }).metadata();
        if (metadata.format !== "png" || metadata.width !== MAP_SIZE || metadata.height !== MAP_SIZE)
          return { status: "bake_failed", reason: `${slot} PNG must be a 2048 PNG.`, ptexSha256 };
        const registered = await this.artifacts.registerImage(bytes, signal);
        maps[slot] = { artifactId: registered.artifactId, sha256: registered.artifactId, bytes: bytes.length, width: MAP_SIZE, height: MAP_SIZE };
      }
      if (!maps.albedo) return { status: "bake_failed", reason: "Material Maker did not write an albedo PNG.", ptexSha256 };
      let preview: JsonValue | undefined;
      try {
        const albedoBytes = await readFile(prefix + "_albedo.png");
        preview = await this.attachments.saveImage({
          data: albedoBytes, mediaType: "image/png",
          name: `veya-material-${(maps.albedo as { artifactId: string }).artifactId}.png`,
        }) as unknown as JsonValue;
      } catch { /* Preview attachment is optional; maps remain the production source. */ }
      const result = { status: "ready", ptexSha256, materialMakerVersion: MATERIAL_MAKER_VERSION, maps, ...(preview ? { preview } : {}) };
      await this.saveCache(parsed.data.generationKey, ptexSha256, result);
      return result;
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  private cachePath(generationKey: string) {
    return join(this.projectRoot ?? "", ".aura", "material-bakes", `${generationKey}.json`);
  }

  private async loadCache(generationKey: string | undefined, ptexSha256: string): Promise<JsonValue | undefined> {
    if (!generationKey || !this.projectRoot) return undefined;
    try {
      const saved = JSON.parse(await readFile(this.cachePath(generationKey), "utf8")) as { ptexSha256?: string; result?: JsonValue };
      if (saved.ptexSha256 && saved.ptexSha256 !== ptexSha256)
        throw new ActionFailure("material_identity_conflict: Changed graph cannot reuse the same bake key.");
      if (saved.result && typeof saved.result === "object" && !Array.isArray(saved.result) && (saved.result as { status?: string }).status === "ready")
        return saved.result;
    } catch (error) {
      if (error instanceof ActionFailure) throw error;
    }
    return undefined;
  }

  private async saveCache(generationKey: string | undefined, ptexSha256: string, result: JsonValue) {
    if (!generationKey || !this.projectRoot) return;
    const path = this.cachePath(generationKey);
    await mkdir(join(this.projectRoot, ".aura", "material-bakes"), { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify({ ptexSha256, result }));
  }
}
