import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { CodedFlowError } from "@aura/protocol/errors";
import { setTimeout as delay } from "node:timers/promises";
import type { ActionRun, FlowRun } from "@aura/protocol/types";
import { z } from "zod";
import { FlowEngine } from "../src/engine.ts";
import type { FlowScope } from "../src/flow-api.ts";
import type { LoadedFlow } from "../src/registry.ts";
import type {
  EngineOptions,
  FlowDomain,
  SessionPort,
  Table,
} from "../src/types.ts";
import type { LoadedAction } from "../src/action-registry.ts";
import { ActionRegistry } from "../src/action-registry.ts";
import { ActionRuns } from "../src/action-runs.ts";
import type { ActionRuntime } from "../src/actions.ts";
import { FLOW_TIMEOUT_MS } from "../src/timeouts.ts";

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
  run: (scope: FlowScope, input: unknown) => unknown,
  options: Partial<LoadedFlow> = {},
): LoadedFlow {
  return {
    id: "test-flow",
    title: "测试 Flow",
    description: "",
    service: false,
    sourceHash: hash(),
    inputSchema: z.object({ task: z.string().min(1) }),
    outputSchema: z.object({ report: z.string() }),
    concurrency: 2,
    agentTimeoutMs: 1_000,
    permissions: [],
    run: (ctx, input) =>
      ctx.sequence({ id: "main" }, (scope) => run(scope, input)),
    ...options,
  };
}

