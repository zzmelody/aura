import assert from "node:assert/strict";
import { test } from "node:test";
import { PERSONAL_ASSISTANT_SESSION_ID } from "@aura/protocol/conversations";
import {
  CodingConversationIndex,
  type CodingConversationRecord,
} from "../src/coding/index-record.ts";
import type { Table } from "../src/types.ts";

function fixture() {
  const records = new Map<string, CodingConversationRecord>();
  let writes = 0;
  const table: Table<CodingConversationRecord> = {
    get: (id) => records.get(id),
    entries: () => records.entries(),
    async put(id, value) {
      writes++;
      await Promise.resolve();
      records.set(id, structuredClone(value));
    },
    async delete(id) {
      return records.delete(id);
    },
    async update(id, change) {
      const current = records.get(id);
      assert.ok(current);
      const next = change(structuredClone(current));
      records.set(id, next);
      return structuredClone(next);
    },
  };
  return { table, records, writes: () => writes };
}

test("reading an absent personal assistant does not create or rewrite a conversation", () => {
  const state = fixture();
  assert.equal(
    new CodingConversationIndex(state.table).getAssistant(),
    undefined,
  );
  assert.equal(state.writes(), 0);
  assert.equal(state.records.size, 0);
});

test("concurrent opens create exactly one assistant and retain its original workspace", async () => {
  const state = fixture();
  const index = new CodingConversationIndex(state.table);
  const opened = await Promise.all(
    Array.from({ length: 20 }, () => index.openAssistant("default")),
  );
  assert.deepEqual(
    new Set(opened.map((item) => item.id)),
    new Set([PERSONAL_ASSISTANT_SESSION_ID]),
  );
  assert.equal(state.writes(), 1);
  assert.equal(state.records.size, 1);
  const original = structuredClone(
    state.records.get(PERSONAL_ASSISTANT_SESSION_ID),
  );
  assert.equal(
    (await index.openAssistant("different-default")).projectId,
    "default",
  );
  assert.deepEqual(state.records.get(PERSONAL_ASSISTANT_SESSION_ID), original);
});

test("assistant metadata survives index reconstruction and ordinary tasks stay independent", async () => {
  const state = fixture();
  const index = new CodingConversationIndex(state.table);
  await index.openAssistant("default");
  await index.selectModel(PERSONAL_ASSISTANT_SESSION_ID, "demo", {
    model: "fixture",
  });
  await index.open("coding-task", "default", "独立任务");
  const reloaded = new CodingConversationIndex(state.table);
  assert.equal(reloaded.getAssistant()?.id, PERSONAL_ASSISTANT_SESSION_ID);
  assert.deepEqual(reloaded.getAssistant()?.modelConfig, {
    demo: { model: "fixture" },
  });
  assert.equal(reloaded.list("default").length, 2);
  assert.equal(reloaded.get("coding-task")?.title, "独立任务");
});

test("a failed assistant creation leaves no record and a later explicit open can retry", async () => {
  const state = fixture();
  const put = state.table.put;
  let fail = true;
  state.table.put = async (id, value) => {
    if (fail) throw new Error("Fixture storage unavailable");
    return put(id, value);
  };
  const index = new CodingConversationIndex(state.table);
  await assert.rejects(index.openAssistant("default"), /storage unavailable/u);
  assert.equal(index.getAssistant(), undefined);
  assert.equal(state.records.size, 0);
  fail = false;
  assert.equal(
    (await index.openAssistant("default")).id,
    PERSONAL_ASSISTANT_SESSION_ID,
  );
  assert.equal(state.records.size, 1);
});

test("the fixed assistant cannot be archived or deleted through ordinary task controls", async () => {
  const state = fixture();
  const index = new CodingConversationIndex(state.table);
  await index.openAssistant("default");
  await assert.rejects(
    index.archive(PERSONAL_ASSISTANT_SESSION_ID, true),
    /不能归档/u,
  );
  await assert.rejects(index.close(PERSONAL_ASSISTANT_SESSION_ID), /不能关闭/u);
  await assert.rejects(
    index.remove(PERSONAL_ASSISTANT_SESSION_ID),
    /不能删除/u,
  );
  assert.equal(state.records.size, 1);
  assert.equal(index.getAssistant()?.archivedAt, undefined);
  await index.open("task", "default", "Task");
  await index.archive("task", true);
  assert.ok(index.get("task")?.archivedAt);
});
