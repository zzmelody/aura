import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { FlowCatalog, FlowHistory, FlowRun } from "@aura/protocol/types";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { flowDemoReply } from "../src/demo.ts";
import { OrchestrationHost } from "../src/index.ts";

interface ModelRequest {
  messages: Array<{ role: string; content: unknown }>;
}

const nodeMajor = Number(process.versions.node.split(".")[0]);
const entrySource = (apiUrl: string) => `
import { defineFlow, z } from ${JSON.stringify(apiUrl)};
import { version } from "./helper.js";

const prompt = (task, nodeId, inputs = []) =>
  "AURA_FLOW_INPUT_V1\\n" + JSON.stringify({ task: task + ":" + version, nodeId, inputs });

export default defineFlow({
  title: "HMR integration " + version,
  description: "DSH integration fixture",
  input: z.object({ task: z.string().min(1) }),
  output: z.object({ report: z.string() }),
  concurrency: 2,
  agentTimeoutMs: 30000,
  async run(ctx, input) {
    return ctx.sequence({ id: "main" }, async (flow) => {
    const { research, review } = await flow.parallel({ id: "analysis", branches: {
      research: (branch) => branch.agent({ id: "research", label: "Research", preset: "researcher-v1", prompt: prompt(input.task, "research"), retry: { maxAttempts: 2, initialDelayMs: 0 } }),
      review: (branch) => branch.agent({ id: "review", label: "Review", preset: "reviewer-v1", prompt: prompt(input.task, "review"), retry: { maxAttempts: 2, initialDelayMs: 0 } }),
    }});
    const coordinator = await flow.agent({
      id: "coordinator",
      label: "Coordinator",
      preset: "coordinator-v1",
      retry: { maxAttempts: 2, initialDelayMs: 0 },
      prompt: prompt(input.task, "coordinator", [research, review].map((item) => ({
        nodeId: item.stepId,
        sessionId: item.sessionId,
        output: item.output,
      }))),
    });
    return { report: coordinator.output };
    });
  },
});
`;

async function waitForCatalog(
  host: OrchestrationHost,
  predicate: (flow: FlowCatalog["flows"][number]) => boolean,
) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const catalog = await host.request<FlowCatalog>("catalog");
    const flow = catalog.flows.find(({ id }) => id === "hmr-check");
    if (flow && predicate(flow)) return flow;
    await delay(150);
  }
  throw new Error("Flow catalog did not reach the expected HMR state");
}

