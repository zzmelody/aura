import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile, stat } from "node:fs/promises";
import type { PluginPageRoot } from "@aura/extensions";
import type {
  AuraPluginIdentity,
  AuraPluginPageBundle,
  AuraPluginPagesState,
} from "@aura/protocol/types";

/** Browser half of DSH's client module system, served as the bootstrap row. */
export const SECRET_MASK_ID = "@deepseek-ai/dsh-client-ui-secret-mask";
export const LOADER_ID = "@deepseek-ai/dsh-client-modules";
/** Specifiers the workbench seeds into the module table; plugins must not bundle them. */
export const PAGE_EXTERNALS = [
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "@deepseek-ai/cordis",
  "@aura/plugin-ui",
  "@aura/workbench/plugin",
  "@aura/workbench/transport",
] as const;

const SOURCE_MAP_TRAILER = /\n?\/\/# sourceMappingURL=[^\n]*\s*$/u;

/** One row of DSH's `WebBootGraph` wire (`dsh-client-modules` manifest). */
interface GraphEntry {
  id: string;
  url: string;
  rev: string;
  immediately?: boolean;
  external?: string[];
}

interface GraphBatch {
  phase: "bootstrap" | "application";
  url: string;
  rev: string;
  entries: string[];
}

export interface PluginPageGraph {
  rev: string;
  entries: GraphEntry[];
  batches: GraphBatch[];
}

/** HTTP projection: Aura's page state plus the DSH boot graph it implies. */
export interface PluginPagesSnapshot extends AuraPluginPagesState {
  graph: PluginPageGraph;
}

interface BundleRecord {
  id: string;
  path: string;
  plugin: AuraPluginIdentity;
  stamp: string;
  rev: string;
  source: Buffer;
}

export interface PluginPageResource {
  status: number;
  headers: Record<string, string>;
  body?: Buffer;
}

function hash(parts: readonly string[]): string {
  const digest = createHash("sha1");
  for (const part of parts)
    digest.update(`${Buffer.byteLength(part)}:`).update(part);
  return digest.digest("hex").slice(0, 12);
}

/** DSH single-resource combo reference, document-relative like DSH emits it. */
function comboReference(id: string, rev: string): string {
  return `plugins/??${id}/client.js&rev=${rev}`;
}

async function capture(
  id: string,
  path: string,
  plugin: AuraPluginIdentity,
  previous: BundleRecord | undefined,
): Promise<BundleRecord> {
  const info = await stat(path);
  if (!info.isFile() || info.size === 0)
    throw new Error(`${id} 的浏览器入口不可读取。`);
  const stamp = `${info.mtimeMs}:${info.ctimeMs}:${info.size}`;
  if (previous && previous.path === path && previous.stamp === stamp)
    return { ...previous, plugin };
  let text = (await readFile(path)).toString("utf8");
  // A combo concatenates registrations; per-file map trailers would point nowhere.
  text = text.replace(SOURCE_MAP_TRAILER, "");
  if (!text.includes("__ModuleLoader__"))
    throw new Error(
      `${id} 的浏览器入口不是 DSH lazy-CJS 包（缺少 window.__ModuleLoader__.load 注册）。`,
    );
  if (!text.endsWith("\n")) text += "\n";
  return {
    id,
    path,
    plugin,
    stamp,
    rev: hash(["aura-plugin-page", id, stamp]),
    source: Buffer.from(`${text};\n`),
  };
}

/**
 * Parses the raw request target of a DSH combo URL. The `??` begins the query
 * string, and package IDs may be scoped (`@scope/name`), so this works on the
 * raw text rather than on URL path segments.
 */
export function parseCombo(
  target: string,
): { ids: string[]; rev: string } | undefined {
  const start = target.indexOf("/plugins/??");
  if (start < 0) return undefined;
  const rest = target.slice(start + "/plugins/??".length);
  const revAt = rest.lastIndexOf("&rev=");
  if (revAt <= 0) return undefined;
  const rev = decodeURIComponent(rest.slice(revAt + "&rev=".length));
  if (!/^[a-z0-9]{1,40}$/u.test(rev)) return undefined;
  const ids: string[] = [];
  for (const resource of rest.slice(0, revAt).split(",")) {
    const decoded = decodeURIComponent(resource);
    if (!decoded.endsWith("/client.js")) return undefined;
    const id = decoded.slice(0, -"/client.js".length);
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/u.test(id))
      return undefined;
    ids.push(id);
  }
  return ids.length ? { ids, rev } : undefined;
}

/**
 * Owns the enabled plugins' prebuilt browser bundles and the DSH loader
 * bundle, composes DSH's boot graph wire, and serves combo resources. Aura
 * does not host DSH's web shell: the workbench boots the same browser
 * `ClientModuleSystem` against this graph.
 */
export class PluginPageRegistry {
  #loader: BundleRecord | undefined;
  #mask: BundleRecord | undefined;
  #bundles = new Map<string, BundleRecord>();
  #snapshot: PluginPagesSnapshot = compose(undefined, []);
  readonly #listeners = new Set<() => void>();
  readonly #loaderPath: string;
  #operations: Promise<unknown> = Promise.resolve();
  #roots: readonly PluginPageRoot[] = [];
  #timer: NodeJS.Timeout | undefined;
  #closed = false;
  #warned = false;
  readonly #onReloadError: () => void;

  constructor(
    options: { loaderPath?: string; onReloadError?: () => void } = {},
  ) {
    this.#loaderPath =
      options.loaderPath ??
      createRequire(import.meta.url).resolve(`${LOADER_ID}/client`);
    this.#onReloadError = options.onReloadError ?? (() => undefined);
  }

