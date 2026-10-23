import type {
  PluginWorkflows,
  PluginTaskTool,
  PluginServices,
} from "./backend-api.ts";
import type { PluginDomainStorage } from "./plugin-storage.ts";
import { mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
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
import type { GeneratedArtifacts } from "./artifacts/generated.ts";
import { inspectArtifact } from "./artifacts/media.ts";
import type { CapabilityRoot } from "./types.ts";
import { hashContribution } from "./contribution-hash.ts";
import { PluginModules } from "./plugin-modules.ts";

const SETTLE_TIMEOUT_MS = 30_000;

interface OpenPlugin {
  key: string;
  providers: Map<string, CapabilityProvider>;
  active: number;
  root: CapabilityRoot;
}

type Log = (
  level: "info" | "warn" | "error",
  message: string,
  data?: JsonValue,
) => void;

/** Host media ports shared with built-in producers. Optional so tests can omit them. */
export interface CapabilityMedia {
  artifacts: Pick<GeneratedArtifacts, "put" | "read">;
  saveImage(input: {
    data: Uint8Array;
    mediaType: "image/png" | "image/jpeg" | "image/webp";
    name: string;
  }): Promise<unknown>;
}

/**
 * Owns provider revisions. Automatic replacement waits for calls and Runs to
 * finish; a failed candidate leaves the previous providers available.
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
  readonly #modules = new PluginModules();
  #roots: readonly CapabilityRoot[] = [];
  #closed = false;
  readonly #retired: Array<[string, OpenPlugin]> = [];
  readonly #backend:
    | {
        storage: PluginDomainStorage;
        artifacts: GeneratedArtifacts;
        cwd: string;
        workflows: PluginWorkflows;
      }
    | undefined;
  #refresh: Promise<void> | undefined;
  readonly #warnings = new Set<string>();

  constructor(options: {
    builtins?: AuraCapabilityClient;
    dataRoot: string;
    log?: Log;
    media?: CapabilityMedia;
    backend?: {
      storage: PluginDomainStorage;
      artifacts: GeneratedArtifacts;
      cwd: string;
      workflows: PluginWorkflows;
    };
  }) {
    this.#builtins = options.builtins;
    this.#dataRoot = options.dataRoot;
    this.#log = options.log ?? (() => undefined);
    this.#media = options.media;
    this.#backend = options.backend;
  }

  /** Connects the Run store once the engine exists. */
  attachRuns(
    get: (id: string) => FlowRun | undefined,
    all: () => Iterable<FlowRun>,
  ) {
    this.#runs = get;
    this.#allRuns = all;
  }

  /** Opens providers of added or changed plugins and closes removed ones. */
  replace(roots: readonly CapabilityRoot[]): Promise<void> {
    const task = this.#operations.then(async () => {
      if (this.#closed) throw new Error("plugin_providers_closed");
      await this.#replace(roots);
      this.#roots = structuredClone(roots);
    });
    this.#operations = task.catch(() => undefined);
    return task;
  }

  /** Coalesced scan of enabled roots; never modifies plugins.json. */
  refresh(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#refresh) return this.#refresh;
    const task = this.#operations.then(() => this.#replace(this.#roots, true));
    this.#operations = task.catch(() => undefined);
    this.#refresh = task.finally(() => {
      this.#refresh = undefined;
    });
    return this.#refresh;
  }

  #busy(id: string, open: OpenPlugin) {
    return (
      open.active > 0 ||
      [...this.#allRuns()].some(
        (run) =>
          (run.flow.plugin?.id === id ||
            (!run.flow.plugin &&
              Boolean(open.root.compatibility?.flows?.[run.flow.id]))) &&
          !["completed", "failed", "cancelled", "interrupted"].includes(
            run.status,
          ),
      )
    );
  }

  async #activity<T>(
    pluginId: string | undefined,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    const open = pluginId ? this.#plugins.get(pluginId) : undefined;
    if (open) open.active++;
    try {
      return await operation();
    } finally {
      if (open) open.active--;
    }
  }

  async #replace(roots: readonly CapabilityRoot[], automatic = false) {
    const wanted = new Map<string, CapabilityRoot>();
    for (const root of roots) {
      if (!root.plugin)
        throw new Error("Capability root is missing plugin identity.");
      wanted.set(root.plugin.id, root);
    }
    const candidates = new Map<string, OpenPlugin>();
    try {
      for (const [id, root] of wanted) {
        const previous = this.#plugins.get(id);
        if (automatic && previous && this.#busy(id, previous)) continue;
        try {
          const hash = await hashContribution(root.root, root.pluginRoot);
          const key = `${pluginKey(root)}:${hash}`;
          if (previous?.key === key) continue;
          if (
            this.#retired.some(
              ([owner, open]) => owner === id && this.#busy(owner, open),
            )
          )
            throw new Error("plugin_backend_busy");
          if (previous && this.#busy(id, previous))
            throw new Error("plugin_backend_busy");
          const providers = await this.#open(root, hash);
          if (automatic && previous && this.#busy(id, previous)) {
            await closeAll(providers, this.#log);
            continue;
          }
          candidates.set(id, { key, providers, active: 0, root });
          this.#warnings.delete(id);
        } catch (error) {
          if (!automatic) throw error;
          if (!this.#warnings.has(id)) {
            this.#warnings.add(id);
            this.#log("warn", `${id} 更新失败，继续使用上一版 provider。`);
          }
        }
      }
    } catch (error) {
      for (const candidate of candidates.values())
        await closeAll(candidate.providers, this.#log);
      throw error;
    }
    for (const [id, open] of [...this.#plugins]) {
      if (wanted.has(id) && !candidates.has(id)) continue;
      if (candidates.has(id)) this.#plugins.set(id, candidates.get(id)!);
      else this.#plugins.delete(id);
      if (this.#busy(id, open)) this.#retired.push([id, open]);
      else await closeAll(open.providers, this.#log);
    }
    for (const [id, candidate] of candidates) this.#plugins.set(id, candidate);
    for (const retired of [...this.#retired]) {
      if (!this.#busy(...retired)) {
        await closeAll(retired[1].providers, this.#log);
        this.#retired.splice(this.#retired.indexOf(retired), 1);
      }
    }
  }

  async #open(
    root: CapabilityRoot,
    hash: string,
  ): Promise<Map<string, CapabilityProvider>> {
    const pluginId = root.plugin!.id;
    const dataDir = join(this.#dataRoot, pluginId);
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const providers = new Map<string, CapabilityProvider>();
    try {
      for (const local of (await readdir(root.root)).sort()) {
        const entry = resolve(root.root, local, `${local}.capability.js`);
        const module = (await this.#modules.import(
          entry,
          root.pluginRoot ?? root.root,
          hash,
        )) as {
          default?: unknown;
        };
        if (!isCapabilityDefinition(module.default))
          throw new Error(
            `${pluginId}/${local} must default-export defineCapability(...).`,
          );
        const provider = await module.default.open(
          this.#host(pluginId, dataDir, root),
        );
        if (!provider || typeof provider.invoke !== "function")
          throw new Error(
            `${pluginId}/${local} open() must return a provider with invoke().`,
          );
        providers.set(`${pluginId}/${local}`, provider);
        if (
          provider.requests &&
          (!provider.requests.prefixes.length ||
            !provider.requests.prefixes.every(
              (prefix) =>
                root.compatibility?.rpcPrefixes?.includes(prefix) ||
                prefix.startsWith(`${pluginId}/`),
            ))
        )
          throw new Error("plugin_request_forbidden");
      }
    } catch (error) {
      await closeAll(providers, this.#log);
      throw error;
    }
    return providers;
  }

  #host(
    pluginId: string,
    dataDir: string,
    root: CapabilityRoot,
  ): CapabilityHost {
    const backend = this.#backend;
    const settings = root.settings;
    const owns = (run: FlowRun) =>
      run.flow.plugin?.id === pluginId ||
      (!run.flow.plugin && Boolean(root.compatibility?.flows?.[run.flow.id]));
    const owned = (run: FlowRun | undefined) =>
      run && owns(run) ? structuredClone(run) : undefined;
    return Object.freeze({
      pluginId,
      dataDir,
      workspace: Object.freeze({ cwd: this.#backend?.cwd ?? dataDir }),
      get storage() {
        if (!backend) throw new Error("plugin_storage_unavailable");
        return backend.storage.forPlugin(pluginId, root.compatibility);
      },
      get media() {
        if (!backend) throw new Error("plugin_media_unavailable");
        return backend.artifacts;
      },
      get workflows() {
        if (!backend) throw new Error("plugin_workflows_unavailable");
        return Object.freeze({
          start: (input: unknown) => {
            const flowId =
              input && typeof input === "object" && "flowId" in input
                ? input.flowId
                : undefined;
            if (
              typeof flowId !== "string" ||
              (!flowId.startsWith(`${pluginId}/`) &&
                !root.compatibility?.flows?.[flowId])
            )
              throw new Error("plugin_workflow_forbidden");
            return backend.workflows.start(input);
          },
          get: (id: string) => {
            const run = backend.workflows.get(id);
            if (!owns(run)) throw new Error("plugin_workflow_forbidden");
            return structuredClone(run);
          },
          runs: {
            entries: function* () {
              for (const [id, run] of backend.workflows.runs.entries())
                if (owns(run))
                  yield [id, structuredClone(run)] as [string, FlowRun];
            },
          },
        });
      },
      settings: settings === undefined ? undefined : structuredClone(settings),
      runs: Object.freeze({
        get: (id: string) => owned(this.#runs(id)),
        list: (filter: { flowId?: string; status?: readonly string[] } = {}) =>
          [...this.#allRuns()]
            .filter(
              (run) =>
                owns(run) &&
                (!filter.flowId || run.flow.id === filter.flowId) &&
                (!filter.status || filter.status.includes(run.status)),
            )
            .map((run) => structuredClone(run)),
      }),
      invoke: (
        capability: string,
        operation: string,
        input: JsonValue,
        signal: AbortSignal,
      ) => {
        if (!this.#builtins || isPluginCapability(capability))
          throw new Error(`Aura host capability is unavailable: ${capability}`);
        return this.#builtins.invoke(capability, operation, input, signal);
      },
      artifacts: Object.freeze({
        put: (bytes: Uint8Array, signal: AbortSignal) =>
          this.#requireMedia().artifacts.put(bytes, signal),
        read: (artifactId: string, signal: AbortSignal, limitBytes?: number) =>
          this.#requireMedia().artifacts.read(artifactId, signal, limitBytes),
      }),
      attachments: Object.freeze({
        image: async (bytes: Uint8Array, name: string) => {
          const media = await inspectArtifact(Buffer.from(bytes));
          if (media.kind !== "image")
            throw new Error("Attachment must be a PNG, JPEG or WebP image.");
          const saved = await this.#requireMedia().saveImage({
            data: bytes,
            mediaType: media.mimeType as
              "image/png" | "image/jpeg" | "image/webp",
            name,
          });
          return jsonValue(saved, "图片附件");
        },
      }),
      log: (
        level: "info" | "warn" | "error",
        message: string,
        data?: JsonValue,
      ) => this.#log(level, `[${pluginId}] ${message}`, data),
    });
  }

  #requireMedia(): CapabilityMedia {
    if (!this.#media)
      throw new Error("Aura artifact storage is unavailable in this host.");
    return this.#media;
  }

  services(pluginId: string): PluginServices {
    const providers = this.#plugins.get(pluginId)?.providers;
    const result: Record<string, unknown> = {};
    for (const provider of providers?.values() ?? [])
      for (const [key, value] of Object.entries(provider.services ?? {})) {
        if (key in result) throw new Error("plugin_service_conflict");
        result[key] = value;
      }
    return Object.freeze(result);
  }
  serviceRetention(pluginId: string): () => () => void {
    const open = this.#plugins.get(pluginId);
    if (!open) return () => () => undefined;
    return () => {
      if (!open || !open.providers.size)
        throw new Error("plugin_services_unavailable");
      open.active++;
      let released = false;
      return () => {
        if (!released) {
          released = true;
          open.active--;
        }
      };
    };
  }
  taskTools(): PluginTaskTool[] {
    return [...this.#plugins.entries()].flatMap(([id, open]) =>
      [...open.providers.values()].flatMap((provider) =>
        (provider.chatTools ?? []).map((tool) => ({
          ...tool,
          start: (
            input: Record<string, unknown>,
            scope: Parameters<PluginTaskTool["start"]>[1],
          ) => {
            if (this.#plugins.get(id) !== open)
              throw new Error("plugin_tool_unavailable");
            return this.#activity(id, () => tool.start(input, scope));
          },
        })),
      ),
    );
  }
  artifactCandidates(output: unknown, producer: string) {
    return [...this.#plugins.values()].flatMap((open) =>
      [...open.providers.values()].flatMap((provider) => {
        try {
          return [
            ...(provider.artifactCandidates?.(output, producer) ?? []),
          ].slice(0, 100);
        } catch {
          this.#log("warn", "Plugin artifact projection failed.");
          return [];
        }
      }),
    );
  }
  async request(
    method: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    for (const [id, open] of this.#plugins)
      for (const provider of open.providers.values()) {
        const routes = provider.requests;
        if (!routes?.prefixes.some((prefix) => method.startsWith(prefix)))
          continue;
        if (
          !routes.prefixes.every(
            (prefix) =>
              open.root.compatibility?.rpcPrefixes?.includes(prefix) ||
              prefix.startsWith(`${id}/`),
          )
        )
          throw new Error("plugin_request_forbidden");
        return this.#activity(id, () => routes.handle(method, input, signal));
      }
    throw new Error("plugin_request_unavailable");
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
      return this.#builtins.invoke(
        capability,
        operation,
        input,
        signal,
        context,
      );
    }
    const open = this.#plugins.get(capability.split("/")[0]!);
    const provider = open?.providers.get(capability);
    if (!provider)
      throw new Error(`Aura host capability is unavailable: ${capability}`);
    signal.throwIfAborted();
    const run = context?.runId ? this.#runs(context.runId) : undefined;
    open!.active++;
    try {
      const output = await provider.invoke(
        operation,
        input,
        Object.freeze({
          signal,
          ...(context?.runId
            ? {
                runId: context.runId,
                rootRunId: run?.rootRunId ?? context.runId,
              }
            : {}),
          ...(context?.stepId ? { stepId: context.stepId } : {}),
          ...(context?.idempotencyKey
            ? { idempotencyKey: context.idempotencyKey }
            : {}),
        }),
      );
      return jsonValue(output, `${capability} 输出`);
    } finally {
      open!.active--;
    }
  }

  /**
   * Controlled page boundary: a plugin's workbench page may call only its own
   * providers, and only operations the provider listed in `pageOperations`.
   */
  async invokeFromPage(
    pluginId: string,
    capability: string,
    operation: string,
    input: JsonValue,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    if (capability.split("/")[0] !== pluginId)
      throw new Error("page_capability_forbidden");
    const open = this.#plugins.get(pluginId);
    const provider = open?.providers.get(capability);
    if (!provider) throw new Error("page_capability_unavailable");
    if (!provider.pageOperations?.includes(operation))
      throw new Error("page_operation_forbidden");
    signal.throwIfAborted();
    open!.active++;
    try {
      const output = await provider.invoke(
        operation,
        structuredClone(input),
        Object.freeze({ signal }),
      );
      return jsonValue(output, `${capability} 页面输出`, 4 * 1024 * 1024);
    } finally {
      open!.active--;
    }
  }

  /** The provider that declared `serves` for this canonical Flow ID, if any. */
  #server(flowId: string): CapabilityProvider | undefined {
    const [pluginId, local] = flowId.split("/");
    const open = pluginId && local ? this.#plugins.get(pluginId) : undefined;
    return (
      open &&
      [...open.providers.values()].find((provider) =>
        provider.serves?.includes(local!),
      )
    );
  }

  /** Runs the serving provider's admission; Flows without one start with their input unchanged. */
  async admit(
    flowId: string,
    requestId: string,
    input: JsonValue,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    const provider = this.#server(flowId);
    if (!provider?.admit) return input;
    const admitted = await this.#activity(flowId.split("/")[0], () =>
      provider.admit!(
        Object.freeze({
          flowId,
          requestId,
          input: structuredClone(input),
          signal,
        }),
      ),
    );
    return jsonValue(admitted, `${flowId} 准入入参`);
  }

  /** Lets the serving provider re-admit `input` before a service Run resumes. */
  async resume(
    run: FlowRun,
    input: JsonValue,
    signal: AbortSignal,
  ): Promise<void> {
    const provider = this.#server(run.flow.id);
    if (!provider?.resume) throw new Error("resume_input_unsupported");
    await this.#activity(run.flow.plugin?.id, () =>
      provider.resume!(structuredClone(run), structuredClone(input), signal),
    );
  }

  /** Projects a root service Run through its serving provider. Failures are logged, never thrown. */
  async view(run: FlowRun): Promise<JsonValue | undefined> {
    const provider = this.#server(run.flow.id);
    if (!provider?.view) return undefined;
    try {
      return await this.#activity(run.flow.plugin?.id, async () =>
        jsonValue(
          await provider.view!(structuredClone(run)),
          `${run.flow.id} 服务视图`,
          64 * 1_024,
        ),
      );
    } catch (error) {
      this.#log("error", `${run.flow.id} view failed`, {
        runId: run.id,
        message: String((error as Error)?.message ?? error),
      });
      return undefined;
    }
  }

  /** Tells every provider of the Run's plugin that the root Run ended. Never throws. */
  async runSettled(run: FlowRun): Promise<void> {
    const owners = [
      ...this.#plugins.values(),
      ...this.#retired.map(([, open]) => open),
    ].filter((open) =>
      run.flow.plugin
        ? open.root.plugin?.id === run.flow.plugin.id
        : Boolean(open.root.compatibility?.flows?.[run.flow.id]),
    );
    for (const open of owners) {
      open.active++;
      try {
        await Promise.all(
          [...open.providers].map(async ([id, provider]) => {
            if (!provider.runSettled) return;
            let timer: NodeJS.Timeout | undefined;
            try {
              await Promise.race([
                Promise.resolve(provider.runSettled(structuredClone(run))),
                new Promise((_, reject) => {
                  timer = setTimeout(
                    () => reject(new Error("runSettled timed out")),
                    SETTLE_TIMEOUT_MS,
                  );
                }),
              ]);
            } catch (error) {
              this.#log("error", `${id} runSettled failed`, {
                runId: run.id,
                message: String((error as Error)?.message ?? error),
              });
            } finally {
              clearTimeout(timer);
            }
          }),
        );
      } finally {
        open.active--;
      }
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#operations;
    const open = [
      ...this.#plugins.values(),
      ...this.#retired.map(([, item]) => item),
    ];
    this.#retired.length = 0;
    this.#plugins.clear();
    for (const plugin of open) await closeAll(plugin.providers, this.#log);
    this.#modules.close();
  }
}

/** Plugin-contributed IDs are `<plugin-id>/<local-id>`; built-ins never contain "/". */
export const isPluginCapability = (id: string) => id.includes("/");

function pluginKey(root: CapabilityRoot) {
  return JSON.stringify([
    resolve(root.root),
    root.plugin?.version,
    root.settings ?? null,
    root.compatibility ?? null,
    root.http ?? null,
    root.presets ?? null,
    root.capabilities ?? null,
  ]);
}

async function closeAll(providers: Map<string, CapabilityProvider>, log: Log) {
  for (const [id, provider] of [...providers].reverse()) {
    try {
      await provider.close?.();
    } catch (error) {
      log("error", `${id} close failed`, {
        message: String((error as Error)?.message ?? error),
      });
    }
  }
  providers.clear();
}
