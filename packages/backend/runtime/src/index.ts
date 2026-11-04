/** Composition root shared by Aura's server and desktop application outputs. */
import { CodexSubscriptionAuth, readAiServices } from "@aura/dsh-auth";
import { AiServices } from "./ai-services.ts";
import {
  AuraPluginManager,
  type AuraPluginResolution,
  type PluginContributionRoot,
} from "@aura/plugin-manager";
import {
  GPT_IMAGE_CAPABILITY,
  MANAGED_PROCESS_PERMISSION,
  OrchestrationHost,
} from "@aura/orchestration";
import { createTripoService } from "@aura/tripo";
import { startApiServer } from "./api-server.ts";
import { startDemoModel } from "./demo-model.ts";
import { configureRuntimeNetwork } from "./network-proxy.ts";
import { pluginSdkPackage, pluginSdkVersion } from "./plugin-sdk-version.ts";
import { PluginPageRegistry } from "./plugin-pages.ts";
import {
  isLoopbackRuntimeHost,
  resolveRuntimeConfig,
} from "./runtime-config.ts";
import type {
  ApiServerHandle,
  AuraRuntimeHandle,
  AuraRuntimeOptions,
  DemoModelHandle,
} from "./types.ts";

export type { AuraRuntimeHandle, AuraRuntimeOptions } from "./types.ts";

function throwCleanupFailures(
  results: Array<PromiseSettledResult<void>>,
): void {
  const failures = results
    .filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    )
    .map((result) => result.reason);
  if (failures.length)
    throw new AggregateError(failures, "Aura runtime cleanup failed.");
}

/** Projects resolved plugin roots into the orchestration host's contribution shape. */
function contributions(resolution: AuraPluginResolution) {
  const root = ({
    path,
    pluginRoot,
    namespace,
    plugin,
    permissions,
    compatibility,
    http,
    presets,
  }: PluginContributionRoot) => ({
    root: path,
    pluginRoot,
    namespace,
    plugin,
    permissions,
    ...(compatibility ? { compatibility } : {}),
    ...(http ? { http } : {}),
    ...(presets ? { presets } : {}),
  });
  return {
    flowRoots: resolution.flowRoots.map(root),
    actionRoots: resolution.actionRoots.map(root),
    backendRoots: resolution.backendRoots.map((item) => ({
      ...root(item),
      ...(item.settings === undefined ? {} : { settings: item.settings }),
    })),
    plugins: resolution.plugins,
  };
}

/** Creates one isolated Aura backend runtime and all services it owns. */
export async function startAuraRuntime(
  options: AuraRuntimeOptions = {},
): Promise<AuraRuntimeHandle> {
  const config = resolveRuntimeConfig(options);
  await configureRuntimeNetwork();
  const pluginManager = await AuraPluginManager.create({
    configPath: config.pluginConfigPath,
    defaultPluginsDirectory: config.defaultPluginsDirectory,
    auraVersion: "0.1.0",
    pluginSdkVersion,
    supportedPermissions: [
      "aura.tripo.game-asset",
      "aura.flow.invoke",
      GPT_IMAGE_CAPABILITY,
      MANAGED_PROCESS_PERMISSION,
    ],
  });
  const plugins = pluginManager.resolution;
  const pluginPages = new PluginPageRegistry({
    onReloadError: () =>
      process.stderr.write("[aura] 插件页面更新未完成，继续使用上一版。\n"),
  });
  // Page bundles are served by this process; a broken bundle leaves the
  // workbench without plugin pages instead of failing runtime startup.
  await pluginPages.replace(plugins.pageRoots).catch(() => undefined);

  const codexAuth = await CodexSubscriptionAuth.create({
    credentialPath: config.credentialPath,
    model: config.codexModel,
  });
  const tripo = await createTripoService({
    credentialPath: config.tripoCredentialPath,
    region: config.tripoRegion,
    apiKey: process.env.TRIPO_API_KEY,
    resolveOptions: async () => ({
      credentialPath: config.tripoCredentialPath,
      region: (
        await readAiServices(config.root, config.codexModel, config.tripoRegion)
      ).tripoRegion,
      apiKey: process.env.TRIPO_API_KEY,
    }),
  });
  let demoModel: DemoModelHandle | undefined;
  let api: ApiServerHandle | undefined;
  let flows: OrchestrationHost | undefined;

  try {
    demoModel = await startDemoModel();
    flows = new OrchestrationHost({
      root: config.root,
      dshHome: config.dshHome,
      modelURL: demoModel.url,
      codexModel: config.codexModel,
      ...contributions(plugins),
      tripoCredentialPath: config.tripoCredentialPath,
      tripoRegion: config.tripoRegion,
      tempDir: config.tempDir,
      defaultWorkspace: config.defaultWorkspace,
      localIntegrations: isLoopbackRuntimeHost(config.host),
      pluginSdkPackage,
    });
    let activePageRoots = plugins.pageRoots;
    pluginManager.setActivator(async (resolution) => {
      await pluginPages.replace(resolution.pageRoots);
      try {
        await flows!.configureContributions(contributions(resolution));
      } catch (error) {
        // Keep pages and backend contributions on the same configuration.
        await pluginPages.replace(activePageRoots).catch(() => undefined);
        throw error;
      }
      activePageRoots = resolution.pageRoots;
    });
    // Start the long-lived DSH host now rather than on the first request, so
    // its cold start (20–35 s on Windows) is not charged to whatever the user
    // opens first. A failed start is retried by the next request.
    // The host records sanitized failures in terminal and local diagnostics.
    void flows.open().catch(() => undefined);
    api = await startApiServer({
      config,
      codexAuth,
      tripo,
      flows,
      pluginSettings: pluginManager,
      pluginSettingsAccessible: isLoopbackRuntimeHost(config.host),
      pluginPages,
      aiServices: new AiServices(config, codexAuth, tripo, async () =>
        flows?.opening ? flows.request<boolean>("ai-services/busy", {}) : false,
      ),
    });
    pluginPages.startWatching();
  } catch (error) {
    const cleanups: Array<Promise<void>> = [
      codexAuth.close(),
      pluginPages.close(),
    ];
    if (api) cleanups.push(api.close());
    if (flows) cleanups.push(flows.close());
    if (demoModel) cleanups.push(demoModel.close());
    await Promise.allSettled(cleanups);
    throw error;
  }

  let closed = false;
  return {
    url: api.url,
    async ready() {
      await flows.open();
    },
    async close() {
      if (closed) return;
      closed = true;
      await pluginPages.close();
      // Stop flow sessions before removing their local model endpoint.
      const flowResults = await Promise.allSettled([flows.close()]);
      const results = await Promise.allSettled([
        api.close(),
        demoModel.close(),
        codexAuth.close(),
      ]);
      throwCleanupFailures([...flowResults, ...results]);
    },
  };
}
