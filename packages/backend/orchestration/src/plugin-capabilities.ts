import { mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { FlowRun, JsonValue } from "@aura/protocol/types";
import type {
  AuraCapabilityClient,
  AuraCapabilityContext,
} from "./action-api.ts";
import {
  isCapabilityDefinition,
  type CapabilityHost,
  type CapabilityProvider,
} from "./capability-api.ts";
import { jsonValue } from "./schema.ts";
import type { GeneratedArtifacts } from "./generated-artifacts.ts";
import { inspectArtifact } from "./artifact-media.ts";
import type { CapabilityRoot } from "./types.ts";

const SETTLE_TIMEOUT_MS = 30_000;

interface OpenPlugin {
  key: string;
  providers: Map<string, CapabilityProvider>;
}

type Log = (level: "info" | "warn" | "error", message: string, data?: JsonValue) => void;

/** Host media ports shared with built-in producers. Optional so tests can omit them. */
export interface CapabilityMedia {
  artifacts: Pick<GeneratedArtifacts, "put" | "read">;
  saveImage(input: { data: Uint8Array; mediaType: "image/png" | "image/jpeg" | "image/webp"; name: string }): Promise<unknown>;
}

/**
 * Owns plugin-contributed capability providers. Providers open once per plugin
 * version and are not hot reloaded; a code change needs an Aura restart.
 */
export class PluginCapabilities implements AuraCapabilityClient {
  readonly #builtins: AuraCapabilityClient | undefined;
  readonly #dataRoot: string;
  readonly #log: Log;
  readonly #media: CapabilityMedia | undefined;
  readonly #plugins = new Map<string, OpenPlugin>();
  #runs: (id: string) => FlowRun | undefined = () => undefined;
  #allRuns: () => Iterable<FlowRun> = () => [];
  #operations: Promise<unknown> = Promise.resolve();

  constructor(options: {
    builtins?: AuraCapabilityClient;
    dataRoot: string;
    log?: Log;
    media?: CapabilityMedia;
  }) {
    this.#builtins = options.builtins;
    this.#dataRoot = options.dataRoot;
    this.#log = options.log ?? (() => undefined);
    this.#media = options.media;
  }

  /** Connects the Run store once the engine exists. */
  attachRuns(get: (id: string) => FlowRun | undefined, all: () => Iterable<FlowRun>) {
    this.#runs = get;
    this.#allRuns = all;
  }

  /** Opens providers of added or changed plugins and closes removed ones. */
  replace(roots: readonly CapabilityRoot[]): Promise<void> {
    const task = this.#operations.then(() => this.#replace(roots));
    this.#operations = task.catch(() => undefined);
    return task;
  }

  async #replace(roots: readonly CapabilityRoot[]) {
    const wanted = new Map<string, CapabilityRoot>();
    for (const root of roots) {
      if (!root.plugin) throw new Error("Capability root is missing plugin identity.");
      wanted.set(root.plugin.id, root);
    }
    for (const [id, open] of [...this.#plugins]) {
      const next = wanted.get(id);
      if (next && open.key === pluginKey(next)) continue;
      this.#plugins.delete(id);
      await closeAll(open.providers, this.#log);
    }
    for (const [id, root] of wanted) {
      if (this.#plugins.has(id)) continue;
      this.#plugins.set(id, { key: pluginKey(root), providers: await this.#open(root) });
    }
  }

  async #open(root: CapabilityRoot): Promise<Map<string, CapabilityProvider>> {
    const pluginId = root.plugin!.id;
    const dataDir = join(this.#dataRoot, pluginId);
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const providers = new Map<string, CapabilityProvider>();
    try {
      for (const local of (await readdir(root.root)).sort()) {
        const entry = resolve(root.root, local, `${local}.capability.js`);
        const module = (await import(pathToFileURL(entry).href)) as { default?: unknown };
        if (!isCapabilityDefinition(module.default))
          throw new Error(`${pluginId}/${local} must default-export defineCapability(...).`);
        const provider = await module.default.open(this.#host(pluginId, dataDir, root.settings));
        if (!provider || typeof provider.invoke !== "function")
          throw new Error(`${pluginId}/${local} open() must return a provider with invoke().`);
        providers.set(`${pluginId}/${local}`, provider);
      }
    } catch (error) {
      await closeAll(providers, this.#log);
      throw error;
    }
    return providers;
  }

  #host(pluginId: string, dataDir: string, settings: JsonValue | undefined): CapabilityHost {
    const owned = (run: FlowRun | undefined) =>
      run && run.flow.plugin?.id === pluginId ? structuredClone(run) : undefined;
    return Object.freeze({
      pluginId,
      dataDir,
      settings: settings === undefined ? undefined : structuredClone(settings),
      runs: Object.freeze({
        get: (id: string) => owned(this.#runs(id)),
        list: (filter: { flowId?: string; status?: readonly string[] } = {}) =>
          [...this.#allRuns()].filter((run) =>
            run.flow.plugin?.id === pluginId &&
            (!filter.flowId || run.flow.id === filter.flowId) &&
            (!filter.status || filter.status.includes(run.status)),
          ).map((run) => structuredClone(run)),
      }),
      invoke: (capability: string, operation: string, input: JsonValue, signal: AbortSignal) => {
        if (!this.#builtins || isPluginCapability(capability))
          throw new Error(`Aura host capability is unavailable: ${capability}`);
        return this.#builtins.invoke(capability, operation, input, signal);
      },
      artifacts: Object.freeze({
        put: (bytes: Uint8Array, signal: AbortSignal) => this.#requireMedia().artifacts.put(bytes, signal),
        read: (artifactId: string, signal: AbortSignal, limitBytes?: number) =>
          this.#requireMedia().artifacts.read(artifactId, signal, limitBytes),
      }),
      attachments: Object.freeze({
        image: async (bytes: Uint8Array, name: string) => {
          const media = await inspectArtifact(Buffer.from(bytes));
          if (media.kind !== "image") throw new Error("Attachment must be a PNG, JPEG or WebP image.");
          const saved = await this.#requireMedia().saveImage({
            data: bytes, mediaType: media.mimeType as "image/png" | "image/jpeg" | "image/webp", name,
          });
          return jsonValue(saved, "图片附件");
        },
      }),
      log: (level: "info" | "warn" | "error", message: string, data?: JsonValue) =>
        this.#log(level, `[${pluginId}] ${message}`, data),
    });
  }

  #requireMedia(): CapabilityMedia {
    if (!this.#media) throw new Error("Aura artifact storage is unavailable in this host.");
    return this.#media;
  }

  async invoke(
    capability: string,
    operation: string,
    input: JsonValue,
    signal: AbortSignal,
    context?: AuraCapabilityContext,
  ): Promise<JsonValue> {
    if (!isPluginCapability(capability)) {
      if (!this.#builtins)
        throw new Error(`Aura host capability is unavailable: ${capability}`);
      return this.#builtins.invoke(capability, operation, input, signal, context);
    }
    const provider = this.#plugins.get(capability.split("/")[0]!)?.providers.get(capability);
    if (!provider) throw new Error(`Aura host capability is unavailable: ${capability}`);
    signal.throwIfAborted();
    const run = context?.runId ? this.#runs(context.runId) : undefined;
    const output = await provider.invoke(operation, input, Object.freeze({
      signal,
      ...(context?.runId ? { runId: context.runId, rootRunId: run?.rootRunId ?? context.runId } : {}),
      ...(context?.stepId ? { stepId: context.stepId } : {}),
      ...(context?.idempotencyKey ? { idempotencyKey: context.idempotencyKey } : {}),
    }));
    return jsonValue(output, `${capability} 输出`);
  }

  /** Tells every provider of the Run's plugin that the root Run ended. Never throws. */
  async runSettled(run: FlowRun): Promise<void> {
    const pluginId = run.flow.plugin?.id;
    const open = pluginId ? this.#plugins.get(pluginId) : undefined;
    if (!open) return;
    await Promise.all([...open.providers].map(async ([id, provider]) => {
      if (!provider.runSettled) return;
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          Promise.resolve(provider.runSettled(structuredClone(run))),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("runSettled timed out")), SETTLE_TIMEOUT_MS);
          }),
        ]);
      } catch (error) {
        this.#log("error", `${id} runSettled failed`, { runId: run.id, message: String((error as Error)?.message ?? error) });
      } finally {
        clearTimeout(timer);
      }
    }));
  }

  async close(): Promise<void> {
    await this.#operations;
    const open = [...this.#plugins.values()];
    this.#plugins.clear();
    for (const plugin of open) await closeAll(plugin.providers, this.#log);
  }
}

/** Plugin-contributed IDs are `<plugin-id>/<local-id>`; built-ins never contain "/". */
export const isPluginCapability = (id: string) => id.includes("/");

function pluginKey(root: CapabilityRoot) {
  return JSON.stringify([resolve(root.root), root.plugin?.version, root.settings ?? null]);
}

async function closeAll(providers: Map<string, CapabilityProvider>, log: Log) {
  for (const [id, provider] of [...providers].reverse()) {
    try {
      await provider.close?.();
    } catch (error) {
      log("error", `${id} close failed`, { message: String((error as Error)?.message ?? error) });
    }
  }
  providers.clear();
}
