import type { AuraPluginStatus, FlowCatalog } from "@aura/protocol/types";
import { isPluginLocalization } from "@aura/protocol/localization";
import { readErrorDetails } from "@aura/protocol/errors";

/** Display catalogs stay out of child-process environment, model tools and execution state. */
export function executionPlugins(
  plugins: readonly AuraPluginStatus[],
): AuraPluginStatus[] {
  return plugins.map((plugin) => {
    const status = { ...plugin };
    delete status.localization;
    delete status.errorDetails;
    return status;
  });
}

/** Attach only active manifest metadata to the public, read-only catalog projection. */
export function catalogLocalization(
  catalog: FlowCatalog,
  plugins: readonly AuraPluginStatus[],
): FlowCatalog {
  const localized = new Map(
    plugins
      .filter(
        (plugin) => plugin.id && isPluginLocalization(plugin.localization),
      )
      .map((plugin) => [plugin.id, plugin.localization]),
  );
  return {
    ...catalog,
    ...(catalog.plugins
      ? {
          plugins: catalog.plugins.map((plugin, index) => {
            const localization = localized.get(plugin.id);
            const original = plugin.id
              ? plugins.find((item) => item.id === plugin.id)
              : plugins[index];
            const errorDetails =
              original?.error === plugin.error &&
              original?.enabled === plugin.enabled
                ? readErrorDetails(original?.errorDetails)
                : undefined;
            return {
              ...plugin,
              ...(localization ? { localization } : {}),
              ...(errorDetails ? { errorDetails } : {}),
            };
          }),
        }
      : {}),
  };
}
