import type {
  AuraPluginSettingsState,
  AuraPluginSettingsUpdate,
} from "@aura/protocol/types";

type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

async function pluginSettingsRequest(
  endpoint: string,
  init: RequestInit,
  fetcher: Fetcher,
): Promise<AuraPluginSettingsState> {
  const response = await fetcher(
    `${endpoint.replace(/\/$/u, "")}/plugins/config`,
    init,
  );
  const result = (await response.json().catch(() => null)) as
    AuraPluginSettingsState | { message?: string } | null;
  if (!response.ok)
    throw new Error(
      (result &&
        typeof result === "object" &&
        "message" in result &&
        result.message) ||
        `插件目录读取失败（${response.status}）。`,
    );
  return result as AuraPluginSettingsState;
}

export function readPluginSettings(
  endpoint: string,
  signal?: AbortSignal,
  fetcher: Fetcher = fetch,
) {
  return pluginSettingsRequest(endpoint, { signal }, fetcher);
}

export function savePluginSettings(
  endpoint: string,
  update: AuraPluginSettingsUpdate,
  fetcher: Fetcher = fetch,
) {
  return pluginSettingsRequest(
    endpoint,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(update),
    },
    fetcher,
  );
}

export function editablePluginEntries(state: AuraPluginSettingsState) {
  return state.plugins.map(({ path, enabled }) => ({ path, enabled }));
}
