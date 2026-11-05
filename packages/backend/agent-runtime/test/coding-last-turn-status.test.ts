import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionId } from "@deepseek-ai/dsh-session";
import { lastTurnStatus } from "../src/conversations/history.ts";

type Event = { type: string; data?: unknown };

/** A session controller whose log is one snapshot page of the given events. */
function controller(events: Event[] | "missing") {
  return {
    follow() {
      return {
        async *[Symbol.asyncIterator]() {
          if (events === "missing")
            throw Object.assign(new Error("not found"), {
              code: "session/not-found",
            });
          yield {
            type: "snapshot" as const,
            hasMore: false,
            cursor: events.length,
            records: events.map((event, seq) => ({
              type: "event" as const,
              event: { ...event, seq, time: seq, data: event.data ?? {} },
            })),
          };
        },
      };
    },
    page() {
      throw new Error("a single page is enough");
    },
  } as unknown as Parameters<typeof lastTurnStatus>[0];
}

const status = (events: Event[] | "missing") =>
  lastTurnStatus(
    controller(events),
    SessionId("coding-1"),
    AbortSignal.timeout(1000),
  );

test("the last turn's end reason decides the status", async () => {
  const ended = (kind: string): Event[] => [
    { type: "turn/start" },
    { type: "turn/end", data: { reason: { kind } } },
  ];
  assert.equal(await status(ended("completed")), "complete");
  assert.equal(await status(ended("aborted")), "stopped");
  assert.equal(await status(ended("error")), "error");
  assert.equal(await status(ended("blocked")), "error");
});

test("only the latest turn counts", async () => {
  assert.equal(
    await status([
      { type: "turn/start" },
      { type: "turn/end", data: { reason: { kind: "error" } } },
      { type: "turn/start" },
      { type: "turn/end", data: { reason: { kind: "completed" } } },
    ]),
    "complete",
  );
});

test("a turn with no end yet reads as running", async () => {
  assert.equal(
    await status([
      { type: "turn/start" },
      { type: "turn/end", data: { reason: { kind: "completed" } } },
      { type: "turn/start" },
      { type: "tool/call" },
    ]),
    "running",
  );
});

test("an empty or missing log has no status", async () => {
  assert.equal(await status([]), undefined);
  assert.equal(await status("missing"), undefined);
});
