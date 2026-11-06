import assert from "node:assert/strict";
import { test } from "node:test";
import { errorMessage, language, messageText } from "@aura/i18n/runtime";
import { WorkflowApiError } from "../src/workflowSessions.ts";
import {
  prepareCodingTurn,
  codingTurn,
  conversationHistory,
  readCodingSubagents,
} from "../src/features/coding/api.ts";

const endpoint = "http://fixture:4311";
function hasMessage(key: string) {
  return (error: unknown) => {
    assert.deepEqual(errorMessage(error), { namespace: "conversation", key });
    return true;
  };
}
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

test("coding HTTP failures preserve their status and readable SDK message while the UI changes language", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return new Response("unavailable", { status: 503 });
  });
  const error = await readCodingSubagents(endpoint, "fixture").then(
    () => assert.fail("request must fail"),
    (error: unknown) => error,
  );
  assert.ok(error instanceof WorkflowApiError);
  assert.equal(error.status, 503);
  assert.equal(error.name, "Error");
  assert.ok(error.message.includes("503"));
  assert.deepEqual(errorMessage(error), {
    namespace: "conversation",
    key: "codingServiceUnavailable",
    values: { status: 503 },
  });
  const texts = new Set<string>();
  for (const locale of ["zh-CN", "en", "ja", "ko", "ru", "fr"]) {
    await language.systemChanged([locale]);
    const text = messageText(errorMessage(error));
    assert.ok(text.includes("503"));
    texts.add(text);
  }
  assert.equal(texts.size, 6);
  assert.equal(requests, 1);
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
  await assert.rejects(send, hasMessage("workspaceUnavailable"));
  missing = true;
  await assert.rejects(send, hasMessage("workspaceUnavailable"));
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
    hasMessage("admissionTimedOut"),
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
    hasMessage("historyReadTimeout"),
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
