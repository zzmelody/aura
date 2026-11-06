import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { CodedFlowError, FlowError } from "@aura/protocol/errors";
import { setTimeout as delay } from "node:timers/promises";
import { ConversationExecutions } from "../src/conversations/conversation-executions.ts";
import { ConversationEvents } from "../src/conversations/conversation-events.ts";
import {
  parseConversationCommand,
  type ConversationCommandRecord,
} from "../src/conversations/conversation-commands.ts";
import type { ConversationCommand } from "@aura/protocol/conversation-channel";
import type { Table } from "../src/types.ts";

function storage(): Table<ConversationCommandRecord> {
  const records = new Map<string, ConversationCommandRecord>();
  return {
    get: (id) => records.get(id),
    entries: () => records.entries(),
    async put(id, value) {
      records.set(id, structuredClone(value));
    },
    async delete(id) {
      return records.delete(id);
    },
    async update(id, change) {
      const next = change(records.get(id)!);
      records.set(id, structuredClone(next));
      return next;
    },
  };
}
function start(): Extract<ConversationCommand, { type: "turn.start" }> {
  return {
    commandId: randomUUID(),
    type: "turn.start",
    input: { prompt: "check", mode: "demo" },
  };
}
function fixture(table = storage()) {
  let calls = 0;
  let controls = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ports: ConstructorParameters<typeof ConversationExecutions>[1] = {
    assertSession() {},
    async start(_id, _command, emit, signal) {
      calls++;
      emit({ type: "turn-start", turnId: "turn-0", at: 1 });
      await Promise.race([
        held,
        new Promise<void>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
        }),
      ]);
      emit({ type: "delta", text: "done" });
      return { model: "fixture" };
    },
    async control() {
      controls++;
    },
    async history() {
      return { turns: [], running: false, hasMore: false };
    },
  };
  const service = new ConversationExecutions(table, ports);
  return {
    service,
    table,
    ports,
    release,
    calls: () => calls,
    controls: () => controls,
  };
}
async function settled(
  service: ConversationExecutions,
  command: ConversationCommand,
) {
  for (let i = 0; i < 100; i++) {
    const receipt = service.receipt("one", command.commandId);
    if (
      receipt.status !== "accepted" &&
      !["preparing", "running", "stopping"].includes(
        receipt.execution?.status ?? "",
      )
    )
      return receipt;
    await delay(2);
  }
  throw new Error("fixture did not settle");
}

test("a detached observer leaves one execution running and duplicate admission never invokes it twice", async (t) => {
  const f = fixture();
  t.after(() => f.service.close());
  const command = start();
  const signal = new AbortController();
  const observed = f.service.stream(
    "one",
    command,
    () => undefined,
    signal.signal,
  );
  const detached = assert.rejects(observed);
  await delay(10);
  signal.abort();
  await detached;
  assert.equal(f.service.execution("one")?.status, "running");
  await Promise.all([
    f.service.submit("one", command),
    f.service.submit("one", command),
  ]);
  assert.equal(f.calls(), 1);
  f.release();
  assert.equal(
    (await settled(f.service, command)).execution?.status,
    "complete",
  );
});

test("different commands cannot start concurrently and a reused ID cannot change its content", async (t) => {
  const f = fixture();
  t.after(() => f.service.close());
  const command = start();
  await f.service.submit("one", command);
  await assert.rejects(f.service.submit("one", start()), /还有一项执行/u);
  await assert.rejects(
    f.service.submit("one", {
      ...command,
      input: { ...command.input, prompt: "different" },
    }),
    /不同的内容/u,
  );
  assert.equal(f.calls(), 1);
});

test("a stop targets its original execution and duplicate controls apply once", async (t) => {
  const f = fixture();
  t.after(() => f.service.close());
  const command = start();
  await f.service.submit("one", command);
  const control: ConversationCommand = {
    commandId: randomUUID(),
    type: "turn.steer",
    executionId: command.commandId,
    prompt: "guide",
  };
  await Promise.all([
    f.service.submit("one", control),
    f.service.submit("one", control),
  ]);
  await settled(f.service, control);
  assert.equal(f.controls(), 1);
  const stop: ConversationCommand = {
    commandId: randomUUID(),
    type: "turn.stop",
    executionId: command.commandId,
  };
  await f.service.submit("one", stop);
  await settled(f.service, stop);
  assert.equal(
    (await settled(f.service, command)).execution?.status,
    "stopped",
  );
  const next = start();
  await f.service.submit("one", next);
  await f.service.submit("one", stop);
  await assert.rejects(
    f.service.submit("one", { ...stop, commandId: randomUUID() }),
    /目标执行已结束/u,
  );
  assert.equal(f.service.execution("one")?.id, next.commandId);
});

