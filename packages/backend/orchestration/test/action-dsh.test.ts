import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type {
  ActionRun,
  FlowCatalog,
  FlowHistory,
  FlowRun,
} from "@aura/protocol/types";
import { OrchestrationHost } from "../src/index.ts";

async function eventually<T>(
  read: () => Promise<T>,
  matches: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + 15_000;
  let last: T | undefined;
  while (Date.now() < deadline) {
    const value = await read();
    last = value;
    if (matches(value)) return value;
    await delay(100);
  }
  throw new Error(`Action state did not settle: ${JSON.stringify(last)}`);
}

const actionSource = `
import { defineAction } from ${JSON.stringify(new URL("../src/action-api.ts", import.meta.url).href)};
import { setTimeout as delay } from "node:timers/promises";
import { version } from "./lib/version.js";
export default defineAction({
  title: "Probe " + version, description: "Integration probe",
  parameters: { value: { type: "string", required: true }, delayMs: { type: "integer" } },
  output: { schema: { type: "string" }, render: (_, value) => [{ type: "text", text: value }] },
  timeoutMs: 3000, isConcurrencySafe: () => true,
  async execute(ctx, input) {
    if ("flow" in ctx || "agent" in ctx) throw new Error("Unexpected orchestration capability");
    await delay(input.delayMs ?? 1, undefined, { signal: ctx.signal });
    if (input.value === "bad-schema") return 42;
    if (input.value === "oversize") return "x".repeat(300000);
    if (input.value === "cycle") { const cyclic = {}; cyclic.self = cyclic; return cyclic; }
    return version + ":" + input.value;
  },
});
`;

const flowSource = `
import { defineFlow, z } from ${JSON.stringify(new URL("../src/flow-api.ts", import.meta.url).href)};
export default defineFlow({
  title: "Actions integration", input: z.object({}), output: z.object({ direct: z.json(), report: z.string() }),
  concurrency: 3,
  async run(ctx) {
    const [direct, agent] = await Promise.all([
      ctx.action({ id: "direct", action: "probe-action", input: { value: "direct", delayMs: 2000 } }),
      ctx.agent({ id: "allowed", label: "Allowed", preset: "researcher-v1", actions: ["probe-action"], prompt: "USE_ACTION" }),
      ctx.agent({ id: "default", label: "Default", preset: "reviewer-v1", prompt: "NO_ACTION" }),
    ]);
    return { direct: direct.output, report: agent.output };
  },
});
`;

