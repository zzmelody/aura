import {
  isBackendDefinition,
  type BackendHost,
  type PluginBackend,
  type PluginServices,
  type PluginTaskTool,
  type PluginWorkflows,
} from "./backend-api.ts";
import type { PluginDomainStorage } from "./plugin-storage.ts";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { FlowRun, JsonValue } from "@aura/protocol/types";
import type { AuraCapabilityClient } from "./action-api.ts";
import { jsonValue } from "./schema.ts";
import type { GeneratedArtifacts } from "./artifacts/generated.ts";
import { inspectArtifact } from "./artifacts/media.ts";
import type { BackendRoot } from "./types.ts";
import { PluginModules } from "./plugin-modules.ts";

const SETTLE_TIMEOUT_MS = 30_000;

interface OpenPlugin {
  key: string;
  backend: PluginBackend;
  active: number;
  root: BackendRoot;
}

type Log = (
  level: "info" | "warn" | "error",
  message: string,
  data?: JsonValue,
) => void;

/** Host media ports shared with built-in producers. Optional so tests can omit them. */
export interface BackendMedia {
  artifacts: Pick<GeneratedArtifacts, "put" | "read">;
  saveImage(input: {
    data: Uint8Array;
    mediaType: "image/png" | "image/jpeg" | "image/webp";
    name: string;
  }): Promise<unknown>;
}

/**
 * Owns one backend per plugin. Automatic replacement waits for calls and Runs
 * to finish; a failed candidate leaves the previous backend available.
 */