test("a receipt recovered across a crash is interrupted and never dispatches again", async (t) => {
  const f = fixture();
  t.after(() => f.service.close());
  const command = start();
  await f.service.submit("one", command);
  await delay(5);
  const copy = storage();
  for (const [key, value] of f.table.entries()) await copy.put(key, value);
  const restored = new ConversationExecutions(copy, f.ports);
  t.after(() => restored.close());
  const receipt = await restored.submit("one", command);
  assert.equal(receipt.execution?.status, "interrupted");
  assert.deepEqual(receipt.execution?.errorDetails, {
    code: "conversation_host_restarted",
  });
  assert.equal(
    JSON.stringify([...copy.entries()]).includes("errorDetails"),
    false,
  );
  assert.equal(f.calls(), 1);
  assert.equal((await restored.snapshot("one")).running, false);
});

test("snapshot retries when events change during history capture and returns the matching cursor", async (t) => {
  const f = fixture();
  t.after(() => f.service.close());
  let reads = 0;
  f.ports.history = async () => {
    if (++reads === 1)
      f.service.events.publish("one", {
        type: "activity",
        activity: { type: "delta", text: "new" },
      });
    return { turns: [], running: false, hasMore: false };
  };
  const snapshot = await f.service.snapshot("one");
  assert.equal(reads, 2);
  assert.equal(snapshot.cursor, f.service.events.cursor("one"));
  f.service.events.publish("one", {
    type: "activity",
    activity: { type: "delta", text: "later" },
  });
  assert.equal(f.service.events.read("one", snapshot.cursor).events.length, 1);
});

test("bounded event windows reset expired and foreign cursors without retaining oversized output", () => {
  const events = new ConversationEvents(1024, 2);
  const first = events.cursor("one");
  for (let i = 0; i < 3; i++)
    events.publish("one", {
      type: "activity",
      activity: { type: "delta", text: String(i) },
    });
  assert.equal(events.read("one", first).reset, true);
  const current = events.cursor("one");
  assert.deepEqual(events.read("one", current).events, []);
  assert.equal(events.read("two", current).reset, true);
  events.publish("one", {
    type: "activity",
    activity: { type: "delta", text: "x".repeat(2000) },
  });
  assert.equal(events.read("one", current).reset, true);
});

test("commands reject injected provider configuration and missing execution targets", () => {
  assert.throws(
    () =>
      parseConversationCommand({
        ...start(),
        input: { prompt: "check", mode: "custom", apiKey: "fixture-private" },
      }),
    /无效/u,
  );
  assert.throws(
    () =>
      parseConversationCommand({ commandId: randomUUID(), type: "turn.stop" }),
    /无效/u,
  );
  assert.throws(
    () =>
      parseConversationCommand({
        ...start(),
        input: { prompt: "", mode: "demo" },
      }),
    /不能为空/u,
  );
});

test("runtime notices survive replay eviction and stay on their original turn", async (t) => {
  const f = fixture();
  t.after(() => f.service.close());
  f.ports.history = async () => ({
    turns: ["turn-0", "turn-1"].map((turnId) => ({
      turnId,
      prompt: "check",
      startedAt: 1,
      status: "complete",
      events: [],
    })),
    running: false,
    hasMore: false,
  });
  f.service.events.publish(
    "one",
    {
      type: "activity",
      activity: { type: "notice", id: "notice", text: "check", at: 1 },
    },
    "execution",
  );
  f.service.events.bindTurn("one", "execution", "turn-0");
  for (let i = 0; i < 300; i++)
    f.service.events.publish("one", {
      type: "activity",
      activity: { type: "delta", text: "later" },
    });
  const snapshot = await f.service.snapshot("one");
  assert.equal(snapshot.turns[0]?.events[0]?.type, "notice");
  assert.deepEqual(snapshot.turns[1]?.events, []);
});

test("failed admission storage never starts a model request", async (t) => {
  const table = storage();
  table.put = async () => {
    throw new Error("disk unavailable");
  };
  const f = fixture(table);
  t.after(() => f.service.close());
  await assert.rejects(f.service.submit("one", start()), /尚未启动/u);
  assert.equal(f.calls(), 0);
});

test("completion remains active until its receipt is saved and the next turn can be admitted", async (t) => {
  const table = storage();
  const put = table.put;
  let saving!: () => void;
  let finishSave!: () => void;
  const savingDone = new Promise<void>((resolve) => {
    saving = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    finishSave = resolve;
  });
  table.put = async (id, value) => {
    if (value.receipt.execution?.status === "complete") {
      saving();
      await gate;
    }
    await put(id, value);
  };
  const f = fixture(table);
  t.after(async () => {
    finishSave();
    await f.service.close();
  });
  const command = start();
  await f.service.submit("one", command);
  f.release();
  await savingDone;
  assert.equal(
    f.service.receipt("one", command.commandId).execution?.status,
    "running",
  );
  assert.equal(
    (await f.service.submit("one", command)).execution?.status,
    "running",
  );
  assert.equal((await f.service.snapshot("one")).running, true);
  const stopping = f.service.stop("one");
  finishSave();
  await stopping;
  assert.equal(
    (await settled(f.service, command)).execution?.status,
    "complete",
  );
  const next = start();
  assert.equal((await f.service.submit("one", next)).status, "accepted");
});

