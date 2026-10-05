import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { z } from "zod";
import type { FlowRun } from "@aura/protocol/types";
import type { LoadedFlow } from "../src/registry.ts";
import type { EngineOptions, Table } from "../src/types.ts";
import { FlowEngine } from "../src/engine.ts";
import { runSchema } from "../src/schema.ts";

const hash = (value: string) => value.repeat(64).slice(0, 64);

function table(): Table<FlowRun> {
  const rows = new Map<string, FlowRun>();
  let chain: Promise<unknown> = Promise.resolve();
  return {
    get: (id) => rows.get(id),
    entries: () => rows.entries(),
    put: async (id, value) => {
      rows.set(id, structuredClone(runSchema.parse(value)) as FlowRun);
    },
    update: (id, change) => {
      const task = chain.then(() => {
        const value = runSchema.parse(change(rows.get(id)!)) as FlowRun;
        rows.set(id, value);
        return value;
      });
      chain = task.catch(() => undefined);
      return task;
    },
  };
}

function loaded(
  id: string,
  run: LoadedFlow["run"],
  options: Partial<LoadedFlow> = {},
): LoadedFlow {
  return {
    id,
    title: id,
    description: "",
    service: false,
    sourceHash: hash(id),
    inputSchema: z.object({ value: z.number() }),
    outputSchema: z.object({ value: z.number() }),
    concurrency: 2,
    agentTimeoutMs: 1000,
    capabilities: [],
    run,
    ...options,
  };
}

async function setup(
  flows: LoadedFlow[],
  records = table(),
  sessions: Partial<EngineOptions["sessions"]> = {},
  resolveAgentDefaults?: EngineOptions["resolveAgentDefaults"],
) {
  const registry = new Map(flows.map((flow) => [flow.id, flow]));
  const engine = new FlowEngine({
    resolveAgentDefaults,
    domain: { table: () => records },
    registry: {
      get: (id) => {
        const flow = registry.get(id);
        if (!flow) throw new Error(`missing ${id}`);
        return flow;
      },
      catalog: () => [],
    },
    refreshFlows: async () => {},
    presets: async () => [
      { id: "test", name: "test", description: "", unavailable: false },
    ],
    sessions: {
      execute: async () => "unused",
      history: async (step) => ({
        sessionId: step.sessionId,
        preset: step.preset,
        hasMore: false,
        entries: [],
      }),
      ...sessions,
    },
  });
  await engine.initialize();
  return { engine, records, registry };
}

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function request(flowId = "parent", value = 2) {
  return {
    requestId: randomUUID(),
    flowId,
    input: { value },
    mode: "demo" as const,
  };
}

test("configured creator admission and nested Flows keep the original provider after settings change", async () => {
  let selected = { provider: "aura-custom-" + "a".repeat(32), model: "model-one", reasoningEffort: "off", timeoutMs: 1000 };
  const first = { ...selected };
  const child = loaded("child", (ctx, input) => ctx.sequence({ id: "main" }, async scope => {
    await scope.agent({ id: "call", label: "Call", preset: "test", prompt: "child" }); return input;
  }));
  const parent = loaded("parent", (ctx, input) => ctx.sequence({ id: "main" }, async scope => {
    await scope.memo({ id: "switch", schema: z.boolean(), compute: () => { selected = { ...selected, provider: "aura-custom-" + "b".repeat(32), model: "model-two" }; return true; } });
    return (await scope.flow({ id: "child", flow: "child", input })).output;
  }), { service: true });
  const calls: unknown[] = [];
  const { engine } = await setup([parent, child], undefined, { execute: async step => { calls.push(step.config); return "ready"; } }, async () => selected);
  try {
    const source = { ...request(), mode: "codex", serviceOnly: true, useConfiguredModel: true };
    const started = await engine.start(source);
    assert.equal((await engine.wait(started.id)).status, "completed");
    assert.equal(started.mode, "custom");
    assert.deepEqual(calls, [first]);
    assert.equal((await engine.start(source)).id, started.id);
    const next = await engine.start({ ...source, requestId: randomUUID() });
    assert.equal(next.agentDefaults?.model, "model-two");
    await assert.rejects(engine.start({ ...source, requestId: randomUUID(), serviceOnly: false }), /受控服务/);
  } finally { await engine.close(); }
});

