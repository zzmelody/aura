import type {
  AuraPluginPageBundle,
  AuraPluginPagesState,
  JsonValue,
} from "@aura/protocol/types";

const LOADER_ID = "@deepseek-ai/dsh-client-modules";

export interface PluginPageGraph {
  rev: string;
  entries: Array<{
    id: string;
    url: string;
    rev: string;
    immediately?: boolean;
    external?: string[];
  }>;
  batches: Array<{
    phase: "bootstrap" | "application";
    url: string;
    rev: string;
    entries: string[];
  }>;
}

export interface PluginPagesSnapshot extends AuraPluginPagesState {
  graph?: PluginPageGraph;
}

export function pluginTab(pageId: string): `plugin:${string}` {
  return `plugin:${pageId}`;
}

export function isPluginTab(tab: string): tab is `plugin:${string}` {
  return tab.startsWith("plugin:");
}

export function pluginTabId(tab: `plugin:${string}`): string {
  return tab.slice("plugin:".length);
}

function runtimeUrl(endpoint: string, path: string): string {
  const base = endpoint.endsWith("/") ? endpoint : `${endpoint}/`;
  return new URL(path.replace(/^\//u, ""), base).href;
}

export async function readPluginPages(
  endpoint: string,
  signal?: AbortSignal,
): Promise<PluginPagesSnapshot> {
  const response = await fetch(runtimeUrl(endpoint, "plugins/pages"), {
    signal,
  });
  const result = (await response.json().catch(() => null)) as
    PluginPagesSnapshot | { message?: string } | null;
  if (!response.ok)
    throw new Error(
      (result &&
        typeof result === "object" &&
        "message" in result &&
        result.message) ||
        `插件页面读取失败（${response.status}）。`,
    );
  return result as PluginPagesSnapshot;
}

export async function readPluginGraph(
  endpoint: string,
  signal?: AbortSignal,
): Promise<PluginPageGraph> {
  const response = await fetch(runtimeUrl(endpoint, "plugins/graph"), {
    signal,
  });
  if (!response.ok)
    throw new Error(`插件模块图读取失败（${response.status}）。`);
  return (await response.json()) as PluginPageGraph;
}

export async function invokePluginPage(
  endpoint: string,
  pluginId: string,
  capabilityLocalId: string,
  operation: string,
  input: JsonValue = null,
  signal?: AbortSignal,
): Promise<JsonValue> {
  const response = await fetch(
    runtimeUrl(
      endpoint,
      `plugins/pages/${encodeURIComponent(pluginId)}/invoke`,
    ),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        capability: `${pluginId}/${capabilityLocalId}`,
        operation,
        input,
      }),
      signal,
    },
  );
  const result = (await response.json().catch(() => null)) as
    JsonValue | { message?: string } | null;
  if (!response.ok)
    throw new Error(
      (result &&
        typeof result === "object" &&
        result !== null &&
        "message" in result &&
        typeof result.message === "string" &&
        result.message) ||
        `插件页面调用失败（${response.status}）。`,
    );
  return result as JsonValue;
}

export function watchPluginGraph(
  endpoint: string,
  onGraph: (graph: PluginPageGraph) => void,
): () => void {
  const source = new EventSource(runtimeUrl(endpoint, "plugins/events"));
  const handle = (event: MessageEvent<string>) => {
    try {
      const payload = JSON.parse(event.data) as {
        type?: string;
        graph?: PluginPageGraph;
      };
      if (payload.graph) onGraph(payload.graph);
    } catch {
      /* Malformed frames are ignored; the next graph event recovers. */
    }
  };
  source.addEventListener("graph", handle);
  source.onmessage = handle;
  return () => source.close();
}

export { LOADER_ID };
export type { AuraPluginPageBundle };
