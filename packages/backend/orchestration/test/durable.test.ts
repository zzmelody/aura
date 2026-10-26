import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { FlowRun, FlowAgentStep } from "@aura/protocol/types";
import type { FlowScope } from "../src/flow-api.ts";
import type { EngineOptions, Table } from "../src/types.ts";
import type { LoadedFlow } from "../src/registry.ts";
import type { LoadedAction } from "../src/action-registry.ts";
import { FlowEngine } from "../src/engine.ts";
import { DEFAULT_TOP_LEVEL_RUN_CONCURRENCY } from "../src/scheduler.ts";
import { runSchema } from "../src/schema.ts";
import { recoverStep } from "../src/recovery.ts";
import { validateFlowSource } from "../src/flow-diagnostics.ts";
import { savedSchema, validateSaved, StorageFailure } from "../src/durable.ts";
import { agentConfig, agentDefaults } from "../src/agent-config.ts";
import {
  agentOptionsSchema,
  agentRequestSchema,
  stepSchema,
  FlowError,
} from "../src/schema.ts";

test("storage failure preserves its cause but exposes only safe OS codes", () => {
  const cause = Object.assign(new Error("private record and credential path"), {
    code: "EPERM",
  });
  const error = new StorageFailure(cause);
  assert.equal(error.cause, cause);
  assert.match(error.message, /EPERM/u);
  assert.doesNotMatch(error.message, /private|credential/u);
  assert.doesNotMatch(
    new StorageFailure({ code: "secret-value" }).message,
    /secret-value/u,
  );
});

test("Codex defaults to GPT-6.1 Sol xhigh and retains explicit overrides", () => {
  const previous = process.env.AURA_CODEX_MODEL;
  try {
    delete process.env.AURA_CODEX_MODEL;
    const defaults = agentDefaults("codex");
    assert.equal(defaults.model, "gpt-6.1-sol");
    assert.equal(defaults.reasoningEffort, "xhigh");
    assert.equal(agentDefaults("demo").reasoningEffort, "off");
    process.env.AURA_CODEX_MODEL = "gpt-5.6-terra";
    assert.equal(agentDefaults("codex").model, "gpt-5.6-terra");
    assert.equal(
      agentDefaults("codex", { reasoningEffort: "high" }).reasoningEffort,
      "high",
    );
    assert.equal(
      agentConfig(defaults, { reasoningEffort: "medium" }).reasoningEffort,
      "medium",
    );
  } finally {
    if (previous === undefined) delete process.env.AURA_CODEX_MODEL;
    else process.env.AURA_CODEX_MODEL = previous;
  }
});

test("Agent options validate bounds and inherit step > Flow > runtime defaults", () => {
  const defaults = agentDefaults(
    "demo",
    { temperature: 0.6, timeoutMs: 8000 },
    9000,
  );
  assert.deepEqual(
    agentConfig(defaults, {
      model: "other-model",
      temperature: 0,
      timeoutMs: undefined,
    }),
    {
      provider: "deepseek-official",
      model: "other-model",
      reasoningEffort: "off",
      maxTokens: 4096,
      temperature: 0,
      timeoutMs: 8000,
    },
  );
  assert.equal(
    agentDefaults("codex", {}, 10000, "configured-model").model,
    "configured-model",
  );
  for (const bad of [
    { model: " " },
    { reasoningEffort: "" },
    { maxTokens: 0 },
    { maxTokens: 1.5 },
    { maxTokens: 1_000_001 },
    { temperature: -1 },
    { temperature: 2.1 },
    { timeoutMs: 999 },
    { timeoutMs: 600_001 },
    { provider: "custom" },
    { apiKey: "secret" },
  ])
    assert.equal(
      agentOptionsSchema.safeParse(bad).success,
      false,
      JSON.stringify(bad),
    );
  assert.equal(
    agentRequestSchema.safeParse({ ...agent("one"), provider: "custom" })
      .success,
    false,
  );
  assert.throws(
    () => agentDefaults("codex", { maxTokens: 4096 }),
    /AGENT_OPTION_UNSUPPORTED/,
  );
});

test("plugin Agent presets execute and survive persistence and restart without replaying completed calls", async () => {
  const presets = [
    "wechat-history/persona-analyst",
    "melody.tools/persona-chat",
  ];
  const calls: string[] = [];
  const workflow = async (flow: FlowScope) => {
    const profile = await flow.agent({
      ...agent("profile"),
      preset: presets[0]!,
    });
    await flow.checkpoint({
      id: "wait",
      prompt: "Continue?",
      schema: z.boolean(),
    });
    const reply = await flow.agent({ ...agent("reply"), preset: presets[1]! });
    return { profile: profile.output, reply: reply.output };
  };
  const sessions: Partial<EngineOptions["sessions"]> = {
    execute: async (step) => {
      calls.push(step.preset);
      return step.id;
    },
  };
  const first = await setup(workflow, { presets, sessions });
  let second: Awaited<ReturnType<typeof setup>> | undefined;
  try {
    const run = await first.engine.start(req());
    const waiting = await first.engine.wait(run.id);
    assert.equal(waiting.status, "waiting_input", waiting.error);
    await first.engine.close();
    const restored = table();
    await restored.put(run.id, JSON.parse(JSON.stringify(waiting)));
    second = await setup(workflow, { table: restored, presets, sessions });
    await second.engine.command(
      run.id,
      "answer",
      { requestId: randomUUID(), output: true },
      "main/wait",
    );
    const completed = await second.engine.wait(run.id);
    assert.equal(completed.status, "completed", completed.error);
    assert.deepEqual(completed.output, { profile: "profile", reply: "reply" });
    assert.deepEqual(calls, presets);
    assert.deepEqual(
      runSchema
        .parse(JSON.parse(JSON.stringify(completed)))
        .steps.filter((step) => step.kind === "agent")
        .map((step) => step.preset),
      presets,
    );
  } finally {
    await first.engine.close();
    await second?.engine.close();
  }
});

