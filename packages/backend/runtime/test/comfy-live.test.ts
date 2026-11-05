import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import type { FlowCatalog } from "@aura/protocol/types";
import { localMediaFixture } from "./local-media-fixture.ts";

test(
  "opt-in real ComfyUI API workflow Action: JSON/file/overrides/saved and preview outputs",
  {
    skip: process.env.AURA_TEST_COMFY_WORKFLOW !== "1",
    timeout: 480_000,
  },
  async () => {
    const fixture = await localMediaFixture();
    const { host } = fixture;
    try {
      const path = join(fixture.pluginRoot, "examples", "solid-image.api.json");
      const workflow: unknown = JSON.parse(await readFile(path, "utf8"));
      const catalog = await host.request<FlowCatalog>("catalog");
      assert(
        catalog.actions?.some(
          (a) => a.id === "local-media/comfy-workflow" && a.available,
        ),
      );
      for (const service of ["qwen-image", "minimax-h3"] as const) {
        console.log(`Submitting custom workflow to ${service}`);
        const run = await host.invokeAction("local-media/comfy-workflow", {
          mode: "demo",
          input: {
            service,
            ...(service === "qwen-image"
              ? { workflow }
              : { workflowFile: path }),
            ...(service === "qwen-image"
              ? { overrides: { source: { width: 96, height: 80 } } }
              : {}),
          },
        });
        assert.equal(run.status, "completed", JSON.stringify(run));
        const result = run.output as unknown as {
          workflowHash: string;
          files: string[];
          outputs: Record<string, unknown>;
        };
        assert.match(result.workflowHash, /^[0-9a-f]{64}$/);
        assert.equal(result.files.length, 2);
        assert.deepEqual(Object.keys(result.outputs).sort(), [
          "preview",
          "saved",
        ]);
        for (const file of result.files) {
          const png = await readFile(file);
          assert.equal(png.subarray(1, 4).toString(), "PNG");
          assert.equal(
            png.readUInt32BE(16),
            service === "qwen-image" ? 96 : 64,
          );
          assert.equal(
            png.readUInt32BE(20),
            service === "qwen-image" ? 80 : 64,
          );
        }
        assert.deepEqual(await readdir(dirname(dirname(result.files[0]))), [
          "artifacts",
        ]);
        const status = await host.invokeAction("local-media/local-ai-service", {
          mode: "demo",
          input: { service, operation: "status" },
        });
        assert.equal(
          (status.output as Record<string, unknown>).state,
          "stopped",
        );
        console.log(JSON.stringify(result));
      }
    } finally {
      await fixture.close();
    }
  },
);
