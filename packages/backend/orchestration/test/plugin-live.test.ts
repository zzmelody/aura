import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { FlowCatalog, FlowRun } from "@aura/protocol/types";
import { OrchestrationHost } from "../src/index.ts";

const nodeMajor = Number(process.versions.node.split(".")[0]);

async function catalogFlow(
  host: OrchestrationHost,
  id: string,
  predicate: (flow: FlowCatalog["flows"][number] | undefined) => boolean,
) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const catalog = await host.request<FlowCatalog>("catalog");
    const flow = catalog.flows.find((item) => item.id === id);
    if (predicate(flow)) return { catalog, flow };
    await delay(150);
  }
  throw new Error(`Catalog did not reach the expected state for ${id}`);
}

test(
  "live plugin configuration applies, hot reloads and preserves a pinned run",
  {
    timeout: 120_000,
    skip:
      nodeMajor < 24
        ? "DSH and native TypeScript loading require the repository Node >=24 baseline"
        : false,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "aura-live-plugin-test-"));
    const flowRoot = join(root, "builtin-flow");
    const actionRoot = join(root, "builtin-action");
    const pluginRoot = join(root, "external-flow");
    const flowDirectory = join(pluginRoot, "story");
    await Promise.all([
      mkdir(flowRoot, { recursive: true }),
      mkdir(actionRoot, { recursive: true }),
      mkdir(flowDirectory, { recursive: true }),
    ]);
    const apiUrl = new URL("../src/flow-api.ts", import.meta.url).href;
    const helper = join(flowDirectory, "helper.js");
    await writeFile(helper, 'export const version = "v1";\n');
    await writeFile(
      join(flowDirectory, "story.flow.js"),
      `
import { defineFlow, z } from ${JSON.stringify(apiUrl)};
import { version } from "./helper.js";
export default defineFlow({
  title: "Live plugin " + version,
  input: z.object({ checkpoint: z.boolean() }),
  output: z.object({ report: z.string() }),
  async run(ctx, input) {
    if (input.checkpoint) {
      await ctx.sequence({ id: "main" }, (flow) => flow.checkpoint({
        id: "approval",
        prompt: "Continue",
        schema: z.object({ ok: z.boolean() }),
      }));
    }
    return { report: version };
  },
});
`,
    );

    const plugin = {
      id: "test.live",
      name: "Live Test",
      version: "1.0.0",
    };
    const configuration = {
      flowRoots: [{ root: pluginRoot, namespace: plugin.id, plugin }],
      actionRoots: [],
      plugins: [{ ...plugin, enabled: true, available: true }],
    };
    const host = new OrchestrationHost({
      root,
      flowRoot,
      actionRoot,
      dshHome: join(root, "dsh"),
      modelURL: "http://127.0.0.1:1/v1",
    });

    try {
      const before = await host.request<FlowCatalog>("catalog");
      assert.equal(
        before.flows.some(({ id }) => id === "test.live/story"),
        false,
      );

      await host.configureContributions(configuration);
      const loaded = await catalogFlow(
        host,
        "test.live/story",
        (flow) => flow?.available === true && flow.title.endsWith("v1"),
      );
      assert.equal(loaded.catalog.plugins[0]?.id, plugin.id);

      const first = await host.invokeFlow("test.live/story", {
        input: { checkpoint: false },
        mode: "demo",
      });
      assert.deepEqual(first.output, { report: "v1" });

      const firstHash = loaded.flow!.sourceHash;
      await writeFile(helper, 'export const version = "v2";\n');
      await catalogFlow(
        host,
        "test.live/story",
        (flow) =>
          flow?.available === true &&
          flow.title.endsWith("v2") &&
          flow.sourceHash !== firstHash,
      );

      const pinned = await host.request<FlowRun>("start", {
        requestId: randomUUID(),
        flowId: "test.live/story",
        mode: "demo",
        input: { checkpoint: true },
      });
      const waiting = await host.request<FlowRun>("wait", { id: pinned.id });
      assert.equal(waiting.status, "waiting_input");

      await host.configureContributions({
        flowRoots: [],
        actionRoots: [],
        plugins: [{ ...plugin, enabled: false, available: false }],
      });
      await catalogFlow(host, "test.live/story", (flow) => flow === undefined);
      await host.request("answer", {
        id: pinned.id,
        stepKey: "main/approval",
        requestId: randomUUID(),
        output: { ok: true },
      });
      const completed = await host.request<FlowRun>("wait", { id: pinned.id });
      assert.equal(completed.status, "completed", JSON.stringify(completed));
      assert.deepEqual(completed.output, { report: "v2" });

      await host.configureContributions(configuration);
      await catalogFlow(
        host,
        "test.live/story",
        (flow) => flow?.available === true && flow.title.endsWith("v2"),
      );

      const brokenRoot = join(root, "broken-external-flow");
      await mkdir(join(brokenRoot, "broken"), { recursive: true });
      await writeFile(
        join(brokenRoot, "broken", "broken.flow.js"),
        "export default ;\n",
      );
      const brokenPlugin = {
        id: "test.broken",
        name: "Broken Test",
        version: "1.0.0",
      };
      await assert.rejects(
        host.configureContributions({
          flowRoots: [
            {
              root: brokenRoot,
              namespace: brokenPlugin.id,
              plugin: brokenPlugin,
            },
          ],
          actionRoots: [],
          plugins: [{ ...brokenPlugin, enabled: true, available: true }],
        }),
        /加载失败/,
      );
      const rolledBack = await host.request<FlowCatalog>("catalog");
      assert.equal(
        rolledBack.flows.find(({ id }) => id === "test.live/story")?.available,
        true,
      );
      assert.equal(rolledBack.plugins[0]?.id, plugin.id);
    } finally {
      await host.close();
      assert.equal(dirname(resolve(root)), resolve(tmpdir()));
      assert.ok(basename(root).startsWith("aura-live-plugin-test-"));
      await rm(root, { recursive: true, force: true });
    }
  },
);