test("Agent preset IDs retain legacy compatibility and reject malformed namespaces", () => {
  const request = agent("profile");
  const saved = {
    id: "profile",
    label: "Profile",
    kind: "agent",
    status: "completed",
    sessionId: randomUUID(),
  };
  for (const preset of ["Researcher_v1", "wechat-history/persona-analyst"]) {
    assert.equal(
      agentRequestSchema.safeParse({ ...request, preset }).success,
      true,
    );
    assert.equal(stepSchema.safeParse({ ...saved, preset }).success, true);
  }
  for (const preset of [
    "../analyst",
    "plugin/../analyst",
    "plugin/",
    "/analyst",
    "plugin/analyst/extra",
    "plugin\\analyst",
  ]) {
    assert.equal(
      agentRequestSchema.safeParse({ ...request, preset }).success,
      false,
      preset,
    );
    assert.equal(
      stepSchema.safeParse({ ...saved, preset }).success,
      false,
      preset,
    );
  }
  assert.equal(
    agentRequestSchema.safeParse({ ...request, id: "plugin/step" }).success,
    false,
  );
});

test("Agent configuration is isolated per step and pinned across retries, checkpoints and restart", async () => {
  const previous = process.env.AURA_CODEX_MODEL;
  process.env.AURA_CODEX_MODEL = "original-default";
  const observed: Array<{ id: string; config: unknown; timeoutMs: number }> =
    [];
  let firstCalls = 0;
  const workflow = async (flow: FlowScope) => {
    await flow.agent({
      ...agent("first", 2),
      model: "step-model",
      reasoningEffort: "high",
      temperature: 0.2,
      timeoutMs: 12000,
    });
    await flow.checkpoint({
      id: "wait",
      prompt: "Continue?",
      schema: z.boolean(),
    });
    return flow.agent(agent("second"));
  };
  const sessions: Partial<EngineOptions["sessions"]> = {
    execute: async (step) => {
      observed.push({
        id: step.id,
        config: structuredClone(step.config),
        timeoutMs: step.timeoutMs,
      });
      if (step.id === "first" && firstCalls++ === 0) {
        process.env.AURA_CODEX_MODEL = "changed-during-retry";
        throw new Error("transient failure");
      }
      return "saved";
    },
  };
  let first: Awaited<ReturnType<typeof setup>> | undefined;
  let second: Awaited<ReturnType<typeof setup>> | undefined;
  try {
    first = await setup(workflow, { sessions });
    first.replaceFlow({
      agentDefaults: {
        reasoningEffort: "low",
        temperature: 0.6,
        timeoutMs: 15000,
      },
    });
    const run = await first.engine.start({ ...req(), mode: "codex" });
    assert.equal((await first.engine.wait(run.id)).status, "waiting_input");
    assert.deepEqual(observed[0], observed[1]);
    assert.deepEqual(observed[0]!.config, {
      provider: "openai-codex",
      model: "step-model",
      reasoningEffort: "high",
      temperature: 0.2,
      timeoutMs: 12000,
    });
    assert.equal(observed[0]!.timeoutMs, 12000);
    await first.engine.close();
    process.env.AURA_CODEX_MODEL = "changed-after-restart";
    second = await setup(workflow, { table: first.records, sessions });
    await second.engine.command(
      run.id,
      "answer",
      { requestId: randomUUID(), output: true },
      "main/wait",
    );
    const completed = await second.engine.wait(run.id);
    assert.equal(completed.status, "completed");
    assert.equal(observed.length, 3);
    assert.deepEqual(observed[2]!.config, {
      provider: "openai-codex",
      model: "original-default",
      reasoningEffort: "low",
      temperature: 0.6,
      timeoutMs: 15000,
    });
    assert.equal(completed.agentDefaults!.model, "original-default");
  } finally {
    await first?.engine.close();
    await second?.engine.close();
    if (previous === undefined) delete process.env.AURA_CODEX_MODEL;
    else process.env.AURA_CODEX_MODEL = previous;
  }
});

test("changed Agent parameters conflict with replay and invalid capabilities fail before dispatch", async () => {
  for (const field of [
    "model",
    "reasoningEffort",
    "maxTokens",
    "temperature",
    "timeoutMs",
  ] as const) {
    let options = {
      model: "test",
      reasoningEffort: "off",
      maxTokens: 1000,
      temperature: 0.5,
      timeoutMs: 5000,
    };
    let calls = 0;
    const { engine } = await setup(
      async (flow) => {
        await flow.agent({ ...agent("one"), ...options });
        return flow.checkpoint({
          id: "wait",
          prompt: "?",
          schema: z.boolean(),
        });
      },
      {
        sessions: {
          execute: async () => {
            calls++;
            return "saved";
          },
        },
      },
    );
    try {
      const run = await engine.start(req());
      await engine.wait(run.id);
      options = {
        ...options,
        [field]:
          typeof options[field] === "number"
            ? Number(options[field]) + 1
            : "different",
      };
      await engine.command(
        run.id,
        "answer",
        { requestId: randomUUID(), output: true },
        "main/wait",
      );
      const result = await engine.wait(run.id);
      assert.equal(result.status, "interrupted", field);
      assert.match(result.error!, /FLOW_REPLAY_MISMATCH/);
      assert.equal(calls, 1);
    } finally {
      await engine.close();
    }
  }
  let calls = 0;
  let validations = 0;
  const { engine } = await setup(
    async (flow) => {
      try {
        await flow.agent(agent("invalid"));
      } catch {}
      return flow.checkpoint({ id: "wait", prompt: "?", schema: z.boolean() });
    },
    {
      sessions: {
        validateConfig: async () => {
          validations++;
          throw new FlowError("UNSUPPORTED_REASONING_EFFORT");
        },
        execute: async () => {
          calls++;
          return "unexpected";
        },
      },
    },
  );
  try {
    const run = await engine.start(req());
    await engine.wait(run.id);
    await engine.command(
      run.id,
      "answer",
      { requestId: randomUUID(), output: true },
      "main/wait",
    );
    assert.equal((await engine.wait(run.id)).status, "completed");
    assert.equal(engine.get(run.id).steps[0]!.attempts!.length, 0);
    assert.equal(calls, 0);
    assert.equal(validations, 1);
  } finally {
    await engine.close();
  }
});

