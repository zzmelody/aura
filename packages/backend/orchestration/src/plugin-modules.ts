import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { statSync, watch, type FSWatcher } from "node:fs";
import { registerHooks } from "node:module";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
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
  readonly #sources = new Map<string, string>();
  readonly #watched = new Map<
    string,
    {
      watcher: FSWatcher;
      revision: number;
      failed: boolean;
      initialized: boolean;
    }
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
    load: (url, context, next) => {
      if (url.startsWith("file:")) {
        const source = new URL(url);
        const revision = source.searchParams.get(REVISION);
        if (revision && this.#roots.has(revision)) {
          const path = fileURLToPath(source);
          this.#sources.set(path, sourceStamp(path));
        }
      }
      return next(url, context);
    },
  });

  /** Native recursive notifications avoid reading/parsing a plugin's source tree. */
  async revision(root: string): Promise<number> {
    const canonical = await realpath(root);
    let current = this.#watched.get(canonical);
    if (!current) {
      const watcher = watch(canonical, { recursive: true, persistent: false });
      current = { watcher, revision: 0, failed: false, initialized: false };
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
        const path = resolve(canonical, changed);
        const previous = this.#sources.get(path);
        // Changes before the first source load belong to its initial version.
        if (previous === undefined && !state.initialized) return;
        if (previous !== undefined) {
          try {
            const stamp = sourceStamp(path);
            if (stamp === previous) return;
            this.#sources.set(path, stamp);
          } catch {
            // Deleted or unavailable source must still invalidate its backend.
            this.#sources.delete(path);
          }
        }
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
    const canonical = await realpath(root);
    this.#roots.set(revision, canonical);
    const url = pathToFileURL(entry);
    url.searchParams.set(REVISION, revision);
    try {
      return await import(url.href);
    } finally {
      const watched = this.#watched.get(canonical);
      if (watched) watched.initialized = true;
    }
  }

  close() {
    for (const { watcher } of this.#watched.values()) watcher.close();
    this.#watched.clear();
    this.#hooks.deregister();
    this.#roots.clear();
    this.#sources.clear();
  }
}

/** Metadata for a loaded source, without reading or parsing its contents. */
function sourceStamp(path: string): string {
  const stat = statSync(path, { bigint: true });
  return `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}