  snapshot(): PluginPagesSnapshot {
    return this.#snapshot;
  }

  /** Notified after every applied change of the composed graph. */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Re-captures every enabled page bundle. All bundles must be readable DSH
   * registrations, otherwise nothing changes and the apply fails, so the
   * plugin manager can keep the previous configuration.
   */
  replace(roots: readonly PluginPageRoot[]): Promise<void> {
    const task = this.#operations.then(async () => {
      if (this.#closed) throw new Error("plugin_pages_closed");
      await this.#replace(roots);
      this.#roots = structuredClone(roots);
    });
    this.#operations = task.catch(() => undefined);
    return task;
  }

  /** Observes only explicitly enabled bundles, without builds or config writes. */
  startWatching(intervalMs = 1_000): void {
    if (this.#closed || this.#timer) return;
    const schedule = () => {
      if (this.#closed) return;
      this.#timer = setTimeout(() => {
        const task = this.#operations.then(() => {
          if (!this.#closed) return this.#replace(this.#roots);
        });
        this.#operations = task.catch(() => undefined);
        void task
          .then(() => {
            this.#warned = false;
          })
          .catch(() => {
            if (!this.#warned) {
              this.#warned = true;
              this.#onReloadError();
            }
          })
          .finally(schedule);
      }, intervalMs);
      this.#timer.unref();
    };
    schedule();
  }

  async close(): Promise<void> {
    this.#closed = true;
    clearTimeout(this.#timer);
    await this.#operations;
    this.#listeners.clear();
  }

  async #replace(roots: readonly PluginPageRoot[]) {
    const loader = await capture(
      LOADER_ID,
      this.#loaderPath,
      { id: LOADER_ID, name: "DSH client modules", version: "0.2.1-rc.5" },
      this.#loader,
    );
    const next = new Map<string, BundleRecord>();
    const mask = await capture(
      SECRET_MASK_ID,
      createRequire(import.meta.url).resolve(`${SECRET_MASK_ID}/client`),
      { id: SECRET_MASK_ID, name: "DSH secret masking", version: "0.2.1-rc.5" },
      this.#mask,
    );
    for (const root of roots)
      next.set(
        root.plugin.id,
        await capture(
          root.plugin.id,
          root.bundlePath,
          root.plugin,
          this.#bundles.get(root.plugin.id),
        ),
      );
    const snapshot = compose(loader, [...next.values()], mask);
    this.#mask = mask;
    this.#loader = loader;
    this.#bundles = next;
    if (snapshot.rev === this.#snapshot.rev) return;
    this.#snapshot = snapshot;
    for (const listener of [...this.#listeners]) listener();
  }

  /** Serves one combo; any resource or revision outside the live graph is 404. */
  resource(target: string): PluginPageResource {
    const parsed = parseCombo(target);
    if (!parsed) return { status: 404, headers: {} };
    const records = parsed.ids.map((id) =>
      id === LOADER_ID
        ? this.#loader
        : id === SECRET_MASK_ID
          ? this.#mask
          : this.#bundles.get(id),
    );
    if (records.some((record) => !record)) return { status: 404, headers: {} };
    const present = records as BundleRecord[];
    const rev =
      present.length === 1
        ? present[0]!.rev
        : hash(present.flatMap((record) => [record.id, record.rev]));
    if (rev !== parsed.rev) return { status: 404, headers: {} };
    return {
      status: 200,
      headers: {
        "Content-Type": "text/javascript; charset=utf-8",
        // Revisioned URLs are immutable; the graph changes the URL instead.
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      },
      body: Buffer.concat(present.map((record) => record.source)),
    };
  }
}

function compose(
  loader: BundleRecord | undefined,
  bundles: readonly BundleRecord[],
  mask?: BundleRecord,
): PluginPagesSnapshot {
  if (!loader)
    return {
      rev: "empty",
      loader: { module: LOADER_ID, rev: "", url: "" },
      bundles: [],
      graph: { rev: "empty", entries: [], batches: [] },
    };
  const loaderUrl = comboReference(LOADER_ID, loader.rev);
  const pages: AuraPluginPageBundle[] = bundles.map((record) => ({
    plugin: { ...record.plugin },
    module: record.id,
    rev: record.rev,
    url: comboReference(record.id, record.rev),
  }));
  const native = mask
    ? [
        {
          id: mask.id,
          url: comboReference(mask.id, mask.rev),
          rev: mask.rev,
          external: [...PAGE_EXTERNALS],
        },
      ]
    : [];
  const rev = hash([
    loader.rev,
    ...(mask ? [mask.rev] : []),
    ...pages.flatMap((page) => [page.module, page.rev]),
  ]);
  return {
    rev,
    loader: { module: LOADER_ID, rev: loader.rev, url: loaderUrl },
    bundles: pages,
    graph: {
      rev,
      entries: [
        { id: LOADER_ID, url: loaderUrl, rev: loader.rev, immediately: true },
        ...native,
        ...pages.map((page) => ({
          id: page.module,
          url: page.url,
          rev: page.rev,
          external: [...PAGE_EXTERNALS],
        })),
      ],
      // One single-resource batch per row keeps every URL directly servable
      // and lets one plugin's broken script fail alone.
      batches: [
        {
          phase: "bootstrap",
          url: loaderUrl,
          rev: loader.rev,
          entries: [LOADER_ID],
        },
        ...native.map((entry) => ({
          phase: "application" as const,
          url: entry.url,
          rev: entry.rev,
          entries: [entry.id],
        })),
        ...pages.map((page) => ({
          phase: "application" as const,
          url: page.url,
          rev: page.rev,
          entries: [page.module],
        })),
      ],
    },
  };
}
