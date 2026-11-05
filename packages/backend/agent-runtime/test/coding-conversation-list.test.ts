import assert from "node:assert/strict";
import { test } from "node:test";
import type { CodingConversationInfo } from "@aura/protocol/types";
import { conversationList } from "../src/conversations/conversation-list.ts";

const records: CodingConversationInfo[] = [
  {
    id: "idle",
    projectId: "workspace",
    title: "Saved task",
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: "active",
    projectId: "workspace",
    title: "Active task",
    createdAt: 1,
    updatedAt: 2,
  },
];

test("startup metadata lists return records and live waits without opening session logs", async () => {
  let reads = 0;
  const result = await conversationList(records, {
    includeStatus: false,
    running: (id) => id === "active",
    waitingForAnswer: () => true,
    readStatus: async () => {
      reads++;
      throw new Error("Fixture history unavailable");
    },
  });
  assert.equal(reads, 0);
  assert.equal(result[0], records[0]);
  assert.equal(result[1]!.title, "Active task");
  assert.equal(result[1]!.lastTurnStatus, "running");
  assert.equal(result[1]!.waitingForAnswer, true);
  assert.equal(records[1]!.lastTurnStatus, undefined);
});

test("background status enrichment reads idle logs while live execution remains authoritative", async () => {
  const read: string[] = [];
  const result = await conversationList(records, {
    includeStatus: true,
    running: (id) => id === "active",
    waitingForAnswer: () => false,
    readStatus: async (id) => {
      read.push(id);
      return "complete";
    },
  });
  assert.deepEqual(read, ["idle"]);
  assert.equal(result[0]!.lastTurnStatus, "complete");
  assert.equal(result[1]!.lastTurnStatus, "running");
});

test("a running side chat keeps its parent conversation running", async () => {
  const parent: CodingConversationInfo = {
    ...records[0]!,
    sideConversations: [{ id: "side", title: "Side", createdAt: 1 }],
  };
  const result = await conversationList([parent], {
    includeStatus: true,
    running: (id) => id === "side",
    waitingForAnswer: (id) => id === "side",
    readStatus: async () => "complete",
  });
  assert.equal(result[0]!.lastTurnStatus, "running");
  assert.equal(result[0]!.waitingForAnswer, true);
  const archived = await conversationList([{ ...parent, archivedAt: 2 }], {
    includeStatus: true,
    running: (id) => id === "side",
    waitingForAnswer: () => false,
    readStatus: async () => "complete",
  });
  assert.equal(archived[0]!.lastTurnStatus, "complete");
});

test("an old open turn becomes stopped and an unreadable log cannot hide the record", async () => {
  const result = await conversationList(records, {
    includeStatus: true,
    running: () => false,
    waitingForAnswer: () => false,
    readStatus: async (id) => {
      if (id === "idle") return "running";
      throw new Error("Fixture unavailable");
    },
  });
  assert.equal(result[0]!.lastTurnStatus, "stopped");
  assert.equal(result[1], records[1]);
});
