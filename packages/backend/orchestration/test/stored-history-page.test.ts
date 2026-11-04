import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { storedHistoryPage } from "../src/coding/stored-history-page.ts";

// Projection fixtures only; native log validation is covered by the DSH integration.
const events = (count: number) =>
  Array.from({ length: count }, () => [
    { type: "turn/start", data: {} },
    { type: "user/message", data: {} },
    { type: "assistant/message", data: {} },
    { type: "turn/end", data: {} },
  ])
    .flat()
    .map((event, seq) => ({
      ...event,
      seq,
      time: seq,
    })) as unknown as SessionEvent[];

test("cold history windows preserve complete turns and a stable cursor across pages", () => {
  const source = events(25);
  const last = storedHistoryPage(source, 0, {})!;
  assert.equal(last.beforeSeq, 60);
  assert.equal(last.throughSeq, 99);
  assert.equal(last.hasMore, true);
  const middle = storedHistoryPage(source, 0, last)!;
  const first = storedHistoryPage(source, 0, middle)!;
  assert.equal(first.hasMore, false);
  assert.deepEqual(
    [first, middle, last].flatMap((page) => page.events),
    source.map(({ type, seq, time, data }) => ({ type, seq, time, data })),
  );
});

test("cold history never replays a fork's inherited context as child messages", () => {
  const last = storedHistoryPage(events(25), 40, {})!;
  const first = storedHistoryPage(events(25), 40, last)!;
  assert.equal(first.beforeSeq, 40);
  assert.equal(first.hasMore, false);
  assert.equal(first.events.length + last.events.length, 60);
});

test("unfinished logs and unfinished historical cuts defer to the live host", () => {
  assert.equal(storedHistoryPage(events(2).slice(0, -1), 0, {}), undefined);
  assert.equal(
    storedHistoryPage(events(2), 0, { beforeSeq: 8, throughSeq: 6 }),
    undefined,
  );
});

test("invalid cold history cursors are rejected instead of inventing a cut", () => {
  for (const cursor of [
    { beforeSeq: 1 },
    { beforeSeq: 3, throughSeq: 999 },
    { beforeSeq: -1, throughSeq: 3 },
  ])
    assert.throws(
      () => storedHistoryPage(events(1), 0, cursor),
      /无效的历史分页游标/u,
    );
});

test("an empty child log does not claim it has earlier child turns", () => {
  const page = storedHistoryPage(events(2), 8, {})!;
  assert.equal(page.events.length, 0);
  assert.equal(page.hasMore, false);
  assert.equal(page.beforeSeq, undefined);
});