test("pre-configuration active records fail closed while completed history stays readable", async () => {
  const first = await setup((flow) => flow.agent(agent("one")));
  const run = await first.engine.start(req());
  await first.engine.wait(run.id);
  await first.engine.close();
  const legacy = {
    ...first.engine.get(run.id),
    agentDefaults: undefined,
    steps: first.engine
      .get(run.id)
      .steps.map((step) => ({ ...step, config: undefined })),
  };
  await first.records.put(run.id, legacy);
  const active = { ...legacy, id: randomUUID(), status: "queued" as const };
  await first.records.put(active.id, active);
  let calls = 0;
  const second = await setup((flow) => flow.agent(agent("one")), {
    table: first.records,
    sessions: {
      execute: async () => {
        calls++;
        return "unexpected";
      },
    },
  });
  try {
    assert.equal(second.engine.get(run.id).status, "completed");
    assert.equal(second.engine.get(active.id).status, "interrupted");
    assert.match(
      second.engine.get(active.id).error!,
      /agent_config_unrecoverable/,
    );
    assert.equal(calls, 0);
  } finally {
    await second.engine.close();
  }
});

test("manual retry adds exactly one attempt budget even when automatic budget remains", async () => {
  let fail = true;
  let calls = 0;
  const { engine } = await setup((flow) => flow.agent(agent("agent", 3)), {
    sessions: {
      execute: async () => {
        calls++;
        if (fail) throw new Error("interrupted after tool");
        return "confirmed";
      },
      reconcile: async () => ({ actionStarted: true }),
    },
  });
  try {
    const run = await engine.start(req());
    assert.equal((await engine.wait(run.id)).status, "needs_attention");
    fail = false;
    const request = { requestId: randomUUID(), action: "retry" };
    await engine.command(run.id, "resolve", request, "main/agent");
    assert.equal((await engine.wait(run.id)).status, "completed");
    await engine.command(run.id, "resolve", request, "main/agent");
    const step = engine.get(run.id).steps[0]!;
    assert.equal(step.retry!.maxAttempts, 3);
    assert.equal(step.extraAttempts, 1);
    assert.equal(step.attempts!.length, 2);
    assert.equal(step.attempts![0]!.status, "unknown");
    assert.equal(calls, 2);
  } finally {
    await engine.close();
  }
});

test("persisted schemas reject executable refinements instead of silently losing validation", () => {
  for (const schema of [
    z.object({ count: z.number().refine((value) => value % 2 === 0) }),
    z.array(z.string().trim()),
    z.string().transform((value) => value.toUpperCase()),
    z.object({ count: z.number() }).superRefine(() => {}),
  ])
    assert.throws(() => savedSchema(schema), /Schema/);
  const schema = savedSchema(z.object({ count: z.number().int().min(2) }));
  assert.deepEqual(validateSaved(schema, { count: 2 }), { count: 2 });
  assert.throws(() => validateSaved(schema, { count: 1 }));
  assert.throws(() => validateSaved(schema, { count: 2.5 }));
});

test("persisted length checks retain native bounds but reject explicit conditional checks", () => {
  // The former guard rejected Zod 4.6's built-in when function. Merely allowing
  // its check names would instead lose explicit, executable conditions.
  for (const schema of [
    z.string().min(1).max(2),
    z
      .array(z.enum(["brass", "stone"]))
      .min(1)
      .max(2),
    z.string().length(2),
    z.array(z.string()).length(2),
  ]) {
    const persisted = JSON.parse(JSON.stringify(savedSchema(schema)));
    const values = [
      "",
      "甲",
      "甲乙",
      "甲乙丙",
      "🌙",
      "🌙🌙",
      [],
      ["brass"],
      ["brass", "stone"],
      ["brass", "stone", "brass"],
    ];
    for (const value of values) {
      if (schema.safeParse(value).success)
        assert.deepEqual(validateSaved(persisted, value), value);
      else assert.throws(() => validateSaved(persisted, value));
    }
  }
  for (const schema of [
    z.string().min(1),
    z.string().max(2),
    z.array(z.string()).length(2),
  ]) {
    // The low-level check definition is also exposed to trusted plugin authors.
    schema._zod.def.checks![0]!._zod.def.when = () => false;
    assert.throws(() => savedSchema(schema), /Schema/);
  }
  assert.throws(
    () => savedSchema(z.string().refine(() => true, { when: () => true })),
    /Schema/,
  );
});

