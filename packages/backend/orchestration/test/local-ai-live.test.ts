import assert from "node:assert/strict";
import { mkdir, mkdtemp, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { OrchestrationHost } from "../src/index.ts";
import type { MediaResult } from "../src/local-ai/api.ts";
import type { FlowCatalog } from "@aura/protocol/types";

// Explicit opt-in: ordinary pnpm check never starts a model or occupies the GPU.
test(
  "opt-in deployed local model Actions through the real DSH ToolRuntime",
  {
    skip: process.env.AURA_TEST_LOCAL_AI !== "1",
    timeout: 1_800_000,
  },
  async () => {
    const root = resolve(import.meta.dirname, "../../../..");
    const parent = join(root, ".aura", "local-ai", "smoke");
    await mkdir(parent, { recursive: true });
    const dshHome = await mkdtemp(join(parent, "dsh-"));
    const host = new OrchestrationHost({
      root,
      dshHome,
      modelURL: "http://127.0.0.1:1/v1",
    });
    try {
      const catalog = await host.request<FlowCatalog>("catalog");
      for (const id of [
        "local-image",
        "local-video",
        "local-tts",
        "local-ai-service",
      ])
        assert(
          catalog.actions.some((a) => a.id === id && !a.unavailable),
          `${id} must load`,
        );
      const cases = [
        [
          "local-tts",
          {
            text: "你好，这是 Aura 的本地语音测试。",
            language: "Chinese",
            maxNewTokens: 128,
            seed: 42,
          },
        ],
        [
          "local-image",
          {
            prompt: "A red ceramic cup on a wooden table, soft natural light.",
            width: 512,
            height: 512,
            steps: 1,
            seed: 42,
          },
        ],
        [
          "local-video",
          {
            prompt:
              "A red ball slowly rolls across a wooden table. Soft ambient room sound.",
            width: 608,
            height: 352,
            frames: 22,
            seed: 42,
          },
        ],
      ] as const;
      for (const [id, input] of cases) {
        if (
          process.env.AURA_TEST_LOCAL_AI_ACTION &&
          !process.env.AURA_TEST_LOCAL_AI_ACTION.split(",").includes(id)
        )
          continue;
        console.log(`Starting deployed Action: ${id}`);
        const run = await host.invokeAction(id, { input, mode: "demo" });
        assert.equal(run.status, "completed", JSON.stringify(run));
        const output = run.output as unknown as MediaResult;
        for (const path of output.files) assert((await stat(path)).size > 0);
        console.log(JSON.stringify({ action: id, output }));
        const status = await host.invokeAction("local-ai-service", {
          input: { service: output.service, operation: "status" },
          mode: "demo",
        });
        assert.equal(
          (status.output as Record<string, unknown>).state,
          "stopped",
        );
      }
    } finally {
      await host.close();
    }
  },
);
