import { isAbsolute, relative, resolve } from "node:path";
import {
  isPluginHttpMount,
  matchesPluginHttpMount,
} from "@aura/protocol/plugin-http";
import type { BackendRoot } from "./types.ts";
import type { PluginHttpDefinition, PluginHttpHost } from "./backend-api.ts";
import { PluginModules } from "./plugin-modules.ts";
import { FlowError } from "./schema.ts";

/** Loads trusted Hono adapters. Only declared mounts and RPC prefixes are reachable. */
export class PluginHttpRegistry {
  readonly #modules = new PluginModules();
  readonly #routes: Array<{ root: BackendRoot; app: PluginHttpDefinition }> =
    [];
  private readonly host: PluginHttpHost;
  private readonly reservedMounts: readonly string[];
  constructor(host: PluginHttpHost, reservedMounts: readonly string[] = []) {
    this.host = host;
    this.reservedMounts = reservedMounts;
  }
  async replace(roots: readonly BackendRoot[]) {
    const candidates: Array<{
      root: BackendRoot;
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
          if (!isPluginHttpMount(mount))
            throw new FlowError("Invalid plugin HTTP mount.");
          if (
            this.reservedMounts.includes(mount) ||
            [...mounts].some(
              (existing) =>
                matchesPluginHttpMount(mount, existing) ||
                matchesPluginHttpMount(existing, mount),
            )
          )
            throw new FlowError("Plugin HTTP mount conflict.", 409);
          mounts.add(mount);
        }
        const module = (await this.#modules.import(entry, root.pluginRoot)) as {
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
      root.http!.mounts.some((mount) => matchesPluginHttpMount(path, mount)),
    );
    return route?.app.fetch(request);
  }
  async close() {
    await Promise.all(this.#routes.splice(0).map(({ app }) => app.close?.()));
    this.#modules.close();
  }
}
