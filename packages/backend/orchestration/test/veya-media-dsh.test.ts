import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import type { FlowRun, FlowCatalog } from "@aura/protocol/types";
import { OrchestrationHost } from "../src/index.ts";

// Real DSH attachment storage and Flow session dispatch, simulated native HTTP.
// The demo model is text-only: it must reject images, never silently drop them.
test(
  "real DSH admits a Veya capture and rejects a text-only model without stripping the image",
  {
    timeout: 60_000,
    skip:
      Number(process.versions.node.split(".")[0]) < 24
        ? "Requires Node 24"
        : false,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "aura-veya-image-dsh-"));
    const previews = join(root, "previews"),
      actionRoot = join(root, "actions"),
      flowRoot = join(root, "flows");
    await Promise.all([
      mkdir(previews),
      mkdir(join(actionRoot, "capture"), { recursive: true }),
      mkdir(join(flowRoot, "vision"), { recursive: true }),
    ]);
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const captureId = "a".repeat(32),
      sha = createHash("sha256").update(png).digest("hex");
    await writeFile(join(previews, `${captureId}.png`), png);
    const actionApi = JSON.stringify(
      new URL("../src/action-api.ts", import.meta.url).href,
    );
    const flowApi = JSON.stringify(
      new URL("../src/flow-api.ts", import.meta.url).href,
    );
    await writeFile(
      join(actionRoot, "capture", "capture.action.js"),
      `
import { defineAction, ActionFailure } from ${actionApi};
export default defineAction({ title: "Capture fixture", description: "Capture test image", parameters: {},
 output: { schema: { type: "object", additionalProperties: true }, render: (_, value) => [{type:"image",attachment:value.image}] },
 async execute(ctx) { try { return await ctx.aura.invoke("aura.veya.world-agent","veya.preview.capture",{},ctx.signal); } catch(error) { throw new ActionFailure(String(error)); } }
});`,
    );
    await writeFile(
      join(flowRoot, "vision", "vision.flow.js"),
      `
import { defineFlow, z } from ${flowApi};
export default defineFlow({ title:"Vision seam", input:z.object({}), output:z.json(),
 async run(root) { return root.sequence({id:"main"},async ctx => {
  const capture = (await ctx.action({id:"capture",action:"capture",input:{}})).output;
  const view = await ctx.agent({id:"view",label:"view",preset:"researcher-v1",prompt:"Inspect the attached fixture",images:[capture.image],actions:[]});
  return {image:capture.image,report:view.output};
 }); }
});`,
    );
    const requests: unknown[] = [];
    const app = new Hono();
    app.post("/agent/v1/call", async (c) => {
      assert.equal(c.req.header("authorization"), `Bearer ${"b".repeat(64)}`);
      assert.equal((await c.req.json()).tool, "veya.preview.capture");
      return c.json({
        ok: true,
        data: {
          capture_id: captureId,
          bytes: png.length,
          sha256: sha,
          mime_type: "image/png",
        },
      });
    });
    app.post("/v1/chat/completions", async (c) => {
      requests.push(await c.req.json());
      const chunks = [
        {
          choices: [
            {
              index: 0,
              delta: { content: "fixture received" },
              finish_reason: null,
            },
          ],
        },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ];
      return c.body(
        chunks.map((x) => `data: ${JSON.stringify(x)}\n\n`).join("") +
          "data: [DONE]\n\n",
        200,
        { "Content-Type": "text/event-stream" },
      );
    });
    let server!: ServerType, host: OrchestrationHost | undefined;
    try {
      const port = await new Promise<number>((done, fail) => {
        server = serve(
          { fetch: app.fetch, hostname: "127.0.0.1", port: 0 },
          ({ port }) => done(port),
        );
        server.once("error", fail);
      });
      const descriptor = join(root, "session.json");
      await writeFile(
        descriptor,
        JSON.stringify({
          protocol: "veya-world-http/1",
          tools_protocol: "veya-agent-tools/1",
          base_url: `http://127.0.0.1:${port}`,
          token: "b".repeat(64),
          preview_root: previews,
        }),
      );
      host = new OrchestrationHost({
        root,
        actionRoot: join(root, "empty-actions"),
        actionRoots: [
          { root: actionRoot, capabilities: ["aura.veya.world-agent"] },
        ],
        flowRoot,
        dshHome: join(root, "dsh"),
        modelURL: `http://127.0.0.1:${port}/v1`,
        worldAgentSessionPath: descriptor,
      });
      const catalog = await host.request<FlowCatalog>("catalog");
      assert.equal(
        catalog.actions?.find((x) => x.id === "capture")?.available,
        true,
        JSON.stringify(catalog.actions),
      );
      const run: FlowRun = await host.invokeFlow("vision", {
        input: {},
        mode: "demo",
      });
      assert.equal(run.steps[0]?.status, "completed", JSON.stringify(run));
      const imageRef = (run.steps[0]?.output as any).image;
      assert.match(imageRef.attachmentId, /^sha256:[a-f0-9]{64}$/u);
      assert.equal(imageRef.mediaType, "image/webp");
      assert.equal(run.status, "failed");
      assert.match(run.error ?? "", /MODEL_DOES_NOT_SUPPORT_IMAGES/u);
      assert.equal(
        requests.length,
        0,
        "no text-only fallback request may be made",
      );
      assert.ok(
        !JSON.stringify(run).includes(png.toString("base64")),
        "durable Run contains refs only",
      );
    } finally {
      await host?.close();
      if (server)
        await new Promise<void>((done, fail) =>
          server.close((error) => (error ? fail(error) : done())),
        );
      await rm(root, { recursive: true, force: true });
    }
  },
);
