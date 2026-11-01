import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionId } from "@deepseek-ai/dsh-session";
import { historyTurns, readSessionEventPage } from "../src/coding/history.ts";

test("history pages retain complete turns and a stable cut without walking the whole log", async () => {
  const records = Array.from({ length: 3 }, (_, turn) => [
    { type: "turn/start", data: {} },
    {
      type: "user/message",
      data: {
        source: { kind: "user" },
        content: [{ type: "text", text: `prompt-${turn}` }],
      },
    },
    {
      type: "assistant/message",
      data: { message: { content: [{ type: "text", text: `reply-${turn}` }] } },
    },
    { type: "turn/end", data: { reason: { kind: "completed" } } },
  ])
    .flat()
    .map((event, seq) => ({
      type: "event" as const,
      event: { ...event, seq, time: seq },
    }));
  let reads = 0;
  let closed = false;
  const controller = {
    follow() {
      return {
        async *[Symbol.asyncIterator]() {
          try {
            yield {
              type: "snapshot",
              records: records.slice(5),
              cursor: 11,
              hasMore: true,
            };
          } finally {
            closed = true;
          }
        },
      };
    },
    async page(request: { throughSeq: number; beforeSeq: number }) {
      reads++;
      assert.equal(request.throughSeq, 11);
      const selected = records
        .filter((record) => record.event.seq < request.beforeSeq)
        .slice(-5);
      return { records: selected, hasMore: selected[0]?.event.seq !== 0 };
    },
  } as unknown as Parameters<typeof readSessionEventPage>[0];
  const signal = new AbortController().signal;
  const latest = await readSessionEventPage(
    controller,
    SessionId("coding-page"),
    signal,
  );
  assert.equal(reads, 0);
  assert.equal(closed, true);
  assert.equal(latest.beforeSeq, 8);
  assert.equal(latest.hasMore, true);
  const middle = await readSessionEventPage(
    controller,
    SessionId("coding-page"),
    signal,
    latest,
  );
  const first = await readSessionEventPage(
    controller,
    SessionId("coding-page"),
    signal,
    middle,
  );
  assert.equal(reads, 2);
  assert.equal(first.hasMore, false);
  assert.deepEqual(
    [first, middle, latest].flatMap((page) =>
      historyTurns(page.events, false).map((turn) => turn.prompt),
    ),
    ["prompt-0", "prompt-1", "prompt-2"],
  );
  const own = await readSessionEventPage(
    controller,
    SessionId("coding-page"),
    signal,
    { minimumSeq: 8 },
  );
  assert.equal(own.hasMore, false);
  assert.deepEqual(
    historyTurns(own.events, false).map((turn) => turn.prompt),
    ["prompt-2"],
  );
});
