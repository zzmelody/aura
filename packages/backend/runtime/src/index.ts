/** Composition root shared by Aura's server and desktop application outputs. */
import { CodexSubscriptionAuth, readAiServices } from "@aura/dsh-auth";
import { AiServices } from "./ai-services.ts";
import {
  AuraPluginManager,
  type AuraPluginResolution,
  type PluginContributionRoot,
} from "@aura/extensions";
import { OrchestrationHost } from "@aura/orchestration";
import { createTripoService } from "@aura/tripo";
import { startApiServer } from "./api-server.ts";
import { startDemoModel } from "./demo-model.ts";
import { configureRuntimeNetwork } from "./network-proxy.ts";
import { pluginSdkVersion } from "./plugin-sdk-version.ts";
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
    capabilities,
  }: PluginContributionRoot) => ({
    root: path,
    pluginRoot,
    namespace,
    plugin,
    capabilities,
  });
  return {
    flowRoots: resolution.flowRoots.map(root),
    actionRoots: resolution.actionRoots.map(root),
    capabilityRoots: resolution.capabilityRoots.map((item) => ({
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
    auraVersion: "0.1.0",
    pluginSdkVersion,
    supportedCapabilities: ["aura.tripo.game-asset", "aura.flow.invoke"],
  });
  const plugins = pluginManager.resolution;

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
    });
    pluginManager.setActivator((resolution) =>
      flows!.configureContributions(contributions(resolution)),
    );
    api = await startApiServer({
      config,
      codexAuth,
      tripo,
      flows,
      pluginSettings: pluginManager,
      pluginSettingsAccessible: isLoopbackRuntimeHost(config.host),
      aiServices: new AiServices(config, codexAuth, tripo, async () =>
        flows?.opening ? flows.request<boolean>("ai-services/busy", {}) : false,
      ),
    });
  } catch (error) {
    const cleanups: Array<Promise<void>> = [codexAuth.close()];
    if (api) cleanups.push(api.close());
    if (flows) cleanups.push(flows.close());
    if (demoModel) cleanups.push(demoModel.close());
    await Promise.allSettled(cleanups);
    throw error;
  }

  let closed = false;
  return {
    url: api.url,
    async close() {
      if (closed) return;
      closed = true;
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
