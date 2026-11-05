import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { OrchestrationHost } from "../src/dsh/host.ts";
import {
  GPT_IMAGE_CAPABILITY,
  MANAGED_PROCESS_PERMISSION,
} from "@aura/orchestration/host";

export async function localMediaFixture(modelURL = "http://127.0.0.1:1/v1") {
  const pluginRoot = process.env.AURA_TEST_LOCAL_MEDIA_PLUGIN;
  const modelRoot = process.env.AURA_TEST_LOCAL_MEDIA_MODELS;
  if (
    !pluginRoot ||
    !isAbsolute(pluginRoot) ||
    !modelRoot ||
    !isAbsolute(modelRoot)
  )
    throw new Error(
      "Set AURA_TEST_LOCAL_MEDIA_PLUGIN and AURA_TEST_LOCAL_MEDIA_MODELS to absolute paths.",
    );
  const root = await mkdtemp(join(tmpdir(), "aura-local-media-live-"));
  const plugin = { id: "local-media", name: "Local Media", version: "0.1.0" };
  const contribution = {
    namespace: plugin.id,
    plugin,
    pluginRoot,
    permissions: [MANAGED_PROCESS_PERMISSION, GPT_IMAGE_CAPABILITY],
  };
  const host = new OrchestrationHost({
    root,
    dshHome: join(root, "dsh"),
    modelURL,
    flowRoots: [{ ...contribution, root: join(pluginRoot, "flows") }],
    actionRoots: [{ ...contribution, root: join(pluginRoot, "actions") }],
    backendRoots: [
      {
        ...contribution,
        root: join(pluginRoot, "backend/dist/index.js"),
        settings: { modelRoot },
      },
    ],
  });
  return {
    host,
    pluginRoot,
    async close() {
      try {
        await host.close();
      } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 5 });
      }
    },
  };
}
