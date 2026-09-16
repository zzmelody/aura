/** Composition root shared by Aura's server and desktop application outputs. */
import { CodexSubscriptionAuth } from "@aura/dsh-auth";
import { AuraPluginManager } from "@aura/extensions";
import { OrchestrationHost } from "@aura/orchestration";
import { createTripoService } from "@aura/tripo";
import { startApiServer } from "./api-server.ts";
import { startDemoModel } from "./demo-model.ts";
import { DshSessionRunner } from "./dsh-session-runner.ts";
import { configureRuntimeNetwork } from "./network-proxy.ts";
import {
  isLoopbackRuntimeHost,
  prepareDshProfile,
  resolveRuntimeConfig,
} from "./runtime-config.ts";
import type {
  ApiServerHandle,
  AuraRuntimeHandle,
  AuraRuntimeOptions,
  DemoModelHandle,
} from "./types.ts";

export type { AuraRuntimeHandle, AuraRuntimeOptions } from "./types.ts";

function throwCleanupFailures(results: PromiseSettledResult<void>[]): void {
  const failures = results
    .filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    )
    .map((result) => result.reason);
  if (failures.length)
    throw new AggregateError(failures, "Aura runtime cleanup failed.");
}

/** Creates one isolated Aura backend runtime and all services it owns. */
export async function startAuraRuntime(
  options: AuraRuntimeOptions = {},
): Promise<AuraRuntimeHandle> {
  const config = resolveRuntimeConfig(options);
  await configureRuntimeNetwork();
  await prepareDshProfile(config);
  const pluginManager = await AuraPluginManager.create({
    configPath: config.pluginConfigPath,
    auraVersion: "0.1.0",
    pluginSdkVersion: "1.1.0",
    supportedCapabilities: ["aura.veya.world-agent"],
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
  });
  let demoModel: DemoModelHandle | undefined;
  let dsh: DshSessionRunner | undefined;
  let api: ApiServerHandle | undefined;
  let flows: OrchestrationHost | undefined;

  try {
    demoModel = await startDemoModel();
    dsh = new DshSessionRunner({
      root: config.root,
      dshHome: config.dshHome,
      dshExecutable: config.dshExecutable,
      demoModelUrl: demoModel.url,
    });
    flows = new OrchestrationHost({
      root: config.root,
      dshHome: config.dshHome,
      modelURL: demoModel.url,
      codexModel: config.codexModel,
      flowRoots: plugins.flowRoots.map(
        ({ path, namespace, plugin, capabilities }) => ({
          root: path,
          namespace,
          plugin,
          capabilities,
        }),
      ),
      actionRoots: plugins.actionRoots.map(
        ({ path, namespace, plugin, capabilities }) => ({
          root: path,
          namespace,
          plugin,
          capabilities,
        }),
      ),
      plugins: plugins.plugins,
      worldAgentSessionPath: config.worldAgentSessionPath,
    });
    pluginManager.setActivator((resolution) =>
      flows!.configureContributions({
        flowRoots: resolution.flowRoots.map(
          ({ path, namespace, plugin, capabilities }) => ({
            root: path,
            namespace,
            plugin,
            capabilities,
          }),
        ),
        actionRoots: resolution.actionRoots.map(
          ({ path, namespace, plugin, capabilities }) => ({
            root: path,
            namespace,
            plugin,
            capabilities,
          }),
        ),
        plugins: resolution.plugins,
      }),
    );
    api = await startApiServer({
      config,
      codexAuth,
      dsh,
      tripo,
      flows,
      pluginSettings: pluginManager,
      pluginSettingsAccessible: isLoopbackRuntimeHost(config.host),
    });
  } catch (error) {
    const cleanups: Promise<void>[] = [codexAuth.close()];
    if (api) cleanups.push(api.close());
    if (dsh) cleanups.push(dsh.close());
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
        dsh.close(),
        demoModel.close(),
        codexAuth.close(),
      ]);
      throwCleanupFailures([...flowResults, ...results]);
    },
  };
}
