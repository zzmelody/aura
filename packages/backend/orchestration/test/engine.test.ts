import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { FlowRun } from "@aura/protocol/types";
import { z } from "zod";
import { FlowEngine } from "../src/engine.ts";
import type { LoadedFlow } from "../src/registry.ts";
import type { FlowDomain, SessionPort, Table } from "../src/types.ts";

function table<T>(): Table<T> {
  const records = new Map<string, T>();
  let chain: Promise<unknown> = Promise.resolve();
  return {
    get: (id) => records.get(id),
    entries: () => records.entries(),
    put: async (id, value) => {
      records.set(id, structuredClone(value));
    },
    update(id, change) {
      const work = chain.then(() => {
        const current = records.get(id);
        assert.ok(current, `missing record ${id}`);
        const next = change(current);
        records.set(id, structuredClone(next));
        return next;
      });
      chain = work.catch(() => undefined);
      return work;
    },
  };
}

const hash = (character = "a") => character.repeat(64);

function flow(
  run: LoadedFlow["run"],
  options: Partial<LoadedFlow> = {},
): LoadedFlow {
  return {
    id: "test-flow",
    title: "测试 Flow",
    description: "",
    sourceHash: hash(),
    inputSchema: z.object({ task: z.string().min(1) }),
    outputSchema: z.object({ report: z.string() }),
    concurrency: 2,
    agentTimeoutMs: 1_000,
    run,
    ...options,
  };
}

function standardFlow(): LoadedFlow {
  return flow(async (ctx, input) => {
    const task = (input as { task: string }).task;
    const [research, review] = await Promise.all([
      ctx.agent({
        id: "research",
        label: "研究",
        preset: "researcher-v1",
        prompt: `research:${task}`,
      }),
      ctx.agent({
        id: "review",
        label: "审阅",
        preset: "reviewer-v1",
        prompt: `review:${task}`,
      }),
    ]);
    const coordinator = await ctx.agent({
      id: "coordinator",
      label: "汇总",
      preset: "coordinator-v1",
      prompt: `${research.output}|${review.output}`,
    });
    return { report: coordinator.output };
  });
}

async function fixture(
  options: {
    loaded?: LoadedFlow;
    execute?: SessionPort["execute"];
    runs?: Table<FlowRun>;
  } = {},
) {
  let loaded = options.loaded ?? standardFlow();
  const runs = options.runs ?? table<FlowRun>();
  const domain: FlowDomain = { table: () => runs };
  const engine = new FlowEngine({
    domain,
    sessions: {
      execute: options.execute ?? (async (step) => `${step.id} output`),
      history: async (step, beforeSeq) => ({
        sessionId: step.sessionId,
        preset: step.preset,
        entries: [],
        beforeSeq,
      }),
    },
    registry: {
      get(id) {
        if (id !== loaded.id) throw new Error("missing flow");
        return loaded;
      },
      catalog: () => [],
    },
    refreshFlows: async () => undefined,
    presets: async () =>
      ["researcher-v1", "reviewer-v1", "coordinator-v1"].map((id) => ({
        id,
        name: id,
        description: "",
        unavailable: false,
      })),
  });
  await engine.initialize();
  return { engine, runs, replaceFlow: (next: LoadedFlow) => (loaded = next) };
}

const request = (input: unknown = { task: "测试任务" }) => ({
  requestId: randomUUID(),
  flowId: "test-flow",
  input,
  mode: "demo" as const,
});

test("code Flow creates dynamic independent DSH sessions and aggregates output", async () => {
  const calls: Array<{ id: string; input: string }> = [];
  const { engine } = await fixture({
    execute: async (step) => {
      calls.push({ id: step.id, input: step.input });
      return `${step.id} output`;
    },
  });
  const started = await engine.start(request());
  const run = await engine.wait(started.id);

  assert.equal(run.status, "completed");
  assert.deepEqual(run.output, { report: "coordinator output" });
  assert.deepEqual(
    calls.map(({ id }) => id),
    ["research", "review", "coordinator"],
  );
  assert.equal(calls[2]?.input, "research output|review output");
  assert.equal(new Set(run.steps.map(({ sessionId }) => sessionId)).size, 3);
  assert.equal(
    (await engine.history(run.id, "research")).preset,
    "researcher-v1",
  );
});

test("native Promise.all is bounded by the Flow concurrency setting", async () => {
  let active = 0;
  let maximum = 0;
  const loaded = flow(
    async (ctx) => {
      const outputs = await Promise.all(
        ["one", "two", "three"].map((id) =>
          ctx.agent({ id, label: id, preset: "researcher-v1", prompt: id }),
        ),
      );
      return { report: outputs.map(({ output }) => output).join(",") };
    },
    { concurrency: 2 },
  );
  const { engine } = await fixture({
    loaded,
    execute: async (step) => {
      active++;
      maximum = Math.max(maximum, active);
      await delay(25);
      active--;
      return step.id;
    },
  });

  const started = await engine.start(request());
  const run = await engine.wait(started.id);
  assert.equal(run.status, "completed");
  assert.equal(maximum, 2);
});

