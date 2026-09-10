/** Composition root shared by Aura's server and desktop application outputs. */
import { CodexSubscriptionAuth } from "@aura/dsh-auth";
import { OrchestrationHost } from "@aura/orchestration";
import { startApiServer } from "./api-server.ts";
import { startDemoModel } from "./demo-model.ts";
import { DshSessionRunner } from "./dsh-session-runner.ts";
import { configureRuntimeNetwork } from "./network-proxy.ts";
import { prepareDshProfile, resolveRuntimeConfig } from "./runtime-config.ts";
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

  const codexAuth = await CodexSubscriptionAuth.create({
    credentialPath: config.credentialPath,
    model: config.codexModel,
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
    });
    api = await startApiServer({ config, codexAuth, dsh, flows });
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
