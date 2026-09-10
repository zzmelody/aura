import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Loader } from "@deepseek-ai/cordis-plugin-loader";
import type { FlowRegistrationConfig } from "./flow-api.ts";
import { flowIdSchema } from "./schema.ts";
import { hashFlowDirectory, FlowRegistry } from "./registry.ts";

interface MountedFlow {
  loaderId: string;
  entry: string;
}

async function flowEntries(directory: string): Promise<string[]> {
  const matches: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) matches.push(...(await flowEntries(path)));
    if (entry.isFile() && entry.name.endsWith(".flow.js")) matches.push(path);
  }
  return matches;
}

/** Discovers flat Flow directories; module updates are delegated to Cordis HMR. */
export class FlowDiscovery {
  private loader: Loader;
  private registry: FlowRegistry;
  readonly root: string;
  private mounted = new Map<string, MountedFlow>();
  private failures = new Map<string, string>();
  private issues = new Set<string>();
  private queue: Promise<void> = Promise.resolve();

  constructor(loader: Loader, registry: FlowRegistry, root: string) {
    this.loader = loader;
    this.registry = registry;
    this.root = root;
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
    const entries = await readdir(this.root, { withFileTypes: true });

    for (const child of entries) {
      if (!child.isDirectory()) continue;
      const flowId = child.name;
      discovered.add(flowId);
      const directory = join(this.root, flowId);
      if (!flowIdSchema.safeParse(flowId).success) {
        issues.add(flowId);
        await this.unmount(flowId);
        this.registry.problem(flowId, `无效的 Flow 目录名：${flowId}`);
        continue;
      }

      const expected = join(directory, `${flowId}.flow.js`);
      const candidates = await flowEntries(directory);
      if (candidates.length !== 1 || candidates[0] !== expected) {
        issues.add(flowId);
        await this.unmount(flowId);
        this.registry.problem(
          flowId,
          `目录 ${flowId} 必须且只能包含入口 ${flowId}.flow.js。`,
        );
        continue;
      }

      const signature = await hashFlowDirectory(directory);
      const current = this.mounted.get(flowId);
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
      const config: FlowRegistrationConfig = {
        flowId,
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
          `Flow 加载失败：${error instanceof Error ? error.message : String(error)}`,
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
