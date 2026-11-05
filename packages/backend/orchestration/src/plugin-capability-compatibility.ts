import { ActionFailure, type AuraCapabilityClient } from "./action-api.ts";
import type { PluginBackends } from "./plugin-backends.ts";
import { jsonValue } from "./schema.ts";

export const LEGACY_TRIPO_PERMISSION = "aura.tripo.game-asset";

/** Keep existing Veya grants working through the installed Tripo backend. */
export function legacyTripoCapability(
  backends: () => Pick<PluginBackends, "request">,
): AuraCapabilityClient {
  return {
    async invoke(_capability, operation, input, signal) {
      if (!["generate", "image", "ledger"].includes(operation))
        throw new ActionFailure("Tripo 操作无效。");
      signal.throwIfAborted();
      try {
        return jsonValue(
          await backends().request(
            "aura.tripo/legacy-capability",
            { operation, input },
            signal,
          ),
          "Tripo 操作结果",
        );
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "plugin_request_unavailable"
        )
          throw new ActionFailure("请启用 Tripo 插件。");
        throw error;
      }
    },
  };
}
