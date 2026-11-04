import assert from "node:assert/strict";
import { test } from "node:test";
import {
  steerCodingTurn,
  waitForCodingTurnEnd,
} from "../src/features/coding/api.ts";

test("guidance sends the captured model and effort together with its content", async (t) => {
  const requests: Array<{ url: string; body: unknown }> = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return Response.json({ steered: true });
  });
  const modelConfig = {
    mode: "codex" as const,
    selection: { model: "gpt-6.1-sol", reasoningEffort: "high" },
  };
  const requestId = "00000000-0000-4000-8000-000000000001";
  assert.deepEqual(
    await steerCodingTurn(
      "http://fixture",
      "coding-1",
      "继续检查",
      undefined,
      modelConfig,
      undefined,
      requestId,
    ),
    { steered: true },
  );
  assert.deepEqual(requests, [
    {
      url: "http://fixture/coding/sessions/coding-1/steer",
      body: { prompt: "继续检查", modelConfig, requestId },
    },
  ]);
});

test("a rejected guidance request is sent once and reports the failure", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return Response.json({ message: "模型配置不可用" }, { status: 422 });
  });
  await assert.rejects(
    steerCodingTurn("http://fixture", "coding-1", "继续"),
    /模型配置不可用/u,
  );
  assert.equal(requests, 1);
});

test("rejected guidance waits for the backend to finish before enabling a new turn", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const firstCheck = Promise.withResolvers<void>();
  const requests: string[] = [];
  const completed = {
    prompt: "检查",
    startedAt: 1,
    endedAt: 2,
    status: "complete",
    events: [],
  };
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push(`${init?.method} ${new URL(String(url)).pathname}`);
    if (init?.method === "POST") return Response.json({ steered: false });
    const running = requests.length === 2;
    // The model can have finished while the host is still cleaning up.
    return Response.json({ turns: [completed], running });
  });
  const endpoint = "http://fixture";
  const id = "coding-1";
  assert.deepEqual(await steerCodingTurn(endpoint, id, "继续"), {
    steered: false,
  });
  const timer = globalThis.setTimeout;
  t.mock.method(
    globalThis,
    "setTimeout",
    (...args: Parameters<typeof timer>) => {
      firstCheck.resolve();
      return timer(...args);
    },
  );
  const signal = new AbortController().signal;
  let settled = false;
  const waiting = waitForCodingTurnEnd(endpoint, id, signal).then((turn) => {
    settled = true;
    return turn;
  });
  await Promise.race([firstCheck.promise, waiting]);
  assert.equal(settled, false);
  t.mock.timers.runAll();
  assert.deepEqual(await waiting, completed);
  assert.deepEqual(requests, [
    "POST /coding/sessions/coding-1/steer",
    "GET /coding/sessions/coding-1/history",
    "GET /coding/sessions/coding-1/history",
  ]);
});

test("a history response without a valid running flag cannot confirm turn completion", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ turns: [] }));
  await assert.rejects(
    waitForCodingTurnEnd(
      "http://fixture",
      "coding-1",
      new AbortController().signal,
    ),
    /无法确认/u,
  );
});

test("cancelling status reconciliation stops polling without another request", async (t) => {
  const retryScheduled = Promise.withResolvers<void>();
  const timer = globalThis.setTimeout;
  t.mock.method(
    globalThis,
    "setTimeout",
    (...args: Parameters<typeof timer>) => {
      retryScheduled.resolve();
      return timer(...args);
    },
  );
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return Response.json({ running: true, turns: [] });
  });
  const abort = new AbortController();
  const waiting = waitForCodingTurnEnd(
    "http://fixture",
    "coding-1",
    abort.signal,
  );
  await Promise.race([retryScheduled.promise, waiting]);
  abort.abort();
  await assert.rejects(waiting, { name: "AbortError" });
  assert.equal(requests, 1);
});
