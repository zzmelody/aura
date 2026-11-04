import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { registerHooks } from "node:module";
import { extname, isAbsolute, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REVISION = "auraPluginRevision";
const SOURCE_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".mts",
  ".cts",
  ".jsx",
  ".tsx",
  ".json",
  ".yaml",
  ".yml",
]);

/** Native ESM revisions propagate to owned helpers, while SDKs stay shared. */
export class PluginModules {
  readonly #owner = randomUUID();
  readonly #roots = new Map<string, string>();
  readonly #watched = new Map<
    string,
    { watcher: FSWatcher; revision: number; failed: boolean }
  >();
  #generation = 0;
  readonly #hooks = registerHooks({
    resolve: (specifier, context, next) => {
      const result = next(specifier, context);
      if (!context.parentURL?.startsWith("file:")) return result;
      const revision = new URL(context.parentURL).searchParams.get(REVISION);
      const root = revision ? this.#roots.get(revision) : undefined;
      if (!root || !result.url.startsWith("file:")) return result;
      const url = new URL(result.url);
      const part = relative(root, fileURLToPath(url));
      if (
        isAbsolute(part) ||
        part === ".." ||
        part.startsWith(`..${sep}`) ||
        part.split(sep).includes("node_modules")
      )
        return result;
      url.searchParams.set(REVISION, revision!);
      return { ...result, url: url.href };
    },
  });

  /** Native recursive notifications avoid reading/parsing a plugin's source tree. */
  async revision(root: string): Promise<number> {
    const canonical = await realpath(root);
    let current = this.#watched.get(canonical);
    if (!current) {
      const watcher = watch(canonical, { recursive: true, persistent: false });
      current = { watcher, revision: 0, failed: false };
      this.#watched.set(canonical, current);
      const state = current;
      watcher.on("change", (_event, filename) => {
        const changed = filename?.toString();
        if (
          !changed ||
          !SOURCE_EXTENSIONS.has(extname(changed).toLowerCase()) ||
          changed
            .split(/[/\\]/u)
            .some((part) => part === "node_modules" || part.startsWith("."))
        )
          return;
        state.revision++;
      });
      watcher.on("error", () => {
        state.failed = true;
      });
    }
    if (current.failed) throw new Error("plugin_source_watch_failed");
    return current.revision;
  }

  async import(
    entry: string,
    root: string,
    generation = String(++this.#generation),
  ): Promise<unknown> {
    const revision = `${this.#owner}:${generation}`;
    this.#roots.set(revision, await realpath(root));
    const url = pathToFileURL(entry);
    url.searchParams.set(REVISION, revision);
    return import(url.href);
  }

  close() {
    for (const { watcher } of this.#watched.values()) watcher.close();
    this.#watched.clear();
    this.#hooks.deregister();
    this.#roots.clear();
  }
}