test("text, single and multiple clarification answers survive JSON persistence and engine restart", async () => {
  // Actual checkpoint persistence/replay, rather than only schema conversion:
  // production Wish could previously fail before creating a waiting_input step.
  const answerSchema = z
    .object({
      "garden_geometry.anchors": z.string().min(1).max(2000),
      material: z.enum(["brass", "stone"]),
      details: z
        .array(z.enum(["enamel", "engraving", "light"]))
        .min(1)
        .max(2),
    })
    .strict();
  const workflow = (flow: FlowScope) =>
    flow.checkpoint({
      id: "clarify-1",
      prompt: "请补充制作信息",
      schema: answerSchema,
    });
  const first = await setup(workflow);
  const run = await first.engine.start(req());
  let second: Awaited<ReturnType<typeof setup>> | undefined;
  try {
    const waiting = await first.engine.wait(run.id);
    assert.equal(waiting.status, "waiting_input");
    await first.engine.close();
    const serialized = table();
    await serialized.put(run.id, JSON.parse(JSON.stringify(waiting)));
    second = await setup(workflow, { table: serialized });
    const valid = {
      "garden_geometry.anchors": "桌面锚点已提供",
      material: "brass",
      details: ["enamel", "light"],
    };
    for (const answers of [
      { ...valid, "garden_geometry.anchors": "" },
      { ...valid, "garden_geometry.anchors": "字".repeat(2001) },
      { ...valid, material: "invented" },
      { ...valid, details: [] },
      { ...valid, details: ["enamel", "light", "engraving"] },
      { ...valid, details: ["invented"] },
      { ...valid, unasked: true },
    ]) {
      await assert.rejects(
        second.engine.command(
          run.id,
          "answer",
          { requestId: randomUUID(), output: answers },
          "main/clarify-1",
        ),
      );
      assert.equal(second.engine.get(run.id).status, "waiting_input");
    }
    const answer = { requestId: randomUUID(), output: valid };
    await second.engine.command(run.id, "answer", answer, "main/clarify-1");
    const completed = await second.engine.wait(run.id);
    assert.equal(completed.id, run.id);
    assert.equal(completed.status, "completed");
    assert.deepEqual(completed.output, valid);
    await second.engine.command(run.id, "answer", answer, "main/clarify-1");
    assert.equal(second.engine.get(run.id).steps.length, 1);
  } finally {
    await first.engine.close();
    await second?.engine.close();
  }
});

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
const hash = "a".repeat(64);
const req = () => ({
  requestId: randomUUID(),
  flowId: "test",
  input: {},
  mode: "demo",
});
const agent = (id: string, retry = 1) => ({
  id,
  label: id,
  preset: "test",
  prompt: id,
  retry: { maxAttempts: retry, initialDelayMs: 0 },
});
const action: LoadedAction = {
  id: "write",
  title: "Write",
  description: "test",
  sourceHash: hash,
  inputSchema: {},
  outputSchema: {
    type: "object",
    properties: { done: { type: "boolean" } },
    required: ["done"],
    additionalProperties: false,
  },
  recovery: "manual",
  tool: () => {
    throw new Error("unused");
  },
};
async function setup(
  run: (scope: FlowScope) => unknown,
  options: {
    table?: Table<FlowRun>;
    sessions?: Partial<EngineOptions["sessions"]>;
    action?: LoadedAction;
    executeAction?: NonNullable<EngineOptions["actions"]>["runtime"]["execute"];
    concurrency?: number;
    presets?: string[];
    flow?: Partial<LoadedFlow>;
  } = {},
) {
  const records = options.table ?? table();
  let loaded: LoadedFlow = {
    id: "test",
    title: "Test",
    description: "",
    service: false,
    sourceHash: hash,
    inputSchema: z.object({}),
    outputSchema: z.json(),
    concurrency: options.concurrency ?? 2,
    agentTimeoutMs: 1000,
    capabilities: [],
    run: (ctx) => ctx.sequence({ id: "main" }, run),
    ...options.flow,
  };
  let currentAction = options.action ?? action;
  const engine = new FlowEngine({
    domain: { table: () => records },
    registry: { get: () => loaded, catalog: () => [] },
    refreshFlows: async () => {},
    presets: async () =>
      (options.presets ?? ["test"]).map((id) => ({
        id,
        name: id,
        description: "",
        unavailable: false,
      })),
    sessions: {
      execute: async (step) => step.id,
      history: async (step) => ({
        sessionId: step.sessionId,
        preset: step.preset,
        hasMore: false,
        entries: [],
      }),
      reconcile: async () => ({ actionStarted: false }),
      ...options.sessions,
    },
    actions: {
      registry: {
        snapshot: () => new Map([[currentAction.id, currentAction]]),
        catalog: () => [],
      },
      cwd: process.cwd(),
      runtime: {
        execute: options.executeAction ?? (async () => ({ done: true })),
      },
    },
  });
  await engine.initialize();
  return {
    engine,
    records,
    replaceFlow: (next: Partial<LoadedFlow>) => {
      loaded = { ...loaded, ...next };
    },
    replaceAction: (next: LoadedAction) => {
      currentAction = next;
    },
  };
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition timed out");
    await delay(1);
  }
}

test("memo and completed calls replay once across checkpoint; answer is validated and idempotent", async () => {
  let computations = 0;
  let calls = 0;
  const { engine } = await setup(
    async (flow) => {
      const value = await flow.memo({
        id: "random",
        schema: z.number(),
        compute: () => ++computations,
      });
      const output = await flow.agent(agent("before"));
      const approval = await flow.checkpoint({
        id: "approval",
        prompt: "Approve?",
        schema: z.object({ approved: z.boolean() }),
      });
      return { value, output: output.output, approved: approval.approved };
    },
    {
      sessions: {
        execute: async () => {
          calls++;
          return "saved";
        },
      },
    },
  );
  const started = await engine.start(req());
  assert.equal((await engine.wait(started.id)).status, "waiting_input");
  await assert.rejects(
    engine.command(
      started.id,
      "answer",
      { requestId: randomUUID(), output: { approved: "yes" } },
      "main/approval",
    ),
  );
  const answer = { requestId: randomUUID(), output: { approved: true } };
  await engine.command(started.id, "answer", answer, "main/approval");
  const result = await engine.wait(started.id);
  assert.equal(result.status, "completed");
  assert.deepEqual(result.output, {
    value: 1,
    output: "saved",
    approved: true,
  });
  await engine.command(started.id, "answer", answer, "main/approval");
  await assert.rejects(
    engine.command(
      started.id,
      "answer",
      { ...answer, output: false },
      "main/approval",
    ),
    /不同操作/,
  );
  assert.equal(computations, 1);
  assert.equal(calls, 1);
});