test("service-only starts require an explicitly published Flow", async () => {
  const internal = loaded("internal", async (_ctx, input) => input);
  const service = loaded("service", async (_ctx, input) => input, {
    service: true,
  });
  const { engine } = await setup([internal, service]);
  try {
    await assert.rejects(
      engine.start({ ...request("internal"), serviceOnly: true }),
      /未发布为 HTTP 服务/,
    );
    const started = await engine.start({
      ...request("service"),
      serviceOnly: true,
    });
    assert.equal((await engine.wait(started.id)).status, "completed");
  } finally {
    await engine.close();
  }
});

test("a child Flow is pinned, persisted and executed inline without becoming top-level history", async () => {
  const child = loaded("child", (ctx, input) =>
    ctx.sequence({ id: "child" }, async (flow) => ({
      value: await flow.memo({
        id: "double",
        schema: z.number(),
        compute: () => (input as { value: number }).value * 2,
      }),
    })),
  );
  const parent = loaded("parent", (ctx, input) =>
    ctx.sequence({ id: "main" }, async (flow) => {
      const result = await flow.flow({
        id: "nested",
        label: "Nested child",
        flow: "child",
        input,
      });
      return result.output;
    }),
  );
  const { engine } = await setup([parent, child]);
  try {
    const started = await engine.start(request());
    const result = await engine.wait(started.id);
    assert.equal(result.status, "completed", result.error);
    assert.deepEqual(result.output, { value: 4 });
    const step = result.steps[0];
    assert.equal(step?.kind, "flow");
    if (step?.kind !== "flow") return;
    assert.equal(step.sourceHash, child.sourceHash);
    assert.ok(step.childRunId);
    const childRun = engine.get(step.childRunId!);
    assert.deepEqual(childRun.parent, {
      runId: result.id,
      stepKey: "main/nested",
    });
    assert.deepEqual(childRun.ancestry, ["parent"]);
    assert.deepEqual(
      engine.list().map((run) => run.id),
      [result.id],
    );
  } finally {
    await engine.close();
  }
});

test("checkpoint state propagates through a child Run and resumes the original child", async () => {
  const child = loaded("child", (ctx, input) =>
    ctx.sequence({ id: "child" }, async (flow) => {
      const approved = await flow.checkpoint({
        id: "approval",
        prompt: "Continue?",
        schema: z.boolean(),
      });
      return { value: approved ? (input as { value: number }).value : 0 };
    }),
  );
  const parent = loaded("parent", (ctx, input) =>
    ctx.sequence(
      { id: "main" },
      async (flow) =>
        (await flow.flow({ id: "nested", flow: "child", input })).output,
    ),
  );
  const first = await setup([parent, child]);
  let engine = first.engine;
  try {
    const started = await engine.start(request());
    const waiting = await engine.wait(started.id);
    assert.equal(waiting.status, "waiting_input", waiting.error);
    const step = waiting.steps[0];
    assert.equal(step?.kind, "flow");
    if (step?.kind !== "flow") return;
    const childId = step.childRunId!;
    assert.equal(engine.get(childId).status, "waiting_input");
    await assert.rejects(
      engine.command(
        started.id,
        "answer",
        { requestId: randomUUID(), output: true },
        "main/nested",
      ),
      /childRunId/,
    );
    await engine.close();
    engine = (await setup([parent, child], first.records)).engine;
    await engine.command(
      childId,
      "answer",
      { requestId: randomUUID(), output: true },
      "child/approval",
    );
    const completed = await engine.wait(started.id);
    assert.equal(completed.status, "completed");
    assert.deepEqual(completed.output, { value: 2 });
    assert.equal(completed.steps[0]?.kind, "flow");
    assert.equal(
      completed.steps[0]?.kind === "flow"
        ? completed.steps[0].childRunId
        : undefined,
      childId,
    );
  } finally {
    await engine.close();
  }
});

