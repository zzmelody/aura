import assert from "node:assert/strict";
import test from "node:test";
import {
  CodingConversationIndex,
  type CodingConversationRecord,
} from "../src/coding/index-record.ts";
import type { Table } from "../src/types.ts";

function memoryTable(): Table<CodingConversationRecord> {
  const records = new Map<string, CodingConversationRecord>();
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
      const current = records.get(id);
      assert.ok(current);
      const next = change(structuredClone(current));
      records.set(id, next);
      return structuredClone(next);
    },
  };
}

test("empty side panels have stable per-parent identities across index reloads", async () => {
  const table = memoryTable();
  let index = new CodingConversationIndex(table);
  await index.open("main-a", "project", "A");
  await index.open("main-b", "project", "B");
  const sideA = await index.openSide("main-a");
  const sideB = await index.openSide("main-b");
  assert.notEqual(sideA, sideB);
  assert.equal(await index.openSide("main-a"), sideA);
  // Recreate the consumer, retaining only the serialized storage records.
  const restored = memoryTable();
  for (const [id, record] of table.entries())
    await restored.put(
      id,
      JSON.parse(JSON.stringify(record)) as CodingConversationRecord,
    );
  index = new CodingConversationIndex(restored);
  assert.equal(await index.openSide("main-a"), sideA);
  assert.equal(index.sideParent(sideB)?.id, "main-b");
  assert.equal(
    index.list("project").length,
    2,
    "sides are never listed as main chats",
  );
  await index.touch("main-a");
  assert.equal(index.get("main-a")?.sideSessionId, sideA);
});

test("explicit close clears only the requested side and a later open starts fresh", async () => {
  const index = new CodingConversationIndex(memoryTable());
  await index.open("main", "project", "Main");
  const old = await index.openSide("main");
  assert.equal(await index.closeSide(old), true);
  assert.equal(await index.closeSide(old), false);
  const next = await index.openSide("main");
  assert.notEqual(next, old);
  assert.equal(
    await index.closeSide(old),
    false,
    "a delayed close cannot close its replacement",
  );
  assert.equal(index.get("main")?.sideSessionId, next);
  assert.equal(index.sideParent(old), undefined);
  await assert.rejects(
    index.open(old, "project", "do not adopt a side as a main"),
  );
});

test("archive and close clear sides, and restoring a parent never restores a side", async () => {
  const table = memoryTable();
  let index = new CodingConversationIndex(table);
  await index.open("archived", "project", "Archived");
  await index.open("closed", "project", "Closed");
  const archivedSide = await index.openSide("archived");
  const closedSide = await index.openSide("closed");
  await index.archive("archived", true);
  await index.close("closed");
  index = new CodingConversationIndex(table);
  assert.equal(index.sideParent(archivedSide), undefined);
  assert.equal(index.sideParent(closedSide), undefined);
  assert.equal(index.get("closed"), undefined);
  assert.deepEqual(
    index.list("project").map((item) => item.id),
    ["archived"],
  );
  assert.ok(index.get("archived")?.archivedAt);
  await assert.rejects(index.openSide("archived"));
  await assert.rejects(index.openSide("closed"));
  await assert.rejects(index.open("closed", "project", "late request"));
  await assert.rejects(index.open("archived", "project", "late request"));
  await index.archive("archived", false);
  assert.equal(index.get("archived")?.sideSessionId, undefined);
  assert.equal(index.get("archived")?.archivedAt, undefined);
  assert.notEqual(await index.openSide("archived"), archivedSide);
});