test("pause drains running branch, stops gate waiters, releases capacity and resumes same run", async () => {
  let finish!: () => void;
  const blocked = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const calls: string[] = [];
  const { engine } = await setup(
    async (flow) =>
      flow.parallel({
        id: "batch",
        branches: {
          first: (branch) => branch.agent(agent("one")),
          second: (branch) => branch.agent(agent("two")),
        },
      }),
    {
      concurrency: 1,
      sessions: {
        execute: async (step) => {
          calls.push(step.id);
          if (step.id === "one") await blocked;
          return step.id;
        },
      },
    },
  );
  const run = await engine.start(req());
  await until(() => calls.length === 1);
  assert.equal((await engine.pause(run.id)).status, "pausing");
  finish();
  assert.equal((await engine.wait(run.id)).status, "paused");
  assert.deepEqual(calls, ["one"]);
  await engine.resume(run.id);
  assert.equal((await engine.wait(run.id)).status, "completed");
  assert.deepEqual(calls, ["one", "two"]);
});

test("queue persists overflow and executes FIFO with 32 Run slots; queued pause/cancel dispatch nothing", async () => {
  let releases: Array<() => void> = [];
  const calls: string[] = [];
  const { engine } = await setup(
    async (flow) => (await flow.agent(agent("one"))).output,
    {
      sessions: {
        execute: async (step) => {
          calls.push(step.runId);
          await new Promise<void>((resolve) => releases.push(resolve));
          return "done";
        },
      },
    },
  );
  const runs = [];
  for (let i = 0; i < DEFAULT_TOP_LEVEL_RUN_CONCURRENCY + 3; i++)
    runs.push(await engine.start(req()));
  await until(() => calls.length === DEFAULT_TOP_LEVEL_RUN_CONCURRENCY);
  assert.equal(
    engine.get(runs[DEFAULT_TOP_LEVEL_RUN_CONCURRENCY]!.id).status,
    "queued",
  );
  await engine.pause(runs[DEFAULT_TOP_LEVEL_RUN_CONCURRENCY + 1]!.id);
  await engine.cancel(runs[DEFAULT_TOP_LEVEL_RUN_CONCURRENCY + 2]!.id);
  releases.shift()!();
  await until(() => calls.length === DEFAULT_TOP_LEVEL_RUN_CONCURRENCY + 1);
  assert.deepEqual(
    calls,
    runs.slice(0, DEFAULT_TOP_LEVEL_RUN_CONCURRENCY + 1).map((run) => run.id),
  );
  releases.forEach((release) => release());
  releases = [];
  await Promise.all(
    runs
      .slice(0, DEFAULT_TOP_LEVEL_RUN_CONCURRENCY + 1)
      .map((run) => engine.wait(run.id)),
  );
  assert.equal(
    engine.get(runs[DEFAULT_TOP_LEVEL_RUN_CONCURRENCY + 1]!.id).status,
    "paused",
  );
  assert.equal(
    engine.get(runs[DEFAULT_TOP_LEVEL_RUN_CONCURRENCY + 2]!.id).status,
    "cancelled",
  );
});

test("same local ids are valid in distinct loop scopes; overlapping and forgotten calls are rejected", async () => {
  const valid = await setup(async (flow) => {
    const values = [];
    for (const id of ["one", "two"])
      values.push(
        await flow.sequence({ id }, (item) => item.agent(agent("call"))),
      );
    return values.map((value) => value.output);
  });
  let run = await valid.engine.start(req());
  assert.equal((await valid.engine.wait(run.id)).status, "completed");
  assert.deepEqual(
    valid.engine.get(run.id).steps.map((step) => step.stepKey),
    ["main/one/call", "main/two/call"],
  );
  for (const callback of [
    async (flow: FlowScope) => {
      await Promise.all([flow.agent(agent("a")), flow.agent(agent("b"))]);
      return null;
    },
    async (flow: FlowScope) => {
      void flow.agent(agent("a"));
      return null;
    },
    async (flow: FlowScope) => {
      await flow.agent(agent("a"));
      await flow.agent(agent("a"));
      return null;
    },
  ]) {
    let calls = 0;
    const invalid = await setup(callback, {
      sessions: {
        execute: async () => {
          calls++;
          return "x";
        },
      },
    });
    run = await invalid.engine.start(req());
    assert.equal((await invalid.engine.wait(run.id)).status, "failed");
    assert.match(invalid.engine.get(run.id).error!, /FLOW_SCOPE_ERROR/);
    assert.ok(calls <= 1);
  }
});

test("checkpoint is prohibited in parallel and suspension cannot be swallowed to continue effects", async () => {
  const parallel = await setup((flow) =>
    flow.parallel({
      id: "batch",
      branches: {
        one: (branch) =>
          branch.checkpoint({ id: "wait", prompt: "?", schema: z.boolean() }),
      },
    }),
  );
  const first = await parallel.engine.start(req());
  assert.match((await parallel.engine.wait(first.id)).error!, /parallel 分支/);
  let calls = 0;
  const swallowed = await setup(
    async (flow) => {
      try {
        await flow.checkpoint({ id: "wait", prompt: "?", schema: z.boolean() });
      } catch {}
      try {
        await flow.agent(agent("bad"));
      } catch {}
      return "not completed";
    },
    {
      sessions: {
        execute: async () => {
          calls++;
          return "bad";
        },
      },
    },
  );
  const run = await swallowed.engine.start(req());
  assert.equal((await swallowed.engine.wait(run.id)).status, "waiting_input");
  assert.equal(calls, 0);
});

