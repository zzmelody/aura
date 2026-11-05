import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import sharp from "sharp";
import type { WorkflowArtifacts } from "@aura/protocol/types";
import { OrchestrationHost } from "../src/dsh/host.ts";
import { createFlowApp } from "../src/flow-routes.ts";

test(
  "real DSH registers Action media independently of output and streams it through the host after restart",
  { timeout: 30_000 },
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "aura-artifact-dsh-")),
    );
    const source = join(root, "fixture.png");
    const bytes = await sharp({
      create: { width: 12, height: 8, channels: 4, background: "#6942b4" },
    })
      .png()
      .toBuffer();
    const options = {
      root,
      dshHome: join(root, "dsh"),
      modelURL: "http://127.0.0.1:1/v1",
      flowRoot: join(root, "flow"),
      actionRoot: join(root, "action"),
    };
    let host = new OrchestrationHost(options);
    try {
      await mkdir(join(options.flowRoot, "media"), { recursive: true });
      await mkdir(join(options.actionRoot, "media"), { recursive: true });
      await writeFile(source, bytes);
      await writeFile(
        join(options.actionRoot, "media", "media.action.js"),
        `
import { defineAction } from ${JSON.stringify(import.meta.resolve("@aura/orchestration/action"))};
export default defineAction({ title: "Media fixture", description: "Registers a fixture image", parameters: {},
  output: { schema: { type: "string" }, render: (_, text) => [{ type: "text", text }] },
  async execute(ctx) { await ctx.artifacts.register(${JSON.stringify(source)}); return "unchanged-output"; }
});`,
      );
      await writeFile(
        join(options.flowRoot, "media", "media.flow.js"),
        `
import { defineFlow, z } from ${JSON.stringify(import.meta.resolve("@aura/orchestration/flow"))};
export default defineFlow({ title: "Media fixture", input: z.object({}), output: z.string(),
  async run(ctx) { return ctx.sequence({ id: "main" }, async scope => (await scope.action({ id: "produce", action: "media", input: {} })).output); }
});`,
      );
      const run = await host.invokeFlow("media", { input: {}, mode: "demo" });
      assert.equal(run.status, "completed", JSON.stringify(run));
      assert.equal(run.output, "unchanged-output");
      let app = createFlowApp(host);
      let listing: WorkflowArtifacts | undefined;
      for (let i = 0; i < 30; i++) {
        listing = (await (
          await app.request(`/runs/${run.id}/artifacts`)
        ).json()) as WorkflowArtifacts;
        if (listing.artifacts.length && !listing.pending) break;
        await delay(50);
      }
      assert.equal(listing?.artifacts.length, 1);
      const artifact = listing!.artifacts[0];
      assert.equal(artifact.status, "ready");
      assert.equal(artifact.stepKey, "main/produce");
      assert.equal(artifact.attempt, 1);
      assert.ok(artifact.callId);
      const path = `/runs/${run.id}/artifacts/${artifact.artifactId}/content`;
      const response = await app.request(path);
      assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
      await host.close();
      await rm(source);
      host = new OrchestrationHost(options);
      app = createFlowApp(host);
      const restored = await app.request(path);
      assert.equal(restored.status, 200);
      assert.deepEqual(Buffer.from(await restored.arrayBuffer()), bytes);
      const thumbnail = await app.request(
        path.replace("/content", "/thumbnail"),
      );
      assert.equal(thumbnail.status, 200);
      assert.equal(thumbnail.headers.get("content-type"), "image/webp");
      await thumbnail.arrayBuffer();
      assert.equal(
        (
          await app.request(
            `/runs/missing/artifacts/${artifact.artifactId}/content`,
          )
        ).status,
        404,
      );
    } finally {
      await host.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
