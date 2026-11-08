import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { OrchestrationHost } from "../src/dsh/host.ts";

test(
  "workspace instructions stay with the conversation's directory across forks and Flow runs",
  { timeout: 90_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "aura-workspace-instructions-"));
    let host: OrchestrationHost | undefined;
    let model: ServerType | undefined;
    t.after(async () => {
      try {
        await host?.close();
      } finally {
        if (model && "closeAllConnections" in model)
          model.closeAllConnections();
        if (model?.listening)
          await new Promise<void>((resolve) => model?.close(() => resolve()));
        await rm(root, { recursive: true, force: true, maxRetries: 3 });
      }
    });
    const other = join(root, "other");
    const flowRoot = join(root, "flow");
    const flowDirectory = join(flowRoot, "probe");
    await Promise.all([
      mkdir(other),
      mkdir(flowDirectory, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(root, "AGENTS.md"), "WORKSPACE_A_ONLY {{model}}\n"),
      writeFile(join(other, "AGENTS.md"), "WORKSPACE_B_ONLY\n"),
      writeFile(
        join(flowDirectory, "probe.flow.js"),
        `
import { defineFlow, z } from ${JSON.stringify(import.meta.resolve("@aura/orchestration/flow"))};
export default defineFlow({
  title: "Instruction isolation probe",
  input: z.object({}), output: z.string(),
  async run(ctx) {
    return ctx.sequence({ id: "main" }, async (flow) => {
      const agent = await flow.agent({
        id: "probe", label: "Probe", preset: "researcher-v1", prompt: "FLOW_PROBE",
      });
      return agent.output;
    });
  },
});
`,
      ),
    ]);

    // Synthetic OpenAI-compatible model. Keep only the actual model messages
    // so the assertions detect inherited instructions as well as new ones.
    const requests: string[] = [];
    const app = new Hono();
    app.post("/v1/chat/completions", async (context) => {
      const request = await context.req.json<{
        messages: unknown[];
        max_tokens?: number;
        max_completion_tokens?: number;
      }>();
      // Auxiliary title calls do not receive workspace instructions or history.
      if ((request.max_completion_tokens ?? request.max_tokens) !== 128)
        requests.push(JSON.stringify(request.messages));
      return streamSSE(context, async (output) => {
        await output.writeSSE({
          data: JSON.stringify({
            choices: [
              {
                index: 0,
                delta: { content: "fixture response" },
                finish_reason: null,
              },
            ],
          }),
        });
        await output.writeSSE({
          data: JSON.stringify({
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          }),
        });
        await output.writeSSE({ data: "[DONE]" });
      });
    });
    const port = await new Promise<number>((resolve, reject) => {
      model = serve(
        { fetch: app.fetch, hostname: "127.0.0.1", port: 0 },
        (address) => resolve(address.port),
      );
      model.once("error", reject);
    });
    const options = {
      root,
      flowRoot,
      dshHome: join(root, "dsh"),
      defaultWorkspace: join(root, "default"),
      tempDir: join(root, "scratch"),
      modelURL: `http://127.0.0.1:${port}/v1`,
    };
    let runtime = new OrchestrationHost(options);
    host = runtime;
    const workspaceA = await runtime.createProject(root);
    const workspaceB = await runtime.createProject(other);
    const send = (
      sessionId: string,
      projectId: string,
      prompt: string,
      source?: { branchFrom: string; branchAt: number } | { forkFrom: string },
    ) =>
      runtime.coding(
        {
          sessionId,
          projectId,
          prompt,
          mode: "demo",
          model: "deepseek-v4-flash",
          reasoningEffort: "off",
          ...source,
        },
        () => undefined,
        AbortSignal.timeout(20_000),
      );
    const lastRequest = () => requests.at(-1) ?? "";

    await send("instructions-a", workspaceA.id, "PROBE_A");
    assert.match(lastRequest(), /WORKSPACE_A_ONLY \{\{model\}\}/u);
    assert.doesNotMatch(lastRequest(), /WORKSPACE_B_ONLY/u);
    await send("instructions-b", workspaceB.id, "PROBE_B");
    assert.match(lastRequest(), /WORKSPACE_B_ONLY/u);
    assert.doesNotMatch(lastRequest(), /WORKSPACE_A_ONLY/u);

    const { sessionId: side } = await runtime.openCodingSide("instructions-a");
    await send(side, workspaceA.id, "PROBE_SIDE", {
      forkFrom: "instructions-a",
    });
    assert.match(lastRequest(), /WORKSPACE_A_ONLY/u);
    assert.doesNotMatch(lastRequest(), /WORKSPACE_B_ONLY/u);

    const { turns } = await runtime.codingHistory("instructions-a");
    const branchAt = turns[0]?.endSeq;
    assert.equal(typeof branchAt, "number");
    await send("instructions-branch", workspaceB.id, "PROBE_BRANCH", {
      branchFrom: "instructions-a",
      branchAt: branchAt!,
    });
    assert.match(lastRequest(), /PROBE_A/u);
    assert.match(lastRequest(), /WORKSPACE_B_ONLY/u);
    assert.doesNotMatch(lastRequest(), /WORKSPACE_A_ONLY/u);

    // The Flow's cwd equals workspace A, but its Agent has no conversation binding.
    const flow = await runtime.invokeFlow("probe", { input: {}, mode: "demo" });
    assert.match(lastRequest(), /FLOW_PROBE/u);
    assert.doesNotMatch(lastRequest(), /WORKSPACE_[AB]_ONLY/u);
    assert.equal(flow.status, "completed", flow.error);

    await unlink(join(other, "AGENTS.md"));
    await send("instructions-b", workspaceB.id, "PROBE_REMOVED");
    assert.doesNotMatch(lastRequest(), /WORKSPACE_[AB]_ONLY/u);

    await runtime.close();
    runtime = new OrchestrationHost(options);
    host = runtime;
    await writeFile(join(root, "AGENTS.md"), "WORKSPACE_A_UPDATED\n");
    await send("instructions-a", workspaceA.id, "PROBE_RESUME");
    assert.match(lastRequest(), /WORKSPACE_A_UPDATED/u);
    assert.doesNotMatch(lastRequest(), /WORKSPACE_[AB]_ONLY/u);
  },
);
