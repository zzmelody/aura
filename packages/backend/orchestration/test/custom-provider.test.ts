import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { CodexSubscriptionAuth, saveModelSettings } from "@aura/dsh-auth";
import type { FlowRun } from "@aura/protocol/types";
import { OrchestrationHost } from "../src/index.ts";

test(
  "real DSH dispatches configured gateways and preserves saved credentials across restart",
  { timeout: 150000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "aura-custom-wire-"));
    const flowRoot = join(root, "flows");
    const folder = join(flowRoot, "custom-check");
    await mkdir(folder, { recursive: true });
    await writeFile(
      join(folder, "custom-check.flow.js"),
      `import {defineFlow,z} from ${JSON.stringify(new URL("../src/flow-api.ts", import.meta.url).href)};
export default defineFlow({title:"Custom check",service:true,input:z.object({pause:z.boolean().optional()}),output:z.object({text:z.string()}),async run(ctx,input){return ctx.sequence({id:"main"},async scope=>{if(input.pause)await scope.checkpoint({id:"pause",prompt:"Wait",schema:z.boolean()});return {text:(await scope.agent({id:"call",label:"Call",preset:"researcher-v1",prompt:"Say READY only"})).output};});}});`,
    );
    const requests: Array<{
      model: string;
      authorization: string | undefined;
    }> = [];
    const app = new Hono();
    app.post("/v1/chat/completions", async (c) => {
      const body = (await c.req.json()) as { model: string };
      requests.push({
        model: body.model,
        authorization: c.req.header("authorization"),
      });
      return streamSSE(c, async (output) => {
        const common = {
          id: "fixture",
          model: body.model,
          created: 1,
          object: "chat.completion.chunk",
        };
        await output.writeSSE({
          data: JSON.stringify({
            ...common,
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "READY" },
                finish_reason: null,
              },
            ],
          }),
        });
        await output.writeSSE({
          data: JSON.stringify({
            ...common,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 1,
              total_tokens: 11,
            },
          }),
        });
        await output.writeSSE({ data: "[DONE]" });
      });
    });
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const baseURL = `http://127.0.0.1:${address.port}/v1`;
    const dshHome = join(root, ".aura", "dsh");
    const auth = await CodexSubscriptionAuth.create({
      credentialPath: join(dshHome, ".credentials.yaml"),
    });
    let host = new OrchestrationHost({
      root,
      dshHome,
      flowRoot,
      modelURL: baseURL,
    });
    t.after(async () => {
      await host.close();
      await auth.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    });
    await host.request("catalog"); // Configure after the DSH subprocess has already started.
    const custom = {
      name: "Fixture",
      api: "openai-completions",
      baseURL,
      images: true,
      contextWindow: 262144,
    };
    await saveModelSettings(root, auth.ctx.credentials, {
      mode: "custom",
      model: "model-one",
      reasoningEffort: "off",
      key: "fixture-first-key",
      custom,
    });
    const source = {
      requestId: randomUUID(),
      flowId: "custom-check",
      input: {},
      mode: "codex",
      useConfiguredModel: true,
      serviceOnly: true,
    };
    const first = await host.request<FlowRun>("start", source);
    assert.equal(first.mode, "custom");
    const complete = await host.request<FlowRun>("wait", { id: first.id });
    assert.equal(complete.status, "completed", complete.error);
    assert.deepEqual(requests, [
      { model: "model-one", authorization: "Bearer fixture-first-key" },
    ]);
    assert.ok(!JSON.stringify(complete).includes("fixture-first-key"));
    await saveModelSettings(root, auth.ctx.credentials, {
      mode: "custom",
      model: "model-two",
      reasoningEffort: "off",
      key: "fixture-second-key",
      custom,
    });
    assert.equal((await host.request<FlowRun>("start", source)).id, first.id);
    const second = await host.request<FlowRun>("start", {
      ...source,
      requestId: randomUUID(),
    });
    const result = await host.request<FlowRun>("wait", { id: second.id });
    assert.equal(result.status, "completed", result.error);
    assert.deepEqual(requests.at(-1), {
      model: "model-two",
      authorization: "Bearer fixture-second-key",
    });
    const waiting = await host.request<FlowRun>("start", {
      ...source,
      requestId: randomUUID(),
      input: { pause: true },
    });
    assert.equal(
      (await host.request<FlowRun>("wait", { id: waiting.id })).status,
      "waiting_input",
    );
    assert.equal(await host.request<boolean>("ai-services/busy", {}), true);
    await host.request("cancel", { id: waiting.id, requestId: randomUUID() });
    assert.equal(await host.request<boolean>("ai-services/busy", {}), false);
    await host.close();
    host = new OrchestrationHost({
      root,
      dshHome,
      flowRoot,
      modelURL: baseURL,
    });
    const restored = await host.request<FlowRun>("start", {
      ...source,
      requestId: randomUUID(),
    });
    assert.equal(
      (await host.request<FlowRun>("wait", { id: restored.id })).status,
      "completed",
    );
    assert.deepEqual(requests.at(-1), {
      model: "model-two",
      authorization: "Bearer fixture-second-key",
    });
  },
);
