import assert from "node:assert/strict";
import { test } from "node:test";
import type { OrchestrationHost } from "@aura/orchestration";
import { createCodingApp } from "../src/coding-routes.ts";

test("history paging validates paired safe integer cursors before forwarding", async () => {
  const calls: unknown[] = [];
  const app = createCodingApp({
    codingHistory: async (...args: unknown[]) => {
      calls.push(args);
      return { turns: [], running: false, hasMore: false };
    },
  } as unknown as OrchestrationHost);
  for (const query of [
    "beforeSeq=1",
    "throughSeq=2",
    "beforeSeq=-1&throughSeq=2",
    "beforeSeq=1.5&throughSeq=2",
    "beforeSeq=1&throughSeq=9007199254740992",
  ])
    assert.equal(
      (await app.request(`/sessions/coding-1/history?page=1&${query}`)).status,
      400,
    );
  assert.equal(calls.length, 0);
  assert.equal(
    (
      await app.request(
        "/sessions/coding-1/history?page=1&beforeSeq=12&throughSeq=45",
      )
    ).status,
    200,
  );
  assert.deepEqual(calls, [
    ["coding-1", { page: true, beforeSeq: 12, throughSeq: 45 }],
  ]);
});
