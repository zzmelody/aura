import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import {
  closeSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  watch,
  type FSWatcher,
} from "node:fs";
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

interface SourceState {
  stamp?: string;
  hash?: string;
}

/** Native ESM revisions propagate to owned helpers, while SDKs stay shared. */
export class PluginModules {
  readonly #owner = randomUUID();
  readonly #roots = new Map<string, string>();
  readonly #sources = new Map<string, SourceState>();
  readonly #watched = new Map<
    string,
    {
      watcher: FSWatcher;
      revision: number;
      failed: boolean;
      initialized: boolean;
      pending: Set<string>;
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
          this.#sources.set(path, sourceState(path));
        }
      }
      return next(url, context);
    },
  });

  /** Snapshot source bytes once, then compare only paths named by native events. */
  async revision(root: string): Promise<number> {
    const canonical = await realpath(root);
    let current = this.#watched.get(canonical);
    if (!current) {
      const watcher = watch(canonical, { recursive: true, persistent: false });
      current = {
        watcher,
        revision: 0,
        failed: false,
        initialized: false,
        pending: new Set(),
      };
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
        // Read at refresh, not inside a notification for a partially written file.
        state.pending.add(resolve(canonical, changed));
      });
      watcher.on("error", () => {
        state.failed = true;
      });
      // Raw startup JSON/YAML and package controls need the same baseline as
      // imported helpers. Register first so writes during this scan are queued.
      this.#snapshot(canonical);
    }
    if (current.failed) throw new Error("plugin_source_watch_failed");
    for (const path of current.pending) {
      current.pending.delete(path);
      const previous = this.#sources.get(path);
      const next = sourceState(path, previous);
      this.#sources.set(path, next);
      if (!previous && next.stamp === undefined) continue;
      // Changes before the first source load belong to its initial version.
      if (!current.initialized) continue;
      if (previous && previous.stamp === next.stamp) continue;
      if (previous?.hash !== undefined && previous.hash === next.hash) continue;
      current.revision++;
    }
    return current.revision;
  }

  #snapshot(directory: string): void {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      // Unreadable directories remain watched; later events invalidate rather
      // than making plugin startup depend on an unused resource's readability.
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) this.#snapshot(path);
      else if (SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase()))
        this.#sources.set(path, sourceState(path));
    }
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

/** Bounded-memory byte comparison; hashes never become execution identities. */
function sourceState(path: string, previous?: SourceState): SourceState {
  let stamp: string | undefined;
  try {
    const stat = lstatSync(path, { bigint: true });
    stamp = `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    if (stamp === previous?.stamp) return previous;
    // Do not read arbitrary targets of resource symlinks while inventorying roots.
    if (!stat.isFile()) return { stamp };
    const descriptor = openSync(path, "r");
    try {
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let length: number;
      while (
        (length = readSync(descriptor, buffer, 0, buffer.length, null)) > 0
      )
        hash.update(buffer.subarray(0, length));
      return { stamp, hash: hash.digest("hex") };
    } finally {
      closeSync(descriptor);
    }
  } catch {
    // Keep missing/unreadable ownership so deletion and restoration are detected.
    return { stamp };
  }
}
