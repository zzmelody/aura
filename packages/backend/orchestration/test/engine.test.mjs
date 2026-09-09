import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { FlowEngine } from "../src/engine.ts";
import {
  defaultDefinition,
  definitionSchema,
  buildInput,
} from "../src/schema.ts";

function table() {
  const records = new Map();
  let chain = Promise.resolve();
  return {
    get: (id) => records.get(id),
    entries: () => records.entries(),
    put: async (id, value) => {
      records.set(id, structuredClone(value));
    },
    update(id, change) {
      const work = chain.then(() => {
        const next = change(records.get(id));
        records.set(id, structuredClone(next));
        return next;
      });
      chain = work.catch(() => {});
      return work;
    },
  };
}
async function fixture(execute = async ({ id }) => `${id} output`, tables) {
  const stores = tables ?? { definitions: table(), runs: table() };
  const engine = new FlowEngine({
    domain: { table: (name) => stores[name] },
    sessions: {
      execute,
      history: async (step) => ({ sessionId: step.sessionId, entries: [] }),
    },
    presets: async () =>
      ["researcher-v1", "reviewer-v1", "coordinator-v1"].map((id) => ({
        id,
        unavailable: false,
      })),
  });
  await engine.initialize();
  return { engine, stores };
}
const request = () => ({
  requestId: randomUUID(),
  definitionId: defaultDefinition.id,
  task: "测试任务",
  mode: "demo",
});
async function finished(engine, run) {
  const deadline = Date.now() + 3000;
  while (engine.running.has(run.id) && Date.now() < deadline) await delay(5);
  assert.ok(!engine.running.has(run.id), "run did not settle");
  return engine.get(run.id);
}

test("validation rejects cycles, missing/duplicate refs, reserved ids and unsafe limits", () => {
  const mutate = (fn) => {
    const d = structuredClone(defaultDefinition);
    fn(d);
    assert.equal(definitionSchema.safeParse(d).success, false);
  };
  mutate((d) => {
    d.nodes[0].dependsOn = ["review"];
    d.nodes[1].dependsOn = ["research"];
  });
  mutate((d) => {
    d.nodes[0].dependsOn = ["missing"];
  });
  mutate((d) => {
    d.nodes[1].id = "research";
  });
  mutate((d) => {
    d.nodes[0].id = "coordinator";
  });
  mutate((d) => {
    d.coordinator.sources = ["research", "research"];
  });
  mutate((d) => {
    d.coordinator.sources = ["missing"];
  });
  mutate((d) => {
    d.concurrency = 100;
  });
  mutate((d) => {
    d.timeoutMs = 0;
  });
  mutate((d) => {
    d.nodes[0].preset = "../private";
  });
});

test("dependency results arrive before downstream execution; coordinator sees only selected outputs", async () => {
  const calls = [];
  const { engine } = await fixture(async (step) => {
    calls.push({ id: step.id, input: JSON.parse(step.input.split("\n")[1]) });
    return `${step.id} output`;
  });
  const definition = structuredClone(defaultDefinition);
  definition.nodes[1].dependsOn = ["research"];
  definition.coordinator.sources = ["review"];
  await engine.save(definition);
  const run = await finished(engine, await engine.start(request()));
  assert.deepEqual(
    calls.map((c) => c.id),
    ["research", "review", "coordinator"],
  );
  assert.deepEqual(
    calls[1].input.inputs.map((i) => i.output),
    ["research output"],
  );
  assert.deepEqual(
    calls[2].input.inputs.map((i) => i.nodeId),
    ["review"],
  );
  assert.equal(run.report, "coordinator output");
});

test("parallelism is bounded and actual independent sessions overlap", async () => {
  let count = 0;
  let maximum = 0;
  const { engine } = await fixture(async ({ id }) => {
    count++;
    maximum = Math.max(maximum, count);
    await delay(30);
    count--;
    return id;
  });
  const run = await finished(engine, await engine.start(request()));
  assert.equal(maximum, 2);
  assert.equal(new Set(run.steps.map((s) => s.sessionId)).size, 3);
  assert.equal(run.status, "completed");
});

