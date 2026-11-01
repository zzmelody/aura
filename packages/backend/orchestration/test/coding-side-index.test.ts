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

test("multiple sides keep independent identities and models across index reloads", async () => {
  const table = memoryTable();
  let index = new CodingConversationIndex(table);
  await index.open("main-a", "project", "A");
  await index.open("main-b", "project", "B");
  const sideA = await index.openSide("main-a");
  const sideB = await index.openSide("main-b");
  assert.notEqual(sideA, sideB);
  const sibling = await index.openSide("main-a");
  assert.notEqual(sibling, sideA);
  await index.nameSide(sideA, "第一条思路\n继续讨论");
  await index.nameSide(sideA, "后续问题不覆盖标题");
  assert.equal(
    index.list("project").find((item) => item.id === "main-a")
      ?.sideConversations?.[0]?.title,
    "第一条思路 继续讨论",
  );
  await index.selectModel(sideA, "demo", { model: "first" });
  await index.selectModel(sibling, "demo", { model: "second" });
  // Recreate the consumer, retaining only the serialized storage records.
  const restored = memoryTable();
  for (const [id, record] of table.entries())
    await restored.put(
      id,
      JSON.parse(JSON.stringify(record)) as CodingConversationRecord,
    );
  index = new CodingConversationIndex(restored);
  assert.deepEqual(
    index
      .list("project")
      .find((item) => item.id === "main-a")
      ?.sideConversations?.map((item) => item.id),
    [sideA, sibling],
  );
  assert.deepEqual(index.modelConfig(sideA), { demo: { model: "first" } });
  assert.deepEqual(index.modelConfig(sibling), { demo: { model: "second" } });
  assert.equal(index.sideParent(sideB)?.id, "main-b");
  assert.equal(
    index.list("project").length,
    2,
    "sides are never listed as main chats",
  );
  await index.touch("main-a");
  assert.equal(index.get("main-a")?.sideSessionId, sideA);
  await index.closeSide(sideA);
  assert.equal(index.sideParent(sibling)?.id, "main-a");
  assert.deepEqual(index.modelConfig(sibling), { demo: { model: "second" } });
});

test("legacy single-side records remain readable without rewriting storage", async () => {
  const table = memoryTable();
  const record: CodingConversationRecord = {
    id: "main",
    projectId: "project",
    title: "Main",
    createdAt: 1,
    updatedAt: 1,
    sideSessionId: "side-legacy",
    sideModelConfig: { demo: { model: "saved" } },
  };
  await table.put(record.id, record);
  const index = new CodingConversationIndex(table);
  assert.equal(index.sideParent("side-legacy")?.id, "main");
  assert.deepEqual(index.modelConfig("side-legacy"), record.sideModelConfig);
  assert.deepEqual(table.get("main"), record);
  const sibling = await index.openSide("main");
  assert.equal(index.sideParent("side-legacy")?.id, "main");
  assert.equal(index.sideParent(sibling)?.id, "main");
  await index.closeSide(sibling);
  assert.deepEqual(index.modelConfig("side-legacy"), record.sideModelConfig);
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
  await assert.rejects(index.selectModel(old, "demo", { model: "closed" }));
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
  const archivedSibling = await index.openSide("archived");
  const closedSide = await index.openSide("closed");
  await index.archive("archived", true);
  await index.close("closed");
  index = new CodingConversationIndex(table);
  assert.equal(index.sideParent(archivedSide), undefined);
  assert.equal(index.sideParent(archivedSibling), undefined);
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
