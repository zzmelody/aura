import assert from "node:assert/strict";
import { test } from "node:test";
import type { OrchestrationHost } from "../src/dsh/host.ts";
import { createCodingApp } from "../src/coding-routes.ts";

test("history paging validates paired safe integer cursors before forwarding", async () => {
  const calls: unknown[][] = [];
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
  assert.deepEqual(
    calls.map((args) => args.slice(0, 2)),
    [["coding-1", { page: true, beforeSeq: 12, throughSeq: 45 }]],
  );
});

test("history reads propagate request cancellation and preserve stable page cursors", async () => {
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  type Result = {
    turns: never[];
    running: boolean;
    hasMore: boolean;
  };
  let finish!: (value: Result) => void;
  const result = new Promise<Result>((resolve) => {
    finish = resolve;
  });
  let received: AbortSignal | undefined;
  const app = createCodingApp({
    codingHistory: async (id: string, cursor: unknown, signal: AbortSignal) => {
      assert.equal(id, "coding-fixture");
      assert.deepEqual(cursor, { page: true, beforeSeq: 20, throughSeq: 40 });
      received = signal;
      enter();
      return result;
    },
  } as unknown as OrchestrationHost);
  const abort = new AbortController();
  const request = app.request(
    new Request(
      "http://fixture/sessions/coding-fixture/history?page=1&beforeSeq=20&throughSeq=40",
      { signal: abort.signal },
    ),
  );
  await entered;
  abort.abort();
  assert.equal(received?.aborted, true);
  finish({ turns: [], running: false, hasMore: false });
  assert.equal((await request).status, 200);
});