test(
  "real DSH discovers code Flows, keeps separate sessions and hot reloads helpers",
  {
    timeout: 120_000,
    skip:
      nodeMajor < 24
        ? "DSH and native TypeScript loading require the repository Node >=24 baseline"
        : false,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "aura-code-flow-test-"));
    const flowRoot = join(root, "flow");
    const flowDirectory = join(flowRoot, "hmr-check");
    await mkdir(flowDirectory, { recursive: true });
    const apiUrl = new URL("../src/flow-api.ts", import.meta.url).href;
    await writeFile(
      join(flowDirectory, "helper.js"),
      'export const version = "v1";\n',
    );
    await writeFile(
      join(flowDirectory, "hmr-check.flow.js"),
      entrySource(apiUrl),
    );

    const calls: ModelRequest[] = [];
    let holdCoordinator = false;
    let releaseCoordinator: (() => void) | undefined;
    const modelApp = new Hono();
    modelApp.post("/v1/chat/completions", async (context) => {
      const request = (await context.req.json()) as ModelRequest;
      calls.push(request);
      if (
        holdCoordinator &&
        request.messages.some(
          (message) =>
            typeof message.content === "string" &&
            message.content.includes('"nodeId":"coordinator"'),
        )
      )
        await new Promise<void>((resolve) => {
          releaseCoordinator = resolve;
        });
      return streamSSE(context, async (output) => {
        await output.writeSSE({
          data: JSON.stringify({
            choices: [
              {
                index: 0,
                delta: { content: flowDemoReply(request.messages) },
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

    let model!: ServerType;
    const modelPort = await new Promise<number>((resolvePort, reject) => {
      const server = serve(
        { fetch: modelApp.fetch, hostname: "127.0.0.1", port: 0 },
        ({ port }) => resolvePort(port),
      );
      server.once("error", reject);
      model = server;
    });
    const options = {
      root,
      flowRoot,
      dshHome: join(root, "dsh"),
      modelURL: `http://127.0.0.1:${modelPort}/v1`,
    };
    let host = new OrchestrationHost(options);

    try {
      const initial = await waitForCatalog(host, (flow) => flow.available);
      assert.equal(initial.title, "HMR integration v1");
      const firstHash = initial.sourceHash;

      const run = await host.invokeFlow("hmr-check", {
        input: { task: "integration" },
        mode: "demo",
        requestId: randomUUID(),
      });
      assert.equal(run.status, "completed", JSON.stringify(run));
      assert.match((run.output as { report: string }).report, /integration:v1/);
      assert.equal(
        new Set(run.steps.map(({ sessionId }) => sessionId)).size,
        3,
      );
      assert.equal(calls.length, 3);

      const history = await host.request<FlowHistory>("history", {
        id: run.id,
        stepId: "main/coordinator",
      });
      assert.ok(history.entries.some(({ kind }) => kind === "assistant"));

      await writeFile(
        join(flowDirectory, "helper.js"),
        'export const version = "v2";\n',
      );
      const updated = await waitForCatalog(
        host,
        (flow) => flow.sourceHash !== firstHash && flow.title.endsWith("v2"),
      );
      assert.notEqual(updated.sourceHash, firstHash);
      const second = await host.invokeFlow("hmr-check", {
        input: { task: "integration" },
        mode: "demo",
      });
      assert.match(
        (second.output as { report: string }).report,
        /integration:v2/,
      );

      await writeFile(
        join(flowDirectory, "helper.js"),
        "export const version = ;\n",
      );
      const rolledBack = await waitForCatalog(
        host,
        (flow) => flow.sourceHash === updated.sourceHash && Boolean(flow.error),
      );
      assert.equal(rolledBack.available, true);
      const lastKnownGood = await host.invokeFlow("hmr-check", {
        input: { task: "integration" },
        mode: "demo",
      });
      assert.match(
        (lastKnownGood.output as { report: string }).report,
        /integration:v2/,
      );

      await writeFile(
        join(flowDirectory, "helper.js"),
        'export const version = "v3";\n',
      );
      const repaired = await waitForCatalog(
        host,
        (flow) =>
          flow.sourceHash !== updated.sourceHash &&
          flow.title.endsWith("v3") &&
          !flow.error,
      );
      assert.equal(repaired.available, true);
      const third = await host.invokeFlow("hmr-check", {
        input: { task: "integration" },
        mode: "demo",
      });
      assert.match(
        (third.output as { report: string }).report,
        /integration:v3/,
      );

      await host.close();
      host = new OrchestrationHost(options);
      const restored = await host.request<FlowRun>("get", { id: run.id });
      assert.deepEqual(restored.output, run.output);
      const coldHistory = await host.request<FlowHistory>("history", {
        id: run.id,
        stepId: "main/analysis/research/research",
      });
      assert.equal(coldHistory.preset, "researcher-v1");
      assert.ok(coldHistory.entries.some(({ kind }) => kind === "assistant"));

      // Kill the actual DSH host after earlier steps commit and the final model call starts.
      holdCoordinator = true;
      const crashing = await host.request<FlowRun>("start", {
        requestId: randomUUID(),
        flowId: "hmr-check",
        input: { task: "crash-recovery" },
        mode: "demo",
      });
      const deadline = Date.now() + 15_000;
      while (!releaseCoordinator && Date.now() < deadline) await delay(20);
      assert.ok(
        releaseCoordinator,
        "coordinator model call should be in flight",
      );
      const beforeCrash = await host.request<FlowRun>("get", {
        id: crashing.id,
      });
      assert.equal(
        beforeCrash.steps.filter((step) => step.status === "completed").length,
        2,
      );
      const childHost = await host.open();
      childHost.child.kill("SIGKILL");
      await childHost.exited;
      holdCoordinator = false;
      releaseCoordinator();
      host = new OrchestrationHost(options);
      const resumed = await host.request<FlowRun>("wait", { id: crashing.id });
      assert.equal(resumed.status, "completed", JSON.stringify(resumed));
      assert.deepEqual(
        resumed.steps.map((step) => step.attempts?.length),
        [1, 1, 2],
      );
      assert.deepEqual(
        resumed.steps.slice(0, 2).map((step) => step.output),
        beforeCrash.steps.slice(0, 2).map((step) => step.output),
      );
      assert.match(JSON.stringify(resumed.recoveryEvents), /重新启动/);
    } finally {
      releaseCoordinator?.();
      await host.close();
      await new Promise<void>((resolveClose, reject) => {
        model.close((error) => (error ? reject(error) : resolveClose()));
        model.closeAllConnections?.();
      });
      assert.equal(dirname(resolve(root)), resolve(tmpdir()));
      assert.ok(basename(root).startsWith("aura-code-flow-test-"));
      await rm(root, { recursive: true, force: true });
    }
  },
);