test("retry attempts are persisted, manual actions reject automatic retry, failures replay into catch", async () => {
  let calls = 0;
  const recovered = await setup(
    async (flow) => {
      let result = "";
      try {
        await flow.agent(agent("failing", 2));
      } catch {
        result = "caught";
      }
      await flow.checkpoint({ id: "wait", prompt: "?", schema: z.boolean() });
      return result;
    },
    {
      sessions: {
        execute: async () => {
          calls++;
          throw new Error("secret");
        },
      },
    },
  );
  const run = await recovered.engine.start(req());
  let state = await recovered.engine.wait(run.id);
  assert.equal(calls, 2);
  assert.equal(state.steps[0]!.attempts!.length, 2);
  assert.doesNotMatch(JSON.stringify(state), /secret/);
  await recovered.engine.command(
    run.id,
    "answer",
    { requestId: randomUUID(), output: true },
    "main/wait",
  );
  state = await recovered.engine.wait(run.id);
  assert.equal(state.output, "caught");
  assert.equal(calls, 2);
  const manual = await setup((flow) =>
    flow.action({
      id: "write",
      action: "write",
      input: {},
      retry: { maxAttempts: 2 },
    }),
  );
  const invalid = await manual.engine.start(req());
  assert.match((await manual.engine.wait(invalid.id)).error!, /idempotent/);
});

test("idempotent retries retain operation key; crash recovery consumes existing retry budget", async () => {
  const keys: string[] = [];
  const { engine } = await setup(
    (flow) =>
      flow.action({
        id: "write",
        action: "write",
        input: {},
        retry: { maxAttempts: 3, initialDelayMs: 0 },
      }),
    {
      action: { ...action, recovery: "idempotent" },
      executeAction: async (_a, _v, binding) => {
        keys.push(binding.idempotencyKey!);
        if (keys.length < 3) throw new Error("retry");
        return { done: true };
      },
    },
  );
  const run = await engine.start(req());
  assert.equal((await engine.wait(run.id)).status, "completed");
  assert.equal(keys.length, 3);
  assert.equal(new Set(keys).size, 1);
});

test("completed durable calls are reused after host restart while queued siblings continue", async () => {
  const calls: string[] = [];
  const workflow = async (flow: FlowScope) => {
    const one = await flow.agent(agent("one"));
    const two = await flow.agent(agent("two", 2));
    return [one.output, two.output];
  };
  const first = await setup(workflow, {
    sessions: {
      execute: async (step) => {
        calls.push(step.id);
        if (step.id === "two")
          await delay(30_000, undefined, { signal: step.signal });
        return step.id;
      },
    },
  });
  const run = await first.engine.start(req());
  await until(() => calls.length === 2);
  await first.engine.close();
  const second = await setup(workflow, {
    table: first.records,
    sessions: {
      execute: async (step) => {
        calls.push(step.id);
        return step.id;
      },
    },
  });
  assert.equal((await second.engine.wait(run.id)).status, "completed");
  assert.deepEqual(calls, ["one", "two", "two"]);
});

test("output-commit failure leaves running attempt, and DSH result is adopted on restart", async () => {
  const records = table();
  let failCommit = true;
  let calls = 0;
  const flaky: Table<FlowRun> = {
    ...records,
    update: (id, change) =>
      records.update(id, (current) => {
        const next = change(current);
        if (
          failCommit &&
          next.steps.some((step) => step.status === "completed")
        )
          throw new Error("disk unavailable");
        return next;
      }),
  };
  const workflow = async (flow: FlowScope) =>
    (await flow.agent(agent("agent", 2))).output;
  const first = await setup(workflow, {
    table: flaky,
    sessions: {
      execute: async () => {
        calls++;
        return "durable DSH output";
      },
    },
  });
  const run = await first.engine.start(req());
  await assert.rejects(first.engine.wait(run.id), /存档失败/);
  assert.equal(records.get(run.id)!.steps[0]!.status, "running");
  await first.engine.close();
  failCommit = false;
  const second = await setup(workflow, {
    table: records,
    sessions: {
      execute: async () => {
        calls++;
        return "duplicate";
      },
      reconcile: async () => ({
        actionStarted: false,
        output: "durable DSH output",
      }),
    },
  });
  assert.equal((await second.engine.wait(run.id)).output, "durable DSH output");
  assert.equal(calls, 1);
});

test("multiple unknown Actions block replay until all are resolved, with schema validation and audit", async () => {
  let calls = 0;
  const workflow = (flow: FlowScope) =>
    flow.parallel({
      id: "batch",
      branches: {
        a: (branch) =>
          branch.action({ id: "write", action: "write", input: {} }),
        b: (branch) =>
          branch.action({ id: "write", action: "write", input: {} }),
      },
    });
  const first = await setup(workflow, {
    executeAction: async (_a, _v, _b, signal) => {
      calls++;
      await delay(30_000, undefined, { signal });
      return { done: true };
    },
  });
  const run = await first.engine.start(req());
  await until(() => calls === 2);
  await first.engine.close();
  const second = await setup(workflow, {
    table: first.records,
    executeAction: async () => {
      calls++;
      return { done: true };
    },
  });
  assert.equal(second.engine.get(run.id).status, "needs_attention");
  const [a, b] = second.engine.get(run.id).steps;
  await assert.rejects(
    second.engine.command(
      run.id,
      "resolve",
      {
        requestId: randomUUID(),
        action: "submit_output",
        output: { done: "bad" },
      },
      a!.stepKey,
    ),
  );
  await second.engine.command(
    run.id,
    "resolve",
    {
      requestId: randomUUID(),
      action: "submit_output",
      output: { done: true },
    },
    a!.stepKey,
  );
  assert.equal(second.engine.get(run.id).status, "needs_attention");
  assert.equal(calls, 2);
  const retry = { requestId: randomUUID(), action: "retry" };
  await second.engine.command(run.id, "resolve", retry, b!.stepKey);
  assert.equal((await second.engine.wait(run.id)).status, "completed");
  await second.engine.command(run.id, "resolve", retry, b!.stepKey);
  assert.equal(calls, 3);
  assert.equal(second.engine.get(run.id).steps[1]!.attempts!.length, 2);
  assert.equal(
    second.engine.get(run.id).steps[0]!.attempts![0]!.status,
    "unknown",
  );
});