test(
  "real DSH Actions: scoped tools, direct persistence, HMR, validation and cancellation",
  {
    timeout: 120_000,
    skip:
      Number(process.versions.node.split(".")[0]) < 24
        ? "Requires Node 24"
        : false,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "aura-action-test-"));
    const actionRoot = join(root, "action");
    const flowRoot = join(root, "flow");
    await mkdir(actionRoot);
    await mkdir(join(flowRoot, "action-check"), { recursive: true });
    await writeFile(
      join(flowRoot, "action-check", "action-check.flow.js"),
      flowSource,
    );
    const requests: Array<{ user: string; tools: string[] }> = [];
    const app = new Hono();
    app.post("/v1/chat/completions", async (c) => {
      const input = (await c.req.json()) as {
        messages: Array<{ role: string; content: unknown }>;
        tools?: Array<{ function: { name: string } }>;
      };
      const user = JSON.stringify(
        input.messages.filter((m) => m.role === "user"),
      );
      const names = input.tools?.map((t) => t.function.name) ?? [];
      requests.push({ user, tools: names });
      const result = input.messages.findLast((m) => m.role === "tool");
      const call = user.includes("USE_ACTION") && !result;
      return streamSSE(c, async (s) => {
        await s.writeSSE({
          data: JSON.stringify({
            choices: [
              {
                index: 0,
                delta: call
                  ? {
                      tool_calls: [
                        {
                          index: 0,
                          id: "probe_call",
                          type: "function",
                          function: {
                            name: "probe-action",
                            arguments: '{"value":"agent"}',
                          },
                        },
                      ],
                    }
                  : { content: result ? String(result.content) : "no-action" },
                finish_reason: null,
              },
            ],
          }),
        });
        await s.writeSSE({
          data: JSON.stringify({
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: call ? "tool_calls" : "stop",
              },
            ],
          }),
        });
        await s.writeSSE({ data: "[DONE]" });
      });
    });
    let model!: ServerType;
    const port = await new Promise<number>((done, fail) => {
      model = serve(
        { fetch: app.fetch, hostname: "127.0.0.1", port: 0 },
        ({ port }) => done(port),
      );
      model.once("error", fail);
    });
    const options = {
      root,
      actionRoot,
      flowRoot,
      dshHome: join(root, "dsh"),
      modelURL: `http://127.0.0.1:${port}/v1`,
    };
    let host = new OrchestrationHost(options);
    const catalog = () => host.request<FlowCatalog>("catalog");
    const probe = (c: FlowCatalog) =>
      c.actions?.find((a) => a.id === "probe-action");
    const directory = join(actionRoot, "probe-action");
    const entry = join(directory, "probe-action.action.js");
    const helper = join(directory, "lib", "version.js");
    try {
      assert.equal((await catalog()).actions?.length, 0);
      await mkdir(join(directory, "lib"), { recursive: true });
      await writeFile(helper, 'export const version = "v1";');
      await writeFile(entry, actionSource);
      const first = await eventually(catalog, (c) =>
        Boolean(probe(c)?.available),
      );
      const firstHash = probe(first)!.sourceHash;
      const run = await host.invokeFlow("action-check", {
        input: {},
        mode: "demo",
      });
      assert.equal(run.status, "completed", JSON.stringify(run));
      assert.deepEqual(run.output, { direct: "v1:direct", report: "v1:agent" });
      assert.equal(run.steps[0]?.kind, "action");
      assert.equal(run.steps[0]?.output, "v1:direct");
      assert.equal(
        requests.filter((r) => r.user.includes("NO_ACTION")).length,
        1,
      );
      for (const request of requests) {
        assert.equal(
          request.tools.some((name) => name.startsWith("aura_direct_")),
          false,
        );
        assert.equal(
          request.tools.includes("probe-action"),
          request.user.includes("USE_ACTION"),
        );
      }
      const allowed = run.steps.find((s) => s.id === "allowed");
      assert.ok(allowed && allowed.kind !== "action");
      assert.deepEqual(allowed.actions, [
        { id: "probe-action", sourceHash: firstHash },
      ]);
      const history = await host.request<FlowHistory>("history", {
        id: run.id,
        stepId: "allowed",
      });
      assert.ok(
        history.entries.some(
          (e) => e.kind === "tool" && e.text.includes("probe-action"),
        ),
      );
      await assert.rejects(
        host.request("history", { id: run.id, stepId: "direct" }),
        /没有 DSH session/,
      );

      const local = await host.invokeAction("probe-action", {
        input: { value: "local" },
        mode: "demo",
      });
      assert.equal(local.output, "v1:local");
      assert.equal(local.sourceHash, firstHash);
      assert.equal(
        (await host.request<ActionRun>("action/get", { id: local.id })).status,
        "completed",
      );
      for (const input of [
        { value: 7 },
        { value: "bad-schema" },
        { value: "oversize" },
        { value: "cycle" },
      ]) {
        const failed = await host.invokeAction("probe-action", {
          input,
          mode: "demo",
        });
        assert.equal(failed.status, "failed", JSON.stringify(failed));
        assert.equal(failed.output, undefined);
      }
      await assert.rejects(
        host.invokeAction("probe-action", {
          input: { value: BigInt(1) },
          mode: "demo",
        }),
        /可序列化/,
      );

      const old = await host.request<ActionRun>("action/start", {
        requestId: randomUUID(),
        actionId: "probe-action",
        input: { value: "pinned", delayMs: 2000 },
        mode: "demo",
      });
      await eventually(
        () => host.request<ActionRun>("action/get", { id: old.id }),
        (r) => r.status === "running",
      );
      await writeFile(helper, 'export const version = "v2";');
      const updated = await eventually(
        catalog,
        (c) => probe(c)?.title === "Probe v2",
      );
      assert.notEqual(probe(updated)?.sourceHash, firstHash);
      const oldResult = await host.request<ActionRun>("action/wait", {
        id: old.id,
      });
      assert.equal(oldResult.output, "v1:pinned");
      assert.equal(oldResult.sourceHash, firstHash);
      assert.equal(
        (
          await host.invokeAction("probe-action", {
            input: { value: "new" },
            mode: "demo",
          })
        ).output,
        "v2:new",
      );

      await writeFile(helper, "export const version = ;");
      await eventually(catalog, (c) => Boolean(probe(c)?.error));
      assert.equal(
        (
          await host.invokeAction("probe-action", {
            input: { value: "rollback" },
            mode: "demo",
          })
        ).output,
        "v2:rollback",
      );
      await writeFile(helper, 'export const version = "v3";');
      await eventually(
        catalog,
        (c) => probe(c)?.title === "Probe v3" && !probe(c)?.error,
      );

      const timeout = await host.invokeAction("probe-action", {
        input: { value: "slow", delayMs: 6000 },
        mode: "demo",
      });
      assert.equal(timeout.status, "failed");
      assert.match(timeout.error ?? "", /TOOL_TIMEOUT/);
      const cancelId = randomUUID();
      const abort = new AbortController();
      const cancelled = host.invokeAction("probe-action", {
        input: { value: "cancel", delayMs: 6000 },
        mode: "demo",
        requestId: cancelId,
        signal: abort.signal,
      });
      const cancelRun = await host.request<ActionRun>("action/start", {
        actionId: "probe-action",
        input: { value: "cancel", delayMs: 6000 },
        mode: "demo",
        requestId: cancelId,
      });
      abort.abort(new Error("caller cancelled"));
      await assert.rejects(cancelled, /caller cancelled/);
      assert.equal(
        (await host.request<ActionRun>("action/get", { id: cancelRun.id }))
          .status,
        "cancelled",
      );

      // Cold DSH history and standalone Action records survive host recycling.
      await host.close();
      host = new OrchestrationHost(options);
      assert.equal(
        (await host.request<ActionRun>("action/get", { id: local.id })).output,
        "v1:local",
      );
      assert.equal(
        (await host.request<FlowRun>("get", { id: run.id })).steps[0]?.output,
        "v1:direct",
      );
      const cold = await host.request<FlowHistory>("history", {
        id: run.id,
        stepId: "allowed",
      });
      assert.ok(cold.entries.some((e) => e.kind === "tool"));
      assert.equal(dirname(resolve(entry)), resolve(directory));
      await rm(entry);
      await eventually(catalog, (c) => !probe(c)?.available);
      await assert.rejects(
        host.invokeAction("probe-action", {
          input: { value: "missing" },
          mode: "demo",
        }),
        /入口|不存在/,
      );
    } finally {
      await host.close();
      await new Promise<void>((done) => model.close(() => done()));
      assert.equal(dirname(resolve(root)), resolve(tmpdir()));
      assert.ok(basename(root).startsWith("aura-action-test-"));
      await rm(root, { recursive: true, force: true });
    }
  },
);
