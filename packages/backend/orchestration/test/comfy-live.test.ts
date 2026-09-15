import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { FlowCatalog } from "@aura/protocol/types";
import { OrchestrationHost } from "../src/index.ts";
import type { ComfyWorkflowResult } from "../src/local-ai/api.ts";

test(
  "opt-in real ComfyUI API workflow Action: JSON/file/overrides/saved and preview outputs",
  {
    skip: process.env.AURA_TEST_COMFY_WORKFLOW !== "1",
    timeout: 480_000,
  },
  async () => {
    const root = resolve(import.meta.dirname, "../../../..");
    const parent = join(root, ".aura", "local-ai", "smoke");
    await mkdir(parent, { recursive: true });
    const dshHome = await mkdtemp(join(parent, "comfy-"));
    const path = fileURLToPath(
      new URL("../docs/examples/solid-image.api.json", import.meta.url),
    );
    const workflow = JSON.parse(await readFile(path, "utf8")) as Record<
      string,
      unknown
    >;
    const host = new OrchestrationHost({
      root,
      dshHome,
      modelURL: "http://127.0.0.1:1/v1",
    });
    try {
      const catalog = await host.request<FlowCatalog>("catalog");
      assert(
        catalog.actions.some(
          (a) => a.id === "comfy-workflow" && !a.unavailable,
        ),
      );
      for (const service of ["qwen-image", "minimax-h3"] as const) {
        console.log(`Submitting custom workflow to ${service}`);
        const run = await host.invokeAction("comfy-workflow", {
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
        const result = run.output as unknown as ComfyWorkflowResult;
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
        const status = await host.invokeAction("local-ai-service", {
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
      await host.close();
    }
  },
);