export class PluginBackends {
  readonly #builtins: AuraCapabilityClient | undefined;
  readonly #dataRoot: string;
  readonly #tempRoot: string;
  readonly #log: Log;
  readonly #media: BackendMedia | undefined;
  readonly #plugins = new Map<string, OpenPlugin>();
  #runs: (id: string) => FlowRun | undefined = () => undefined;
  #allRuns: () => Iterable<FlowRun> = () => [];
  #operations: Promise<unknown> = Promise.resolve();
  readonly #modules = new PluginModules();
  #roots: readonly BackendRoot[] = [];
  #closed = false;
  readonly #retired: Array<[string, OpenPlugin]> = [];
  readonly #host:
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
    /** Parent of per-plugin scratch directories. Defaults to `<dataRoot>/../tmp`. */
    tempRoot?: string;
    log?: Log;
    media?: BackendMedia;
    host?: {
      storage: PluginDomainStorage;
      artifacts: GeneratedArtifacts;
      cwd: string;
      workflows: PluginWorkflows;
    };
  }) {
    this.#builtins = options.builtins;
    this.#dataRoot = options.dataRoot;
    this.#tempRoot = options.tempRoot ?? join(dirname(options.dataRoot), "tmp");
    this.#log = options.log ?? (() => undefined);
    this.#media = options.media;
    this.#host = options.host;
  }

  /** Connects the Run store once the engine exists. */
  attachRuns(
    get: (id: string) => FlowRun | undefined,
    all: () => Iterable<FlowRun>,
  ) {
    this.#runs = get;
    this.#allRuns = all;
  }

  /** Opens backends of added or changed plugins and closes removed ones. */
  replace(roots: readonly BackendRoot[]): Promise<void> {
    const task = this.#operations.then(async () => {
      if (this.#closed) throw new Error("plugin_backends_closed");
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

  async #replace(roots: readonly BackendRoot[], automatic = false) {
    const wanted = new Map<string, BackendRoot>();
    for (const root of roots) {
      if (!root.plugin)
        throw new Error("Backend root is missing plugin identity.");
      wanted.set(root.plugin.id, root);
    }
    const candidates = new Map<string, OpenPlugin>();
    try {
      for (const [id, root] of wanted) {
        const previous = this.#plugins.get(id);
        if (automatic && previous && this.#busy(id, previous)) continue;
        try {
          const generation = await this.#modules.revision(
            root.pluginRoot ?? dirname(root.root),
          );
          const key = `${pluginKey(root)}:${generation}`;
          if (previous?.key === key) continue;
          if (
            this.#retired.some(
              ([owner, open]) => owner === id && this.#busy(owner, open),
            )
          )
            throw new Error("plugin_backend_busy");
          if (previous && this.#busy(id, previous))
            throw new Error("plugin_backend_busy");
          const backend = await this.#open(root);
          if (automatic && previous && this.#busy(id, previous)) {
            await closeBackend(id, backend, this.#log);
            continue;
          }
          candidates.set(id, { key, backend, active: 0, root });
          this.#warnings.delete(id);
        } catch (error) {
          if (!automatic) throw error;
          if (!this.#warnings.has(id)) {
            this.#warnings.add(id);
            this.#log("warn", `${id} 更新失败，继续使用上一版后端。`);
          }
        }
      }
    } catch (error) {
      for (const [id, candidate] of candidates)
        await closeBackend(id, candidate.backend, this.#log);
      throw error;
    }
    for (const [id, open] of [...this.#plugins]) {
      if (wanted.has(id) && !candidates.has(id)) continue;
      if (candidates.has(id)) this.#plugins.set(id, candidates.get(id)!);
      else this.#plugins.delete(id);
      if (this.#busy(id, open)) this.#retired.push([id, open]);
      else await closeBackend(id, open.backend, this.#log);
    }
    for (const [id, candidate] of candidates) this.#plugins.set(id, candidate);
    for (const retired of [...this.#retired]) {
      if (!this.#busy(...retired)) {
        await closeBackend(retired[0], retired[1].backend, this.#log);
        this.#retired.splice(this.#retired.indexOf(retired), 1);
      }
    }
  }

  async #open(root: BackendRoot): Promise<PluginBackend> {
    const pluginId = root.plugin!.id;
    const dataDir = join(this.#dataRoot, pluginId);
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const tempDir = join(this.#tempRoot, pluginId);
    await mkdir(tempDir, { recursive: true, mode: 0o700 });
    const module = (await this.#modules.import(
      root.root,
      root.pluginRoot ?? dirname(root.root),
    )) as { default?: unknown };
    if (!isBackendDefinition(module.default))
      throw new Error(
        `${pluginId} backend must default-export defineBackend(...).`,
      );
    const backend = await module.default.open(
      this.#backendHost(pluginId, dataDir, tempDir, root),
    );
    if (!backend || typeof backend !== "object")
      throw new Error(`${pluginId} backend open() must return an object.`);
    try {
      if (
        backend.pageOperations?.length &&
        typeof backend.invoke !== "function"
      )
        throw new Error(
          `${pluginId} backend lists pageOperations without invoke().`,
        );
      if (
        backend.requests &&
        (!backend.requests.prefixes.length ||
          !backend.requests.prefixes.every(
            (prefix) =>
              root.compatibility?.rpcPrefixes?.includes(prefix) ||
              prefix.startsWith(`${pluginId}/`),
          ))
      )
        throw new Error("plugin_request_forbidden");
    } catch (error) {
      await closeBackend(pluginId, backend, this.#log);
      throw error;
    }
    return backend;
  }

  #backendHost(
    pluginId: string,
    dataDir: string,
    tempDir: string,
    root: BackendRoot,
  ): BackendHost {
    const host = this.#host;
    const settings = root.settings;
    const owns = (run: FlowRun) =>
      run.flow.plugin?.id === pluginId ||
      (!run.flow.plugin && Boolean(root.compatibility?.flows?.[run.flow.id]));
    const owned = (run: FlowRun | undefined) =>
      run && owns(run) ? structuredClone(run) : undefined;
    return Object.freeze({
      pluginId,
      dataDir,
      tempDir,
      workspace: Object.freeze({ cwd: this.#host?.cwd ?? dataDir }),
      get storage() {
        if (!host) throw new Error("plugin_storage_unavailable");
        return host.storage.forPlugin(pluginId, root.compatibility);
      },
      get media() {
        if (!host) throw new Error("plugin_media_unavailable");
        return host.artifacts;
      },
      get workflows() {
        if (!host) throw new Error("plugin_workflows_unavailable");
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
            return host.workflows.start(input);
          },
          get: (id: string) => {
            const run = host.workflows.get(id);
            if (!owns(run)) throw new Error("plugin_workflow_forbidden");
            return structuredClone(run);
          },
          runs: {
            entries: function* () {
              for (const [id, run] of host.workflows.runs.entries())
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
        if (!this.#builtins)
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

  #requireMedia(): BackendMedia {
    if (!this.#media)
      throw new Error("Aura artifact storage is unavailable in this host.");
    return this.#media;
  }

  services(pluginId: string): PluginServices {
    return Object.freeze({
      ...(this.#plugins.get(pluginId)?.backend.services ?? {}),
    });
  }
  serviceRetention(pluginId: string): () => () => void {
    const open = this.#plugins.get(pluginId);
    if (!open) return () => () => undefined;
    return () => {
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
      (open.backend.chatTools ?? []).map((tool) => ({
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
    );
  }
  artifactCandidates(output: unknown, producer: string) {
    return [...this.#plugins.values()].flatMap((open) => {
      try {
        return [
          ...(open.backend.artifactCandidates?.(output, producer) ?? []),
        ].slice(0, 100);
      } catch {
        this.#log("warn", "Plugin artifact projection failed.");
        return [];
      }
    });
  }
  async request(
    method: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    for (const [id, open] of this.#plugins) {
      const routes = open.backend.requests;
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

  /**
   * Controlled page boundary: a plugin's workbench page reaches only its own
   * backend, and only operations that backend listed in `pageOperations`.
   */
  async invokeFromPage(
    pluginId: string,
    operation: string,
    input: JsonValue,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    const open = this.#plugins.get(pluginId);
    if (!open) throw new Error("page_backend_unavailable");
    const { backend } = open;
    if (!backend.invoke || !backend.pageOperations?.includes(operation))
      throw new Error("page_operation_forbidden");
    signal.throwIfAborted();
    open.active++;
    try {
      const output = await backend.invoke(
        operation,
        structuredClone(input),
        Object.freeze({ signal }),
      );
      return jsonValue(output, `${pluginId} 页面输出`, 4 * 1024 * 1024);
    } finally {
      open.active--;
    }
  }

  /** The backend that declared `serves` for this canonical Flow ID, if any. */
  #server(flowId: string): PluginBackend | undefined {
    const [pluginId, local] = flowId.split("/");
    const backend =
      pluginId && local ? this.#plugins.get(pluginId)?.backend : undefined;
    return backend?.serves?.includes(local!) ? backend : undefined;
  }

  /** Runs the serving backend's admission; Flows without one start with their input unchanged. */
  async admit(
    flowId: string,
    requestId: string,
    input: JsonValue,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    const backend = this.#server(flowId);
    if (!backend?.admit) return input;
    const admitted = await this.#activity(flowId.split("/")[0], () =>
      backend.admit!(
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

  /** Lets the serving backend re-admit `input` before a service Run resumes. */
  async resume(
    run: FlowRun,
    input: JsonValue,
    signal: AbortSignal,
  ): Promise<void> {
    const backend = this.#server(run.flow.id);
    if (!backend?.resume) throw new Error("resume_input_unsupported");
    await this.#activity(run.flow.plugin?.id, () =>
      backend.resume!(structuredClone(run), structuredClone(input), signal),
    );
  }

  /** Projects a root service Run through its serving backend. Failures are logged, never thrown. */
  async view(run: FlowRun): Promise<JsonValue | undefined> {
    const backend = this.#server(run.flow.id);
    if (!backend?.view) return undefined;
    try {
      return await this.#activity(run.flow.plugin?.id, async () =>
        jsonValue(
          await backend.view!(structuredClone(run)),
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

  /** Tells the backend of the Run's plugin that the root Run ended. Never throws. */
  async runSettled(run: FlowRun): Promise<void> {
    const owners = [...this.#plugins.entries(), ...this.#retired].filter(
      ([, open]) =>
        run.flow.plugin
          ? open.root.plugin?.id === run.flow.plugin.id
          : Boolean(open.root.compatibility?.flows?.[run.flow.id]),
    );
    for (const [id, open] of owners) {
      if (!open.backend.runSettled) continue;
      open.active++;
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          Promise.resolve(open.backend.runSettled(structuredClone(run))),
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
        open.active--;
      }
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#operations;
    const open = [...this.#plugins.entries(), ...this.#retired];
    this.#retired.length = 0;
    this.#plugins.clear();
    for (const [id, plugin] of open)
      await closeBackend(id, plugin.backend, this.#log);
    this.#modules.close();
  }
}

function pluginKey(root: BackendRoot) {
  return JSON.stringify([
    resolve(root.root),
    root.plugin?.version,
    root.settings ?? null,
    root.compatibility ?? null,
    root.http ?? null,
    root.presets ?? null,
    root.permissions ?? null,
  ]);
}

async function closeBackend(id: string, backend: PluginBackend, log: Log) {
  try {
    await backend.close?.();
  } catch (error) {
    log("error", `${id} close failed`, {
      message: String((error as Error)?.message ?? error),
    });
  }
}
