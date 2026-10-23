import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { CapabilityRoot } from "./types.ts";
import type { PluginHttpDefinition, PluginHttpHost } from "./backend-api.ts";
import { hashContribution } from "./contribution-hash.ts";
import { PluginModules } from "./plugin-modules.ts";
import { FlowError } from "./schema.ts";

/** Loads trusted Hono adapters. Only declared mounts and RPC prefixes are reachable. */
export class PluginHttpRegistry {
  readonly #modules = new PluginModules();
  readonly #routes: Array<{ root: CapabilityRoot; app: PluginHttpDefinition }> =
    [];
  private readonly host: PluginHttpHost;
  constructor(host: PluginHttpHost) {
    this.host = host;
  }
  async replace(roots: readonly CapabilityRoot[]) {
    const candidates: Array<{
      root: CapabilityRoot;
      app: PluginHttpDefinition;
    }> = [];
    const mounts = new Set<string>();
    try {
      for (const root of roots) {
        if (!root.http || !root.pluginRoot) continue;
        const entry = resolve(root.http.entry);
        const path = relative(root.pluginRoot, entry);
        if (!path || path.startsWith("..") || isAbsolute(path))
          throw new FlowError("Plugin HTTP entry is outside its root.");
        for (const mount of root.http.mounts) {
          if (
            [...mounts].some(
              (existing) =>
                mount === existing ||
                mount.startsWith(`${existing}/`) ||
                existing.startsWith(`${mount}/`),
            )
          )
            throw new FlowError("Plugin HTTP mount conflict.", 409);
          mounts.add(mount);
        }
        const hash = await hashContribution(dirname(entry), root.pluginRoot);
        const module = (await this.#modules.import(
          entry,
          root.pluginRoot,
          hash,
        )) as {
          default?: (
            host: PluginHttpHost,
          ) => PluginHttpDefinition | Promise<PluginHttpDefinition>;
        };
        if (typeof module.default !== "function")
          throw new FlowError("Plugin HTTP entry must export a factory.");
        const app = await module.default(
          Object.freeze({
            ...this.host,
            request: <T>(
              method: string,
              input?: unknown,
              signal?: AbortSignal,
            ) => {
              if (
                !method.startsWith(`${root.plugin?.id}/`) &&
                !root.compatibility?.rpcPrefixes?.some((prefix) =>
                  method.startsWith(prefix),
                )
              )
                throw new FlowError("plugin_request_forbidden", 403);
              return this.host.request<T>(method, input, signal);
            },
          }),
        );
        if (typeof app.fetch !== "function")
          throw new FlowError("Plugin HTTP factory must return fetch().");
        candidates.push({ root, app });
      }
    } catch (error) {
      await Promise.all(candidates.map(({ app }) => app.close?.()));
      throw error;
    }
    const previous = this.#routes.splice(0, this.#routes.length, ...candidates);
    await Promise.all(previous.map(({ app }) => app.close?.()));
  }
  async fetch(request: Request): Promise<Response | undefined> {
    const path = new URL(request.url).pathname;
    const route = this.#routes.find(({ root }) =>
      root.http!.mounts.some(
        (mount) => path === mount || path.startsWith(`${mount}/`),
      ),
    );
    return route?.app.fetch(request);
  }
  async close() {
    await Promise.all(this.#routes.splice(0).map(({ app }) => app.close?.()));
    this.#modules.close();
  }
}
