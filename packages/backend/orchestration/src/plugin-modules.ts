import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { registerHooks } from "node:module";
import { isAbsolute, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REVISION = "auraPluginRevision";

/** Native ESM revisions propagate to owned helpers, while SDKs stay shared. */
export class PluginModules {
  readonly #owner = randomUUID();
  readonly #roots = new Map<string, string>();
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

  async import(entry: string, root: string, hash: string): Promise<unknown> {
    const revision = `${this.#owner}:${hash}`;
    this.#roots.set(revision, await realpath(root));
    const url = pathToFileURL(entry);
    url.searchParams.set(REVISION, revision);
    return import(url.href);
  }

  close() {
    this.#hooks.deregister();
    this.#roots.clear();
  }
}
