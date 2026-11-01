import type { ChatModelCatalog, FlowMode } from "@aura/protocol/types";
import { startupFetch } from "./startup-fetch.ts";
import { type StartupCache, startupCache } from "./startup-cache.ts";

export interface ModelCatalogSnapshot {
  catalog?: ChatModelCatalog;
  loading: boolean;
  error: string;
  /** Restored from the previous window; a live read always validates it. */
  restored?: boolean;
}
interface Entry {
  endpoint: string;
  mode: FlowMode;
  snapshot: ModelCatalogSnapshot;
  listeners: Set<() => void>;
  request?: AbortController;
  pending?: Promise<void>;
  updatedAt: number;
}

/** Shared by startup and every composer; no settings or credentials are stored. */
export class ModelCatalogStore {
  private readonly entries = new Map<string, Entry>();
  private readonly fetcher: typeof startupFetch;
  private readonly cache: StartupCache;

  constructor(fetcher = startupFetch, cache: StartupCache = startupCache) {
    this.fetcher = fetcher;
    this.cache = cache;
  }
  private entry(endpoint: string, mode: FlowMode) {
    const key = `${endpoint.replace(/\/$/u, "")}/${mode}`;
    let entry = this.entries.get(key);
    if (!entry) {
      const catalog = this.cache.models(endpoint, mode);
      entry = {
        endpoint: endpoint.replace(/\/$/u, ""),
        mode,
        snapshot: { catalog, loading: false, error: "", restored: !!catalog },
        listeners: new Set(),
        updatedAt: 0,
      };
      this.entries.set(key, entry);
      // Keep active subscribers; discard the oldest inactive endpoint choices.
      for (const [id, old] of this.entries) {
        if (this.entries.size <= 32) break;
        if (old !== entry && !old.listeners.size && !old.request)
          this.entries.delete(id);
      }
    }
    return entry;
  }

  snapshot(endpoint: string, mode: FlowMode) {
    return this.entry(endpoint, mode).snapshot;
  }

  subscribe(endpoint: string, mode: FlowMode, listener: () => void) {
    const entry = this.entry(endpoint, mode);
    entry.listeners.add(listener);
    if (
      entry.snapshot.restored ||
      !entry.snapshot.catalog ||
      Date.now() - entry.updatedAt > 60_000
    )
      void this.refresh(endpoint, mode);
    return () => {
      entry.listeners.delete(listener);
      if (!entry.listeners.size && entry.request) {
        entry.request.abort();
        entry.request = undefined;
        entry.pending = undefined;
        entry.snapshot = { ...entry.snapshot, loading: false };
      }
    };
  }

  refresh(endpoint: string, mode: FlowMode): Promise<void> {
    const entry = this.entry(endpoint, mode);
    if (entry.pending) return entry.pending;
    const pending = this.read(entry);
    entry.pending = pending;
    void pending.finally(() => {
      if (entry.pending === pending) entry.pending = undefined;
    });
    return pending;
  }

  private async read(entry: Entry) {
    const mode = entry.mode;
    const request = new AbortController();
    entry.request = request;
    const receive = (snapshot: ModelCatalogSnapshot) => {
      if (entry.request !== request || request.signal.aborted) return;
      entry.snapshot = snapshot;
      for (const listener of entry.listeners) listener();
    };
    receive({ ...entry.snapshot, loading: true, error: "" });
    try {
      const response = await this.fetcher(
        `${entry.endpoint}/chat/models?mode=${mode}`,
        request.signal,
      );
      if (!response.ok) throw new Error("模型目录暂时不可用");
      const catalog: ChatModelCatalog = await response.json();
      if (
        catalog.mode !== mode ||
        typeof catalog.defaultModel !== "string" ||
        !Array.isArray(catalog.models) ||
        !catalog.models.every(
          (model) =>
            typeof model?.id === "string" &&
            typeof model?.name === "string" &&
            Array.isArray(model.reasoningEfforts) &&
            model.reasoningEfforts.every(
              (effort) =>
                typeof effort?.id === "string" &&
                typeof effort?.name === "string",
            ),
        )
      )
        throw new Error("模型目录格式不可用");
      if (entry.request !== request || request.signal.aborted) return;
      entry.updatedAt = Date.now();
      this.cache.saveModels(entry.endpoint, catalog);
      receive({ catalog, loading: false, error: "" });
    } catch {
      receive({
        ...entry.snapshot,
        loading: false,
        error: "模型目录暂时不可用",
      });
    } finally {
      if (entry.request === request) entry.request = undefined;
    }
  }

  invalidate(endpoint: string) {
    this.cache.forgetModels(endpoint);
    const normalized = endpoint.replace(/\/$/u, "");
    for (const entry of this.entries.values()) {
      if (entry.endpoint !== normalized) continue;
      entry.updatedAt = 0;
      entry.request?.abort();
      entry.request = undefined;
      entry.pending = undefined;
      if (entry.listeners.size) void this.refresh(entry.endpoint, entry.mode);
    }
  }

  close() {
    for (const entry of this.entries.values()) {
      entry.request?.abort();
      entry.listeners.clear();
    }
    this.entries.clear();
  }
}

export const modelCatalogs = new ModelCatalogStore();