test("an agent failure leaves a failed step and may be caught by Flow code", async () => {
  const loaded = flow(async (ctx) => {
    let failure = "";
    try {
      await ctx.agent({
        id: "optional",
        label: "可选检查",
        preset: "reviewer-v1",
        prompt: "fail",
      });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    return { report: `已降级：${failure}` };
  });
  const { engine } = await fixture({
    loaded,
    execute: async () => {
      throw new Error("provider private error");
    },
  });
  const started = await engine.start(request());
  const run = await engine.wait(started.id);

  assert.equal(run.status, "completed");
  assert.equal(run.steps[0]?.status, "failed");
  assert.match((run.output as { report: string }).report, /已降级/);
  assert.doesNotMatch(JSON.stringify(run), /provider private error/);
});

test("an unobserved agent rejection still fails the Flow run", async () => {
  const loaded = flow(async (ctx) => {
    void ctx.agent({
      id: "forgotten",
      label: "未等待步骤",
      preset: "reviewer-v1",
      prompt: "fail",
    });
    return { report: "must not complete" };
  });
  const { engine } = await fixture({
    loaded,
    execute: async () => {
      throw new Error("provider private error");
    },
  });
  const started = await engine.start(request());
  const run = await engine.wait(started.id);
  assert.equal(run.status, "failed");
  assert.equal(run.steps[0]?.status, "failed");
});

test("duplicate step ids fail the run and preserve the first step", async () => {
  const loaded = flow(async (ctx) => {
    await Promise.all([
      ctx.agent({
        id: "same",
        label: "一",
        preset: "researcher-v1",
        prompt: "one",
      }),
      ctx.agent({
        id: "same",
        label: "二",
        preset: "reviewer-v1",
        prompt: "two",
      }),
    ]);
    return { report: "never" };
  });
  const { engine } = await fixture({ loaded });
  const started = await engine.start(request());
  const run = await engine.wait(started.id);

  assert.equal(run.status, "failed");
  assert.match(run.error ?? "", /步骤 ID 不能重复/);
  assert.equal(run.steps.length, 1);
});

test("input, output and JSON persistence limits are enforced", async () => {
  const invalidOutput = flow(async () => ({ report: 42 }));
  const { engine } = await fixture({ loaded: invalidOutput });
  await assert.rejects(engine.start(request({ task: "" })), /Flow 入参/);

  let started = await engine.start(request());
  let run = await engine.wait(started.id);
  assert.equal(run.status, "failed");
  assert.match(run.error ?? "", /report/);

  const nonJson = flow(async () => ({ report: "ok", invalid: BigInt(1) }), {
    outputSchema: z.object({ report: z.string(), invalid: z.any() }),
  });
  const next = await fixture({ loaded: nonJson });
  started = await next.engine.start(request());
  run = await next.engine.wait(started.id);
  assert.equal(run.status, "failed");
  assert.match(run.error ?? "", /可序列化/);

  await assert.rejects(
    next.engine.start(request({ task: "x".repeat(300_000) })),
    /字节限制/,
  );
});

test("cancellation aborts running and queued agents without dispatching later work", async () => {
  const calls: string[] = [];
  const loaded = flow(
    async (ctx) => {
      await Promise.all([
        ctx.agent({
          id: "one",
          label: "一",
          preset: "researcher-v1",
          prompt: "one",
        }),
        ctx.agent({
          id: "two",
          label: "二",
          preset: "reviewer-v1",
          prompt: "two",
        }),
      ]);
      await ctx.agent({
        id: "later",
        label: "稍后",
        preset: "coordinator-v1",
        prompt: "later",
      });
      return { report: "never" };
    },
    { concurrency: 1 },
  );
  const { engine } = await fixture({
    loaded,
    execute: async (step) => {
      calls.push(step.id);
      await delay(10_000, undefined, { signal: step.signal });
      return "done";
    },
  });
  const started = await engine.start(request());
  while (!calls.length) await delay(1);
  const run = await engine.cancel(started.id);

  assert.equal(run.status, "cancelled");
  assert.deepEqual(calls, ["one"]);
  assert.equal(run.steps.length, 2);
  assert.ok(run.steps.every(({ status }) => status === "cancelled"));
});

test("request ids are idempotent and an in-flight run pins its loaded Flow", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => (release = resolve));
  const first = flow(async () => {
    await blocked;
    return { report: "old" };
  });
  const { engine, replaceFlow } = await fixture({ loaded: first });
  const input = request();
  const [a, b] = await Promise.all([engine.start(input), engine.start(input)]);
  assert.equal(a.id, b.id);
  await assert.rejects(
    engine.start({ ...input, input: { task: "changed" } }),
    /不同输入/,
  );

  replaceFlow(flow(async () => ({ report: "new" }), { sourceHash: hash("b") }));
  release();
  const oldRun = await engine.wait(a.id);
  assert.deepEqual(oldRun.output, { report: "old" });
  assert.equal(oldRun.flow.sourceHash, hash());

  const newer = await engine.start(request());
  const newRun = await engine.wait(newer.id);
  assert.deepEqual(newRun.output, { report: "new" });
  assert.equal(newRun.flow.sourceHash, hash("b"));
});

test("restart marks unfinished code runs interrupted and never replays them", async () => {
  const runs = table<FlowRun>();
  const id = randomUUID();
  await runs.put(id, {
    id,
    requestId: randomUUID(),
    flow: {
      id: "test-flow",
      title: "测试 Flow",
      description: "",
      sourceHash: hash(),
    },
    input: { task: "do not replay" },
    mode: "demo",
    status: "running",
    createdAt: Date.now(),
    steps: [
      {
        id: "agent",
        label: "Agent",
        preset: "researcher-v1",
        sessionId: randomUUID(),
        status: "running",
      },
    ],
  });
  let calls = 0;
  const { engine } = await fixture({
    runs,
    execute: async () => {
      calls++;
      return "unexpected";
    },
  });
  const restored = runs.get(id);
  assert.equal(restored?.status, "interrupted");
  assert.equal(restored?.steps[0]?.status, "interrupted");
  assert.equal(calls, 0);
  assert.equal(engine.running.size, 0);
});