test("nested calls reject cycles and plugin boundary crossings without capability", async () => {
  const self = loaded("self", (ctx, input) =>
    ctx.sequence(
      { id: "main" },
      async (flow) =>
        (await flow.flow({ id: "again", flow: "self", input })).output,
    ),
  );
  const plugin = { id: "plugin.one", name: "One", version: "1.0.0" };
  const other = { id: "plugin.two", name: "Two", version: "1.0.0" };
  const target = loaded("plugin.two/child", async (_ctx, input) => input, {
    plugin: other,
  });
  const caller = loaded(
    "plugin.one/parent",
    (ctx, input) =>
      ctx.sequence(
        { id: "main" },
        async (flow) =>
          (await flow.flow({ id: "nested", flow: "plugin.two/child", input }))
            .output,
      ),
    { plugin },
  );
  const { engine, registry } = await setup([self, caller, target]);
  try {
    const cycle = await engine.start(request("self"));
    assert.equal((await engine.wait(cycle.id)).status, "failed");
    assert.match(engine.get(cycle.id).error!, /循环调用/);
    const denied = await engine.start(request("plugin.one/parent"));
    assert.equal((await engine.wait(denied.id)).status, "failed");
    assert.match(engine.get(denied.id).error!, /aura\.flow\.invoke/);
    assert.equal(
      [...engine.runs.entries()].filter(([, run]) => Boolean(run.parent))
        .length,
      0,
    );
    registry.set(caller.id, {
      ...caller,
      sourceHash: hash("allowed"),
      capabilities: ["aura.flow.invoke"],
    });
    const allowed = await engine.start(request("plugin.one/parent", 3));
    assert.equal((await engine.wait(allowed.id)).status, "completed");
    assert.deepEqual(engine.get(allowed.id).output, { value: 3 });
  } finally {
    await engine.close();
  }
});

test("nested children bypass the top-level scheduler slots", async () => {
  const child = loaded("child", async (_ctx, input) => input);
  const parent = loaded("parent", (ctx, input) =>
    ctx.sequence(
      { id: "main" },
      async (flow) =>
        (await flow.flow({ id: "nested", flow: "child", input })).output,
    ),
  );
  const { engine } = await setup([parent, child]);
  try {
    const [first, second] = await Promise.all([
      engine.start(request("parent", 1)),
      engine.start(request("parent", 2)),
    ]);
    const completed = await Promise.all([
      engine.wait(first.id),
      engine.wait(second.id),
    ]);
    assert.ok(
      completed.every((run) => run.status === "completed"),
      completed.map((run) => run.error).join("\n"),
    );
    assert.deepEqual(
      completed.map((run) => run.output),
      [{ value: 1 }, { value: 2 }],
    );
  } finally {
    await engine.close();
  }
});

test("cancelling a parent aborts its active child Run", async () => {
  const child = loaded("child", (ctx, input) =>
    ctx.sequence({ id: "child" }, async (flow) => {
      await flow.agent({
        id: "work",
        label: "Work",
        preset: "test",
        prompt: "wait",
      });
      return input as { value: number };
    }),
  );
  const parent = loaded("parent", (ctx, input) =>
    ctx.sequence(
      { id: "main" },
      async (flow) =>
        (await flow.flow({ id: "nested", flow: "child", input })).output,
    ),
  );
  const records = table();
  const { engine } = await setup([parent, child], records, {
    execute: (step) =>
      new Promise<string>((_resolve, reject) => {
        step.signal.addEventListener(
          "abort",
          () => reject(step.signal.reason),
          {
            once: true,
          },
        );
      }),
  });
  try {
    const started = await engine.start(request());
    await until(() =>
      [...records.entries()].some(
        ([, run]) =>
          Boolean(run.parent) &&
          run.steps.some((step) => step.status === "running"),
      ),
    );
    await engine.cancel(started.id);
    const parentRun = engine.get(started.id);
    const flowStep = parentRun.steps[0];
    assert.equal(parentRun.status, "cancelled");
    assert.equal(flowStep?.kind, "flow");
    if (flowStep?.kind !== "flow") return;
    assert.equal(engine.get(flowStep.childRunId!).status, "cancelled");
  } finally {
    await engine.close();
  }
});
