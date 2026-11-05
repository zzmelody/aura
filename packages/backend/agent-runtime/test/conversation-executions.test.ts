import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
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
