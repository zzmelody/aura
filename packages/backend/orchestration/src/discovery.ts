import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Loader } from "@deepseek-ai/cordis-plugin-loader";
import { flowIdSchema, FlowError } from "./schema.ts";
import { validateFlowSource } from "./flow-diagnostics.ts";
import { hashFlowDirectory, type FlowRegistry } from "./registry.ts";
import type { ContributionRoot } from "./types.ts";

type DiscoveryRegistry = Pick<
  FlowRegistry,
  | "sourceHash"
  | "remove"
  | "problem"
  | "clearProblem"
  | "reloadProblem"
  | "clearReloadProblem"
>;

interface MountedFlow {
  loaderId: string;
  entry: string;
}

async function flowEntries(
  directory: string,
  kind: "flow" | "action",
  typescript = false,
): Promise<string[]> {
  const matches: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory())
      matches.push(...(await flowEntries(path, kind, typescript)));
    if (
      entry.isFile() &&
      (entry.name.endsWith(`.${kind}.js`) ||
        (typescript && entry.name.endsWith(`.${kind}.ts`)))
    )
      matches.push(path);
  }
  return matches;
}

/** Shared directory discovery; dependency tracking/reload belongs to Cordis HMR. */
export class CodeDiscovery {
  private loader: Loader;
  private registry: DiscoveryRegistry;
  private kind: "flow" | "action";
  readonly root: string;
  readonly namespace?: string;
  readonly pluginRoot?: string;
  readonly plugin?: ContributionRoot["plugin"];
  readonly permissions?: ContributionRoot["permissions"];
  readonly compatibility?: ContributionRoot["compatibility"];
  private mounted = new Map<string, MountedFlow>();
  private failures = new Map<string, string>();
  private issues = new Set<string>();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    loader: Loader,
    registry: DiscoveryRegistry,
    root: string | ContributionRoot,
    kind: "flow" | "action",
  ) {
    this.loader = loader;
    this.registry = registry;
    this.root = typeof root === "string" ? root : root.root;
    this.pluginRoot = typeof root === "string" ? undefined : root.pluginRoot;
    this.namespace = typeof root === "string" ? undefined : root.namespace;
    this.plugin = typeof root === "string" ? undefined : root.plugin;
    this.permissions = typeof root === "string" ? undefined : root.permissions;
    this.compatibility =
      typeof root === "string" ? undefined : root.compatibility;
    this.kind = kind;
  }

  refresh(): Promise<void> {
    const task = this.queue.then(() => this.scan());
    this.queue = task.catch(() => undefined);
    return task;
  }

  descriptor(): ContributionRoot {
    return {
      root: this.root,
      ...(this.compatibility ? { compatibility: this.compatibility } : {}),
      ...(this.pluginRoot ? { pluginRoot: this.pluginRoot } : {}),
      ...(this.namespace ? { namespace: this.namespace } : {}),
      ...(this.plugin ? { plugin: this.plugin } : {}),
      ...(this.permissions ? { permissions: [...this.permissions] } : {}),
    };
  }

  hasUnavailableContributions(): boolean {
    return [...this.issues].some((id) => !this.mounted.has(id));
  }

  private async scan() {
    const previousIssues = this.issues;
    const issues = new Set<string>();
    const discovered = new Set<string>();
    const entries = await readdir(this.root, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    );
    const title = this.kind === "flow" ? "Flow" : "Action";

    for (const child of entries) {
      if (!child.isDirectory()) continue;
      const localId = child.name;
      const legacyRevision =
        this.compatibility?.[this.kind === "flow" ? "flows" : "actions"]?.[
          localId
        ];
      const flowId =
        this.namespace && !legacyRevision
          ? `${this.namespace}/${localId}`
          : localId;
      discovered.add(flowId);
      const directory = join(this.root, localId);
      if (
        !flowIdSchema.safeParse(localId).success ||
        (this.kind === "action" &&
          (localId === "run_code" || localId.startsWith("aura_direct_")))
      ) {
        issues.add(flowId);
        await this.unmount(flowId);
        this.registry.problem(flowId, `无效的 ${title} 目录名：${flowId}`);
        continue;
      }

      const candidates = await flowEntries(directory, this.kind, !this.plugin);
      const allowed = [
        join(directory, `${localId}.${this.kind}.js`),
        ...(!this.plugin
          ? [join(directory, `${localId}.${this.kind}.ts`)]
          : []),
      ];
      const expected = candidates[0];
      if (candidates.length !== 1 || !allowed.includes(expected)) {
        issues.add(flowId);
        await this.unmount(flowId);
        this.registry.problem(
          flowId,
          `目录 ${localId} 必须且只能包含入口 ${localId}.${this.kind}.js${this.plugin ? "" : " 或 .ts"}。`,
        );
        continue;
      }

      let signature: string;
      try {
        signature = await hashFlowDirectory(directory, this.pluginRoot);
      } catch {
        issues.add(flowId);
        if (this.mounted.has(flowId))
          this.registry.reloadProblem(
            flowId,
            "Plugin dependency revision could not be validated.",
          );
        else
          this.registry.problem(
            flowId,
            "Plugin dependency revision could not be validated.",
          );
        continue;
      }
      const current = this.mounted.get(flowId);
      if (this.kind === "flow") {
        try {
          validateFlowSource(await readFile(expected, "utf8"), {
            allowRootOperations: Boolean(this.plugin),
          });
        } catch (error) {
          const message =
            error instanceof FlowError
              ? error.message
              : "Flow 源码语法错误，请检查入口文件。";
          issues.add(flowId);
          if (current) this.registry.reloadProblem(flowId, message);
          else this.registry.problem(flowId, message);
          continue;
        }
      }
      if (current?.entry === expected) {
        if (this.registry.sourceHash(flowId) === signature)
          this.registry.clearReloadProblem(flowId);
        else
          this.registry.reloadProblem(
            flowId,
            "检测到新版本，但热加载尚未成功；当前仍使用最后一个可用版本。",
          );
        continue;
      }
      if (current) await this.unmount(flowId);

      if (this.failures.get(flowId) === signature) {
        issues.add(flowId);
        continue;
      }
      const config = {
        [this.kind === "flow" ? "flowId" : "actionId"]: flowId,
        directory,
        entry: expected,
        plugin: this.plugin,
        legacyRevision,
        pluginRoot: this.pluginRoot,
        permissions: this.permissions,
      };
      try {
        const loaderId = await this.loader.create({
          name: pathToFileURL(expected).href,
          config,
        });
        this.mounted.set(flowId, { loaderId, entry: expected });
        this.failures.delete(flowId);
        this.registry.clearProblem(flowId);
      } catch (error) {
        issues.add(flowId);
        this.failures.set(flowId, signature);
        const missing =
          error instanceof Error
            ? error.message.match(/Cannot find package '([^']+)'/u)?.[1]
            : undefined;
        this.registry.problem(
          flowId,
          missing
            ? `${title} 加载失败：依赖 ${missing} 不可解析。`
            : `${title} 加载失败，请检查入口及本地依赖。`,
        );
      }
    }

    for (const id of [...this.mounted.keys()])
      if (!discovered.has(id)) await this.unmount(id);
    for (const id of previousIssues)
      if (!discovered.has(id) || !issues.has(id))
        this.registry.clearProblem(id);
    for (const id of [...this.failures.keys()])
      if (!discovered.has(id)) this.failures.delete(id);
    this.issues = issues;
  }

  private async unmount(flowId: string) {
    const current = this.mounted.get(flowId);
    this.mounted.delete(flowId);
    this.registry.remove(flowId);
    if (current) await this.loader.remove(current.loaderId);
  }

  async close() {
    await this.queue;
    for (const id of [...this.mounted.keys()]) await this.unmount(id);
    for (const id of this.issues) {
      this.registry.clearProblem(id);
      this.registry.clearReloadProblem(id);
    }
    this.issues.clear();
    this.failures.clear();
  }
}

export class FlowDiscovery extends CodeDiscovery {
  constructor(
    loader: Loader,
    registry: DiscoveryRegistry,
    root: string | ContributionRoot,
  ) {
    super(loader, registry, root, "flow");
  }
}

export class ActionDiscovery extends CodeDiscovery {
  constructor(
    loader: Loader,
    registry: DiscoveryRegistry,
    root: string | ContributionRoot,
  ) {
    super(loader, registry, root, "action");
  }
}
