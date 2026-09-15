import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Loader } from "@deepseek-ai/cordis-plugin-loader";
import { flowIdSchema, FlowError } from "./schema.ts";
import { validateFlowSource } from "./flow-diagnostics.ts";
import { hashFlowDirectory, type FlowRegistry } from "./registry.ts";

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
): Promise<string[]> {
  const matches: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) matches.push(...(await flowEntries(path, kind)));
    if (entry.isFile() && entry.name.endsWith(`.${kind}.js`))
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
  private mounted = new Map<string, MountedFlow>();
  private failures = new Map<string, string>();
  private issues = new Set<string>();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    loader: Loader,
    registry: DiscoveryRegistry,
    root: string,
    kind: "flow" | "action",
  ) {
    this.loader = loader;
    this.registry = registry;
    this.root = root;
    this.kind = kind;
  }

  refresh(): Promise<void> {
    const task = this.queue.then(() => this.scan());
    this.queue = task.catch(() => undefined);
    return task;
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
      const flowId = child.name;
      discovered.add(flowId);
      const directory = join(this.root, flowId);
      if (
        !flowIdSchema.safeParse(flowId).success ||
        (this.kind === "action" &&
          (flowId === "run_code" || flowId.startsWith("aura_direct_")))
      ) {
        issues.add(flowId);
        await this.unmount(flowId);
        this.registry.problem(flowId, `无效的 ${title} 目录名：${flowId}`);
        continue;
      }

      const expected = join(directory, `${flowId}.${this.kind}.js`);
      const candidates = await flowEntries(directory, this.kind);
      if (candidates.length !== 1 || candidates[0] !== expected) {
        issues.add(flowId);
        await this.unmount(flowId);
        this.registry.problem(
          flowId,
          `目录 ${flowId} 必须且只能包含入口 ${flowId}.${this.kind}.js。`,
        );
        continue;
      }

      const signature = await hashFlowDirectory(directory);
      const current = this.mounted.get(flowId);
      if (this.kind === "flow") {
        try {
          validateFlowSource(await readFile(expected, "utf8"));
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
        this.registry.problem(
          flowId,
          `${title} 加载失败，请检查入口及本地依赖。`,
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
  }
}

export class FlowDiscovery extends CodeDiscovery {
  constructor(loader: Loader, registry: DiscoveryRegistry, root: string) {
    super(loader, registry, root, "flow");
  }
}

export class ActionDiscovery extends CodeDiscovery {
  constructor(loader: Loader, registry: DiscoveryRegistry, root: string) {
    super(loader, registry, root, "action");
  }
}