test("reconciliation distinguishes known completion, exhausted budget, and any started Agent tool", async () => {
  const step: FlowAgentStep = {
    kind: "agent",
    id: "x",
    label: "X",
    status: "running",
    preset: "test",
    sessionId: randomUUID(),
    requestId: randomUUID(),
    attempts: [{ number: 1, status: "running", startedAt: Date.now() }],
    retry: { maxAttempts: 1 },
  };
  const ports = {
    execute: async () => "",
    history: async () => ({
      sessionId: step.sessionId,
      preset: "test",
      hasMore: false,
      entries: [],
    }),
  };
  assert.equal(
    (
      await recoverStep(step, {
        ...ports,
        reconcile: async () => ({ actionStarted: false }),
      })
    ).status,
    "failed",
  );
  assert.equal(
    (
      await recoverStep(step, {
        ...ports,
        reconcile: async () => ({ actionStarted: true }),
      })
    ).status,
    "unknown",
  );
  assert.equal(
    (
      await recoverStep(step, {
        ...ports,
        reconcile: async () => ({ actionStarted: true, output: "done" }),
      })
    ).status,
    "completed",
  );
});

test("hash changes and replay request mismatches interrupt without executing changed effects", async () => {
  for (const kind of ["flow", "action", "request", "omitted"] as const) {
    let prompt = "same";
    let omit = false;
    let calls = 0;
    const workflow = async (flow: FlowScope) => {
      if (!omit)
        await flow.agent({ ...agent("one"), prompt, actions: ["write"] });
      await flow.checkpoint({ id: "wait", prompt: "?", schema: z.boolean() });
      return null;
    };
    const fixture = await setup(workflow, {
      sessions: {
        execute: async () => {
          calls++;
          return "saved";
        },
      },
    });
    const run = await fixture.engine.start(req());
    await fixture.engine.wait(run.id);
    if (kind === "flow") fixture.replaceFlow({ sourceHash: "b".repeat(64) });
    if (kind === "action")
      fixture.replaceAction({ ...action, sourceHash: "b".repeat(64) });
    if (kind === "request") prompt = "changed";
    if (kind === "omitted") omit = true;
    await fixture.engine.command(
      run.id,
      "answer",
      { requestId: randomUUID(), output: true },
      "main/wait",
    );
    assert.equal(
      (await fixture.engine.wait(run.id)).status,
      "interrupted",
      kind,
    );
    assert.equal(calls, 1);
  }
});

test("resume revision rejection persists an idempotent command receipt", async () => {
  let release: ((value: string) => void) | undefined;
  const fixture = await setup((flow) => flow.agent(agent("one")), {
    sessions: {
      execute: () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    },
  });
  try {
    const run = await fixture.engine.start(req());
    await until(() => Boolean(release));
    await fixture.engine.pause(run.id);
    release!("saved");
    assert.equal((await fixture.engine.wait(run.id)).status, "paused");
    fixture.replaceFlow({ sourceHash: "b".repeat(64) });
    const request = { requestId: randomUUID() };
    assert.equal(
      (await fixture.engine.command(run.id, "resume", request)).status,
      "interrupted",
    );
    assert.equal(
      (await fixture.engine.command(run.id, "resume", request)).status,
      "interrupted",
    );
    assert.equal(
      fixture.engine
        .get(run.id)
        .commands!.filter((item) => item.requestId === request.requestId)
        .length,
      1,
    );
  } finally {
    release?.("cleanup");
    await fixture.engine.close();
  }
});

test("legacy active records fail closed; legacy completed records remain readable", async () => {
  const records = table();
  const base: FlowRun = {
    id: randomUUID(),
    requestId: randomUUID(),
    flow: { id: "test", title: "Old", description: "", sourceHash: hash },
    input: {},
    mode: "demo",
    status: "running",
    createdAt: Date.now(),
    steps: [],
  };
  await records.put(base.id, base);
  const completed = {
    ...base,
    id: randomUUID(),
    status: "completed" as const,
    output: "old result",
  };
  await records.put(completed.id, completed);
  const { engine } = await setup(() => "new", { table: records });
  assert.match(engine.get(base.id).error!, /legacy_unrecoverable/);
  assert.equal(engine.get(completed.id).output, "old result");
});

