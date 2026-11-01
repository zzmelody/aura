import assert from "node:assert/strict";
import { test } from "node:test";
import {
  prepareCodingTurn,
  codingTurn,
  conversationHistory,
} from "../src/features/coding/api.ts";

const endpoint = "http://fixture:4311";
const turn = {
  sessionId: "coding-fixture",
  projectId: "fixture",
  prompt: "Fixture",
  mode: "codex" as const,
};

test("startup admission waits for the real workspace and never sends a model request during preparation", async (t) => {
  const response = Promise.withResolvers<Response>();
  const requested: RequestInit[] = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    requested.push(options ?? {});
    return response.promise;
  });
  const waiting = prepareCodingTurn(
    endpoint,
    "fixture",
    new AbortController().signal,
  );
  assert.equal(requested.length, 1);
  assert.equal(requested[0]?.method, undefined);
  response.resolve(
    Response.json([
      { id: "fixture", directory: "F:/fixture", title: "Fixture" },
    ]),
  );
  await waiting;
  assert.equal(requested.length, 1);
});

test("removed or missing cached workspaces fail before the turn is posted", async (t) => {
  let posts = 0;
  let missing = false;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    if (options?.method === "POST") posts++;
    return Response.json(
      missing ? [{ id: "fixture", status: "missing-dir" }] : [],
    );
  });
  const send = async () => {
    const signal = new AbortController().signal;
    await prepareCodingTurn(endpoint, "fixture", signal);
    for await (const chunk of codingTurn(endpoint, turn, signal))
      assert.ok(chunk);
  };
  await assert.rejects(send, /工作空间已不可用/u);
  missing = true;
  await assert.rejects(send, /工作空间已不可用/u);
  assert.equal(posts, 0);
});

test("cancelling startup admission cancels the read and never dispatches a queued request", async (t) => {
  const abort = new AbortController();
  let received: AbortSignal | undefined;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    received = options?.signal ?? undefined;
    return new Promise<Response>((_resolve, reject) =>
      received!.addEventListener("abort", () => reject(received!.reason), {
        once: true,
      }),
    );
  });
  const waiting = prepareCodingTurn(endpoint, "fixture", abort.signal);
  abort.abort(new DOMException("Cancelled", "AbortError"));
  await assert.rejects(waiting, /Cancelled/u);
  assert.equal(received?.aborted, true);
});

test("a failed model POST is never automatically retried", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    throw new TypeError("Fixture unknown outcome");
  });
  await assert.rejects(async () => {
    for await (const chunk of codingTurn(
      endpoint,
      turn,
      new AbortController().signal,
    ))
      assert.ok(chunk);
  }, /unknown outcome/u);
  assert.equal(requests, 1);
});

test("an expired startup admission reports an actionable error without contacting a model", async (t) => {
  t.mock.method(AbortSignal, "timeout", () =>
    AbortSignal.abort(new DOMException("Timeout", "TimeoutError")),
  );
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return Response.json([]);
  });
  await assert.rejects(
    prepareCodingTurn(endpoint, "fixture", new AbortController().signal),
    /服务仍未就绪/u,
  );
  assert.equal(requests, 0);
});

test("a stalled history read is cancelled and reports a retryable timeout", async (t) => {
  const expired = AbortSignal.abort(
    new DOMException("Timeout", "TimeoutError"),
  );
  t.mock.method(AbortSignal, "timeout", () => expired);
  let received: AbortSignal | null | undefined;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    received = options?.signal;
    received?.throwIfAborted();
    return Response.json({ turns: [] });
  });
  await assert.rejects(
    conversationHistory(endpoint, "fixture"),
    /会话历史读取超时/u,
  );
  assert.equal(received?.aborted, true);
});

test("switching away cancels a history read without turning cancellation into a timeout", async (t) => {
  const abort = new AbortController();
  t.mock.method(
    globalThis,
    "fetch",
    async (_url, options) =>
      new Promise<Response>((_resolve, reject) => {
        options!.signal!.addEventListener(
          "abort",
          () => reject(options!.signal!.reason),
          { once: true },
        );
      }),
  );
  const waiting = conversationHistory(endpoint, "fixture", abort.signal);
  const reason = new DOMException("Switched conversation", "AbortError");
  abort.abort(reason);
  await assert.rejects(waiting, (error) => error === reason);
});