function standardFlow(): LoadedFlow {
  return flow(async (ctx, input) => {
    const task = (input as { task: string }).task;
    const { research, review } = await ctx.parallel({
      id: "analysis",
      branches: {
        research: (ctx) =>
          ctx.agent({
            id: "research",
            label: "研究",
            preset: "researcher-v1",
            prompt: `research:${task}`,
          }),
        review: (ctx) =>
          ctx.agent({
            id: "review",
            label: "审阅",
            preset: "reviewer-v1",
            prompt: `review:${task}`,
          }),
      },
    });
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
    reconcile?: SessionPort["reconcile"];
    runs?: Table<FlowRun>;
    actions?: EngineOptions["actions"];
  } = {},
) {
  let loaded = options.loaded ?? standardFlow();
  const runs = options.runs ?? table<FlowRun>();
  const domain: FlowDomain = { table: () => runs };
  const engine = new FlowEngine({
    domain,
    sessions: {
      execute: options.execute ?? (async (step) => `${step.id} output`),
      ...(options.reconcile ? { reconcile: options.reconcile } : {}),
      history: async (step, beforeSeq) => ({
        sessionId: step.sessionId,
        preset: step.preset,
        entries: [],
        hasMore: false,
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
    actions: options.actions,
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

test("Flow control errors carry display codes without changing completed records or reusing a request for different input", async (t) => {
  const { engine, runs } = await fixture({
    loaded: flow(async () => ({ report: "original output" })),
  });
  t.after(() => engine.close());
  const input = request();
  const started = await engine.start(input);
  const completed = await engine.wait(started.id);
  const saved = JSON.stringify([...runs.entries()]);
  for (const operation of [
    () => engine.pause(completed.id),
    () => engine.resume(completed.id),
  ])
    await assert.rejects(operation(), (error) => {
      assert.ok(error instanceof CodedFlowError);
      assert.equal(error.status, 409);
      assert.deepEqual(error.details, { code: "flow_ended" });
      assert.match(error.message, /此运行已结束/u);
      return true;
    });
  await assert.rejects(
    engine.start({ ...input, input: { task: "different" } }),
    (error) => {
      assert.ok(error instanceof CodedFlowError);
      assert.deepEqual(error.details, { code: "flow_input_conflict" });
      return true;
    },
  );
  assert.throws(
    () => engine.get("missing"),
    (error) => {
      assert.ok(error instanceof CodedFlowError);
      assert.equal(error.status, 404);
      assert.deepEqual(error.details, { code: "flow_run_missing" });
      return true;
    },
  );
  assert.equal(JSON.stringify([...runs.entries()]), saved);
  assert.equal(saved.includes("errorDetails"), false);
  assert.deepEqual(engine.get(completed.id).output, {
    report: "original output",
  });
});

test("Flow failures project run, step and attempt translations without persisting them or dispatching another attempt", async (t) => {
  for (const uncertain of [false, true]) {
    let calls = 0;
    const options = {
      loaded: flow(async (ctx) => ({
        report: (
          await ctx.agent({
            id: "model",
            label: "Original step",
            preset: "researcher-v1",
            prompt: "Original prompt",
          })
        ).output,
      })),
      execute: async () => {
        calls++;
        throw new CodedFlowError("original safe failure", 402, {
          code: "model_budget_exceeded",
        });
      },
      reconcile: async () => ({ actionStarted: uncertain }),
    };
    const { engine, runs } = await fixture(options);
    t.after(() => engine.close());
    const started = await engine.start(request());
    await engine.wait(started.id);
    const durable = JSON.stringify([...runs.entries()]);
    const view = engine.view(started.id);
    const details = {
      failure: { code: "model_budget_exceeded" },
      ...(uncertain ? { uncertainty: "agent_result_unknown" } : {}),
    };
    assert.deepEqual(view.steps[0].errorDetails, details);
    assert.deepEqual(view.steps[0].attempts?.[0].errorDetails, details);
    if (!uncertain) assert.deepEqual(view.errorDetails, details);
    else assert.equal(view.status, "needs_attention");
    assert.equal(engine.get(started.id).steps[0].errorDetails, undefined);
    assert.equal(durable.includes("errorDetails"), false);
    assert.equal(JSON.stringify([...runs.entries()]), durable);
    assert.equal(calls, 1);
    view.steps[0].label = "changed client copy";
    assert.equal(engine.get(started.id).steps[0].label, "Original step");
    const restarted = await fixture({ ...options, runs });
    t.after(() => restarted.engine.close());
    assert.equal(
      restarted.engine.view(started.id).steps[0].errorDetails,
      undefined,
    );
    assert.equal(
      calls,
      1,
      "restoring old failures never dispatches another model request",
    );
    await runs.update(started.id, (current) => ({
      ...current,
      steps: current.steps.map((step) => ({
        ...step,
        error: "different error",
      })),
    }));
    assert.equal(engine.view(started.id).steps[0].errorDetails, undefined);
    assert.equal(calls, 1);
  }
});

test("all Flows enforce a 360 minute execution window and settle active attempts", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let aborted = false;
  const { engine } = await fixture({
    loaded: flow(async (ctx) => {
      const result = await ctx.agent({
        id: "long",
        label: "Long call",
        preset: "researcher-v1",
        prompt: "work",
      });
      return { report: result.output };
    }),
    execute: async ({ signal }) => {
      started();
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(signal.reason);
          },
          { once: true },
        );
      });
    },
  });
  try {
    const run = await engine.start(request());
    await ready;
    t.mock.timers.tick(FLOW_TIMEOUT_MS - 1);
    assert.equal(aborted, false);
    t.mock.timers.tick(1);
    const result = await engine.wait(run.id);
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /FLOW_TIMEOUT.*360/u);
    assert.equal(aborted, true);
    assert.equal(result.steps[0].status, "failed");
    assert.equal(result.steps[0].attempts?.[0].status, "failed");
  } finally {
    await engine.close();
  }
});

test("Action steps and Agents share admission, ids, version snapshots and failure tracking", async () => {
  const old: LoadedAction = {
    id: "probe",
    title: "Probe",
    description: "test",
    sourceHash: hash(),
    inputSchema: {},
    outputSchema: {},
    tool: () => {
      throw new Error("unused adapter");
    },
  };
  let current = old;
  let release!: () => void;
  const barrier = new Promise<void>((done) => {
    release = done;
  });
  let inAgent = false;
  const { engine } = await fixture({
    loaded: flow(async (ctx) => {
      await ctx.agent({
        id: "barrier",
        label: "Barrier",
        preset: "researcher-v1",
        prompt: "wait",
        actions: ["probe"],
      });
      const output = await ctx.action({
        id: "direct",
        action: "probe",
        input: { value: 1 },
      });
      try {
        await ctx.action({ id: "optional", action: "missing", input: {} });
      } catch {}
      return { report: String(output.output) };
    }),
    execute: async (step) => {
      assert.equal(step.actionDefinitions[0]?.sourceHash, hash());
      inAgent = true;
      await barrier;
      return "ready";
    },
    actions: {
      cwd: process.cwd(),
      registry: {
        catalog: () => [],
        snapshot: () => new Map([[current.id, current]]),
      },
      runtime: { execute: async (action) => action.sourceHash },
    },
  });
  const started = await engine.start(request());
  while (!inAgent) await delay(1);
  current = { ...old, sourceHash: hash("b") };
  release();
  const result = await engine.wait(started.id);
  assert.equal(result.status, "completed");
  assert.deepEqual(result.output, { report: hash() });
  assert.deepEqual(
    result.steps.map((s) => [s.kind, s.status]),
    [
      ["agent", "completed"],
      ["action", "completed"],
      ["action", "failed"],
    ],
  );
  assert.equal(
    result.steps[1]?.kind === "action" && result.steps[1].sourceHash,
    undefined,
  );
  await assert.rejects(
    engine.history(result.id, "main/direct"),
    /没有 DSH session/,
  );
});

test("unhandled Action failures and Agent/Action id collisions fail the Flow", async () => {
  for (const observed of [false, true]) {
    const { engine } = await fixture({
      loaded: flow(async (ctx) => {
        if (observed) {
          await ctx.agent({
            id: "same",
            label: "Agent",
            preset: "researcher-v1",
            prompt: "test",
          });
          await ctx.action({ id: "same", action: "unknown", input: {} });
        } else {
          void ctx.action({ id: "forgotten", action: "unknown", input: {} });
        }
        return { report: "must fail" };
      }),
    });
    const started = await engine.start(request());
    const result = await engine.wait(started.id);
    assert.equal(result.status, "failed");
    assert.equal(result.steps.length, observed ? 1 : 0);
    assert.match(result.error ?? "", observed ? /不能重复/ : /未 await/);
  }
});

test("cancellation drains an active Action and prevents queued Agent dispatch", async () => {
  let startedAction = false;
  let agentCalls = 0;
  const action: LoadedAction = {
    id: "slow",
    title: "Slow",
    description: "test",
    sourceHash: hash(),
    inputSchema: {},
    outputSchema: {},
    tool: () => {
      throw new Error("unused");
    },
  };
  const { engine } = await fixture({
    loaded: flow(
      async (ctx) => {
        await ctx.parallel({
          id: "batch",
          branches: {
            slow: (ctx) =>
              ctx.action({ id: "slow", action: "slow", input: {} }),
            queued: (ctx) =>
              ctx.agent({
                id: "queued",
                label: "Queued",
                preset: "researcher-v1",
                prompt: "test",
              }),
          },
        });
        return { report: "never" };
      },
      { concurrency: 1 },
    ),
    execute: async () => {
      agentCalls++;
      return "unexpected";
    },
    actions: {
      cwd: process.cwd(),
      registry: {
        catalog: () => [],
        snapshot: () => new Map([[action.id, action]]),
      },
      runtime: {
        execute: async (_action, _args, _binding, signal) => {
          startedAction = true;
          await delay(10_000, undefined, { signal });
          return "done";
        },
      },
    },
  });
  const started = await engine.start(request());
  while (!startedAction) await delay(1);
  const result = await engine.cancel(started.id);
  assert.equal(result.status, "cancelled");
  assert.equal(agentCalls, 0);
  assert.ok(result.steps.every((s) => s.status === "cancelled"));
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
  assert.equal(
    new Set(
      run.steps.map((step) =>
        "sessionId" in step ? step.sessionId : undefined,
      ),
    ).size,
    3,
  );
  assert.equal(
    (await engine.history(run.id, "main/analysis/research/research")).preset,
    "researcher-v1",
  );
});

test("structured parallel is bounded by the Flow concurrency setting", async () => {
  let active = 0;
  let maximum = 0;
  const loaded = flow(
    async (ctx) => {
      const outputs = await ctx.parallel({
        id: "batch",
        branches: Object.fromEntries(
          ["one", "two", "three"].map((id) => [
            id,
            (ctx: FlowScope) =>
              ctx.agent({ id, label: id, preset: "researcher-v1", prompt: id }),
          ]),
        ),
      });
      return {
        report: Object.values(outputs)
          .map(({ output }) => output)
          .join(","),
      };
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
  assert.equal(run.steps.length, 0);
  assert.match(run.error ?? "", /未 await/);
});

test("duplicate step ids fail the run and preserve the first step", async () => {
  const loaded = flow(async (ctx) => {
    await ctx.agent({
      id: "same",
      label: "一",
      preset: "researcher-v1",
      prompt: "one",
    });
    await ctx.agent({
      id: "same",
      label: "二",
      preset: "reviewer-v1",
      prompt: "two",
    });
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
      await ctx.parallel({
        id: "batch",
        branches: {
          one: (ctx) =>
            ctx.agent({
              id: "one",
              label: "一",
              preset: "researcher-v1",
              prompt: "one",
            }),
          two: (ctx) =>
            ctx.agent({
              id: "two",
              label: "二",
              preset: "reviewer-v1",
              prompt: "two",
            }),
        },
      });
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
  assert.equal(oldRun.flow.sourceHash, undefined);

  const newer = await engine.start(request());
  const newRun = await engine.wait(newer.id);
  assert.deepEqual(newRun.output, { report: "new" });
  assert.equal(newRun.flow.sourceHash, undefined);
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
  assert.deepEqual(engine.view(id).errorDetails, {
    failure: { code: "recovery_legacy" },
  });
  assert.equal(JSON.stringify(runs.get(id)).includes("errorDetails"), false);
  assert.equal(calls, 0);
  assert.equal(engine.running.size, 0);
});

test("standalone Action restart never replays side effects; request ids retain completed records", async () => {
  const records = table<ActionRun>();
  const interrupted: ActionRun = {
    id: randomUUID(),
    requestId: randomUUID(),
    actionId: "test",
    sourceHash: hash(),
    input: {},
    mode: "demo",
    status: "running",
    createdAt: Date.now(),
  };
  await records.put(interrupted.id, interrupted);
  const completed: ActionRun = {
    ...interrupted,
    id: randomUUID(),
    requestId: randomUUID(),
    status: "completed",
    output: { value: 1 },
  };
  await records.put(completed.id, completed);
  let calls = 0;
  const runner = new ActionRuns({
    table: records,
    registry: new ActionRegistry(),
    cwd: process.cwd(),
    refresh: async () => {},
    runtime: {
      execute: async () => {
        calls++;
        return null;
      },
    } as unknown as ActionRuntime,
  });
  await runner.initialize();
  assert.equal(runner.get(interrupted.id).status, "interrupted");
  assert.deepEqual(runner.get(completed.id).output, { value: 1 });
  const same = await runner.start({
    actionId: "test",
    requestId: completed.requestId,
    input: {},
    mode: "demo",
  });
  assert.equal(same.id, completed.id);
  await assert.rejects(
    runner.start({
      actionId: "test",
      requestId: completed.requestId,
      input: { changed: true },
      mode: "demo",
    }),
    /不同输入/,
  );
  assert.equal(calls, 0);
  await runner.close();
});