test("live failures carry bounded translation metadata through receipts, events and legacy streams without changing durable records", async (t) => {
  const f = fixture();
  t.after(() => f.service.close());
  let calls = 0;
  const failure = new CodedFlowError("对话来源不匹配。", 409, {
    code: "conversation_source_mismatch",
  });
  Object.assign(failure.details, { params: { token: "private" } });
  failure.cause = new Error("private upstream response");
  f.ports.start = async (_id, _command, emit) => {
    calls++;
    emit({ type: "turn-start", turnId: "failed-turn", at: 1 });
    throw failure;
  };
  const history = {
    turns: [
      {
        turnId: "failed-turn",
        prompt: "original",
        startedAt: 1,
        status: "error" as const,
        error: failure.message,
        events: [],
      },
    ],
    running: false,
    hasMore: false,
  };
  f.ports.history = async () => history;
  const originalHistory = JSON.stringify(history);
  const command = start();
  const cursor = f.service.events.cursor("one");
  await f.service.submit("one", command);
  const receipt = await settled(f.service, command);
  const details = { code: "conversation_source_mismatch" };
  assert.deepEqual(receipt.execution?.errorDetails, details);
  assert.equal(receipt.execution?.error, failure.message);
  assert.equal(receipt.execution?.errorStatus, 409);
  assert.deepEqual(
    (await f.service.snapshot("one")).execution?.errorDetails,
    details,
  );
  assert.deepEqual(
    (await f.service.snapshot("one")).turns[0]?.errorDetails,
    details,
  );
  assert.equal(JSON.stringify(history), originalHistory);
  const events = f.service.events.read("one", cursor).events;
  const ended = events
    .filter((event) => event.payload.type === "execution")
    .at(-1);
  assert.ok(ended?.payload.type === "execution");
  assert.deepEqual(ended.payload.execution.errorDetails, details);
  await assert.rejects(
    f.service.stream(
      "one",
      command,
      () => undefined,
      new AbortController().signal,
    ),
    (error) => {
      assert.ok(error instanceof CodedFlowError);
      assert.equal(error.status, 409);
      assert.equal(error.message, failure.message);
      assert.deepEqual(error.details, details);
      return true;
    },
  );
  assert.equal(
    calls,
    1,
    "observing or resubmitting the same command does not execute again",
  );
  const serialized = JSON.stringify([...f.table.entries()]);
  assert.equal(serialized.includes("errorDetails"), false);
  assert.equal(serialized.includes("conversation_source_mismatch"), false);
  assert.equal(serialized.includes("private"), false);
  const restored = new ConversationExecutions(f.table, f.ports);
  t.after(() => restored.close());
  const legacy = restored.receipt("one", command.commandId);
  assert.equal(legacy.execution?.error, failure.message);
  assert.equal(legacy.execution?.errorDetails, undefined);
  assert.equal(
    (await restored.snapshot("one")).turns[0]?.errorDetails,
    undefined,
  );
  assert.equal(JSON.stringify([...f.table.entries()]), serialized);
});

test("uncertain persistence and rejected controls retain safe feedback without an automatic retry", async (t) => {
  const table = storage();
  const put = table.put;
  table.put = async (key, value) => {
    if (value.receipt.execution?.status === "error")
      throw new Error("private disk error");
    await put(key, value);
  };
  const f = fixture(table);
  t.after(() => f.service.close());
  let calls = 0;
  f.ports.start = async () => {
    calls++;
    throw new Error("private provider response");
  };
  const command = start();
  await f.service.submit("one", command);
  const receipt = await settled(f.service, command);
  assert.equal(receipt.status, "uncertain");
  assert.deepEqual(receipt.errorDetails, {
    code: "conversation_result_unsaved",
  });
  assert.deepEqual(receipt.execution?.errorDetails, {
    code: "conversation_operation_failed",
  });
  assert.equal(JSON.stringify(receipt).includes("private"), false);
  await f.service.submit("one", command);
  assert.equal(calls, 1);
  assert.equal(
    JSON.stringify([...table.entries()]).includes("errorDetails"),
    false,
  );

  const controls = fixture();
  t.after(() => controls.service.close());
  const active = start();
  await controls.service.submit("one", active);
  controls.ports.control = async () => {
    throw new CodedFlowError("这个问题已经结束或不存在。", 404, {
      code: "question_closed",
    });
  };
  const steer = {
    commandId: randomUUID(),
    type: "turn.steer" as const,
    executionId: active.commandId,
    prompt: "original",
  };
  await controls.service.submit("one", steer);
  assert.deepEqual((await settled(controls.service, steer)).errorDetails, {
    code: "question_closed",
  });
  controls.ports.control = async () => {
    throw new FlowError("external original message", 409);
  };
  const legacy = { ...steer, commandId: randomUUID() };
  await controls.service.submit("one", legacy);
  const legacyReceipt = await settled(controls.service, legacy);
  assert.equal(legacyReceipt.error, "external original message");
  assert.equal(legacyReceipt.errorDetails, undefined);
});