test("failed dependencies prevent downstream work and final aggregation; other completed output remains", async () => {
  const calls = [];
  const { engine } = await fixture(async ({ id }) => {
    calls.push(id);
    if (id === "research") throw new Error("provider private error");
    return "review output";
  });
  const run = await finished(engine, await engine.start(request()));
  assert.equal(run.status, "failed");
  assert.ok(!calls.includes("coordinator"));
  assert.equal(
    run.steps.find((s) => s.id === "review").output,
    "review output",
  );
  assert.ok(!JSON.stringify(run).includes("provider private error"));
});

test("cancel stops active sessions, never starts pending nodes and keeps mappings", async () => {
  const calls = [];
  const { engine } = await fixture(async ({ id, signal }) => {
    calls.push(id);
    await delay(10000, undefined, { signal });
    return "done";
  });
  const d = structuredClone(defaultDefinition);
  d.concurrency = 1;
  await engine.save(d);
  const run = await engine.start(request());
  while (!calls.length) await delay(1);
  const cancelled = await engine.cancel(run.id);
  assert.deepEqual(calls, ["research"]);
  assert.equal(cancelled.status, "cancelled");
  assert.ok(cancelled.steps.every((step) => step.status === "cancelled"));
  assert.equal(cancelled.steps.length, 3);
});

test("concurrent duplicate starts are idempotent, changed reuse conflicts, run definitions are snapshots", async () => {
  const { engine } = await fixture();
  const input = request();
  const [a, b] = await Promise.all([engine.start(input), engine.start(input)]);
  assert.equal(a.id, b.id);
  await assert.rejects(
    engine.start({ ...input, task: "另一个任务" }),
    /不同输入/,
  );
  await Promise.all([
    engine.save(defaultDefinition),
    engine.save({ ...defaultDefinition, name: "新版" }),
  ]);
  assert.equal(engine.definitions.get(defaultDefinition.id).revision, 3);
  const run = await finished(engine, a);
  assert.equal(run.definition.name, defaultDefinition.name);
  assert.equal(run.revision, 1);
});

test("restart marks unfinished runs interrupted, retains completed content and never replays prompts", async () => {
  const { engine, stores } = await fixture();
  const original = await finished(engine, await engine.start(request()));
  await stores.runs.put(original.id, {
    ...original,
    status: "running",
    steps: original.steps.map((s, i) =>
      i === 2 ? { ...s, status: "running" } : s,
    ),
  });
  const { engine: restored } = await fixture(async () => {
    throw new Error("must never run");
  }, stores);
  const run = restored.get(original.id);
  assert.equal(run.status, "interrupted");
  assert.equal(run.steps[0].output, "research output");
  assert.equal(run.steps[2].status, "interrupted");
  assert.equal(restored.running.size, 0);
});

test("unknown presets, invalid mode and oversized aggregate inputs are rejected", async () => {
  const { engine } = await fixture();
  const d = structuredClone(defaultDefinition);
  d.coordinator.preset = "missing";
  await assert.rejects(engine.save(d), /Preset/);
  await assert.rejects(
    engine.start({ ...request(), mode: "arbitrary-provider" }),
  );
  assert.throws(
    () =>
      buildInput({ task: "x" }, { id: "x", prompt: "x" }, [
        { output: "x".repeat(180000) },
      ]),
    /输入过大/,
  );
});

test("each node run is bounded by output validity and run capacity", async () => {
  const { engine } = await fixture(async ({ signal }) => {
    await delay(10000, undefined, { signal });
    return "done";
  });
  const first = await engine.start(request());
  await engine.start(request());
  await assert.rejects(engine.start(request()), /两个流程/);
  await engine.close();
  assert.equal(engine.get(first.id).status, "cancelled");
  const { engine: empty } = await fixture(async () => "");
  const run = await finished(empty, await empty.start(request()));
  assert.equal(run.status, "failed");
  assert.match(run.steps[0].error, /输出为空/);
});
