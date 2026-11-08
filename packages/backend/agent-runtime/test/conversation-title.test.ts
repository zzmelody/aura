import assert from "node:assert/strict";
import test from "node:test";
import type { Context } from "@deepseek-ai/cordis";
import {
  ReasoningEffortId,
  resolveRetryPolicy,
  type GenerateOptions,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import {
  conversationTitleGenerator,
  type ConversationTitleRequest,
} from "../src/conversations/conversation-title.ts";

// Synthetic DSH stream: no provider credentials or paid requests are used.
function fixture(chunks: StreamChunk[]) {
  const order: string[] = [];
  const requests: GenerateOptions[] = [];
  const settlements: boolean[] = [];
  const llm: Pick<Context["llm"], "prepareCall"> = {
    async prepareCall(config, signal, configure) {
      signal?.throwIfAborted();
      const resolved = configure
        ? configure(config, {
            provider: config.provider,
            id: config.model,
            name: config.model,
            reasoning: {
              defaultEffort: ReasoningEffortId("high"),
              efforts: ["low", "high"].map((id) => ({
                id: ReasoningEffortId(id),
                name: id,
              })),
            },
          })
        : config;
      return {
        config: { ...config, ...resolved },
        adapterDefaults: {},
        retryPolicy: resolveRetryPolicy(undefined, "synthetic"),
        async *stream(options) {
          order.push("dispatch");
          requests.push(options);
          yield* chunks;
        },
      };
    },
  };
  const budget: Parameters<typeof conversationTitleGenerator>[1] = {
    async reserve(kind, id) {
      assert.equal(kind, "title");
      assert.equal(id, "conversation");
      order.push("reserve");
      return "reservation";
    },
    async settle(id, complete) {
      assert.equal(id, "reservation");
      settlements.push(complete);
    },
  };
  return { llm, budget, requests, settlements, order };
}

const request: ConversationTitleRequest = {
  sessionId: "conversation",
  prompt: "能帮我解决侧边对话发过去看不到内容的问题吗？".repeat(400),
  mode: "custom",
  model: "selected-model",
  reasoningEffort: "high",
  defaults: {
    provider: "synthetic-provider",
    model: "default-model",
    reasoningEffort: "high",
    maxTokens: 20_000,
    timeoutMs: 60_000,
  },
};
const stop: StreamChunk = { type: "finish", reason: { kind: "stop" } };

test("titles use the selected DSH route, bounded input and a reservation before dispatch", async () => {
  const { llm, budget, requests, settlements, order } = fixture([
    { type: "text-delta", index: 0, text: "**修复侧边对话" },
    { type: "text-delta", index: 0, text: "引用**\n附加解释" },
    stop,
  ]);
  const generate = conversationTitleGenerator(llm, budget);
  assert.equal(
    await generate(request, new AbortController().signal),
    "修复侧边对话引用",
  );
  assert.deepEqual(order, ["reserve", "dispatch"]);
  assert.deepEqual(settlements, [true]);
  const sent = requests[0]!;
  assert.equal(sent.provider, "synthetic-provider");
  assert.equal(sent.model, "selected-model");
  assert.equal(sent.reasoningEffort, "low");
  assert.equal(sent.maxTokens, 128);
  assert.equal(sent.purpose, "session-title");
  assert.equal(sent.sessionId, "conversation");
  assert.equal(sent.tools, undefined);
  const part = sent.messages[0]!.content[0]!;
  assert.equal(part.type, "text");
  if (part.type === "text")
    assert.equal(JSON.parse(part.text), request.prompt.slice(0, 4000));
  assert.equal(request.defaults?.maxTokens, 20_000);
});

test("ledger failures prevent title dispatch and cancellation prevents reservations", async () => {
  const { llm, budget, requests, order } = fixture([stop]);
  budget.reserve = async () => {
    throw new Error("ledger write failed");
  };
  const generate = conversationTitleGenerator(llm, budget);
  await assert.rejects(
    generate(request, new AbortController().signal),
    /ledger write failed/u,
  );
  await assert.rejects(
    generate(request, AbortSignal.abort(new Error("cancelled"))),
    /cancelled/u,
  );
  assert.deepEqual(requests, []);
  assert.deepEqual(order, []);
});

test("unknown title outcomes are settled once without retrying the model", async () => {
  const { llm, budget, requests, settlements } = fixture([
    { type: "text-delta", index: 0, text: "partial" },
    {
      type: "finish",
      reason: {
        kind: "error",
        failure: { code: "NETWORK", message: "synthetic failure" },
      },
    },
  ]);
  await assert.rejects(
    conversationTitleGenerator(llm, budget)(
      request,
      new AbortController().signal,
    ),
    /标题未能自动提炼/u,
  );
  assert.equal(requests.length, 1);
  assert.deepEqual(settlements, [false]);
});

test("empty and truncated title outputs keep the known completed request charged", async () => {
  for (const chunks of [
    [stop],
    [
      { type: "text-delta", index: 0, text: "cut off" },
      { type: "finish", reason: { kind: "max-tokens" } },
    ],
  ] satisfies StreamChunk[][]) {
    const { llm, budget, settlements } = fixture(chunks);
    await assert.rejects(
      conversationTitleGenerator(llm, budget)(
        request,
        new AbortController().signal,
      ),
      /标题未能自动提炼/u,
    );
    assert.deepEqual(settlements, [true]);
  }
});

test("cancelling a dispatched title cancels its stream and retains the reservation", async () => {
  const { llm, budget, settlements } = fixture([]);
  const original = llm.prepareCall;
  const abort = new AbortController();
  llm.prepareCall = async (...args) => {
    const call = await original(...args);
    return {
      ...call,
      async *stream(options) {
        assert.equal(options.signal?.aborted, false);
        abort.abort(new Error("stopped"));
        assert.equal(options.signal?.aborted, true);
        yield stop;
      },
    };
  };
  await assert.rejects(
    conversationTitleGenerator(llm, budget)(request, abort.signal),
    /stopped/u,
  );
  assert.deepEqual(settlements, [false]);
});