test("a pre-dispatch storage failure leaves a queued step and never calls the external service", async () => {
  const records = table();
  let fail = true;
  let calls = 0;
  const workflow = async (flow: FlowScope) =>
    (await flow.agent(agent("one"))).output;
  const flaky: Table<FlowRun> = {
    ...records,
    update: (id, change) =>
      records.update(id, (current) => {
        const next = change(current);
        if (fail && next.steps.some((step) => step.status === "running"))
          throw new Error("disk full");
        return next;
      }),
  };
  const first = await setup(workflow, {
    table: flaky,
    sessions: {
      execute: async () => {
        calls++;
        return "done";
      },
    },
  });
  const run = await first.engine.start(req());
  await assert.rejects(first.engine.wait(run.id), /存档失败/);
  assert.equal(calls, 0);
  assert.equal(first.engine.get(run.id).steps[0]!.attempts!.length, 0);
  await first.engine.close();
  fail = false;
  const second = await setup(workflow, {
    table: records,
    sessions: {
      execute: async () => {
        calls++;
        return "done";
      },
    },
  });
  assert.equal((await second.engine.wait(run.id)).status, "completed");
  assert.equal(calls, 1);
});

test("retry backoff is persisted and pause interrupts the wait without spending another attempt", async () => {
  let calls = 0;
  const { engine } = await setup(
    async (flow) =>
      (
        await flow.agent({
          ...agent("retry", 2),
          retry: { maxAttempts: 2, initialDelayMs: 30_000 },
        })
      ).output,
    {
      sessions: {
        execute: async () => {
          calls++;
          throw new Error("retry");
        },
      },
    },
  );
  const run = await engine.start(req());
  await until(() => Boolean(engine.get(run.id).steps[0]?.nextAttemptAt));
  const cutoff = engine.get(run.id).steps[0]!.nextAttemptAt!;
  await engine.pause(run.id);
  assert.equal((await engine.wait(run.id)).status, "paused");
  assert.equal(calls, 1);
  assert.equal(engine.get(run.id).steps[0]!.nextAttemptAt, cutoff);
  await engine.cancel(run.id);
});

test("request idempotency retains original input identity when Zod normalizes it", async () => {
  const fixture = await setup(() => "done");
  fixture.replaceFlow({ inputSchema: z.object({ task: z.string().trim() }) });
  const request = { ...req(), input: { task: "  normalized  " } };
  const run = await fixture.engine.start(request);
  assert.equal((await fixture.engine.start(request)).id, run.id);
  assert.deepEqual(run.input, { task: "normalized" });
});

test("Discovery diagnostics identify old root calls and native concurrency with line numbers", () => {
  assert.throws(
    () =>
      validateFlowSource(
        "export default defineFlow({ async run(ctx) { return ctx.agent({}); } });",
      ),
    /第 1 行.*sequence/,
  );
  assert.throws(
    () =>
      validateFlowSource(
        'export default defineFlow({ async run(ctx) { return ctx.sequence({id:"a"}, async flow => Promise.all([])); } });',
      ),
    /第 1 行.*parallel/,
  );
  assert.doesNotThrow(() =>
    validateFlowSource(
      'export default defineFlow({ async run(ctx) { return ctx.sequence({id:"a"}, ctx => ctx.agent({})); } });',
    ),
  );
});

test("reviewed builtin relocation replays old Action fingerprints and keeps durable identities", async () => {
  let calls = 0;
  const workflow = async (flow: FlowScope) => {
    await flow.action({ id: "before", action: "write", input: {} });
    await flow.checkpoint({
      id: "approve",
      prompt: "Continue?",
      schema: z.boolean(),
    });
    return (await flow.action({ id: "after", action: "write", input: {} }))
      .output;
  };
  const first = await setup(workflow, {
    executeAction: async () => {
      calls++;
      return { done: true };
    },
  });
  const run = await first.engine.start(req());
  assert.equal((await first.engine.wait(run.id)).status, "waiting_input");
  const before = first.engine.get(run.id);
  await first.engine.close();
  const plugin = { id: "relocated", name: "Relocated", version: "1.0.0" };
  const second = await setup(workflow, {
    table: first.records,
    flow: { sourceHash: "b".repeat(64), plugin, legacySourceHashes: [hash] },
    action: {
      ...action,
      sourceHash: "c".repeat(64),
      plugin,
      legacySourceHashes: [hash],
    },
    executeAction: async (definition) => {
      assert.equal(definition.sourceHash, hash);
      assert.equal(definition.plugin, undefined);
      calls++;
      return { done: true };
    },
  });
  try {
    assert.equal(second.engine.get(run.id).status, "waiting_input");
    await second.engine.command(
      run.id,
      "answer",
      { requestId: randomUUID(), output: true },
      "main/approve",
    );
    const finished = await second.engine.wait(run.id);
    assert.equal(finished.status, "completed", finished.error);
    assert.equal(calls, 2, "completed side effects must never replay");
    assert.deepEqual(finished.flow, before.flow);
    assert.deepEqual(finished.actionVersions, before.actionVersions);
    assert.deepEqual(
      finished.steps.map((step) => step.stepKey),
      ["main/before", "main/approve", "main/after"],
    );
  } finally {
    await second.engine.close();
  }
});

test("unreviewed relocation is rejected before a saved checkpoint resumes", async () => {
  const workflow = async (flow: FlowScope) =>
    flow.checkpoint({
      id: "approve",
      prompt: "Continue?",
      schema: z.boolean(),
    });
  const first = await setup(workflow);
  const run = await first.engine.start(req());
  await first.engine.wait(run.id);
  await first.engine.close();
  const second = await setup(workflow, {
    table: first.records,
    flow: {
      sourceHash: "b".repeat(64),
      plugin: { id: "relocated", name: "Relocated", version: "1.0.0" },
      legacySourceHashes: ["c".repeat(64)],
    },
  });
  try {
    await second.engine.command(
      run.id,
      "answer",
      { requestId: randomUUID(), output: true },
      "main/approve",
    );
    assert.equal(second.engine.get(run.id).status, "interrupted");
    assert.match(second.engine.get(run.id).error!, /revision_mismatch/u);
  } finally {
    await second.engine.close();
  }
});
