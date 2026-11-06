import assert from "node:assert/strict";
import test from "node:test";
import {
  MessageError,
  errorMessage,
  language,
  locales,
  messageText,
} from "@aura/i18n/runtime";
import type { ChatModelCatalog } from "@aura/protocol/types";
import { selectChatModel } from "../src/chatModels.ts";
import { reply } from "../src/transport.ts";
import { codingTurn } from "../src/features/coding/api.ts";

const catalog: ChatModelCatalog = {
  mode: "codex",
  defaultModel: "sol",
  models: [
    {
      id: "sol",
      name: "Sol",
      defaultReasoningEffort: "xhigh",
      reasoningEfforts: [
        { id: "high", name: "High" },
        { id: "xhigh", name: "Extra high" },
      ],
    },
    {
      id: "small",
      name: "Small",
      defaultReasoningEffort: "high",
      reasoningEfforts: [{ id: "high", name: "High" }],
    },
  ],
};

test("model switching retains supported efforts and resets incompatible ones", () => {
  assert.deepEqual(
    selectChatModel(
      catalog,
      { model: "sol", reasoningEffort: "xhigh" },
      "small",
    ),
    { model: "small" },
  );
  assert.deepEqual(
    selectChatModel(
      catalog,
      { model: "sol", reasoningEffort: "high" },
      "small",
    ),
    { model: "small", reasoningEffort: "high" },
  );
  assert.deepEqual(selectChatModel(catalog, { model: "small" }, ""), {});
});

test("chat transport sends only the supplied conversation configuration", async (t) => {
  const original = globalThis.fetch;
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response('{"type":"delta","text":"ok"}\n{"type":"done"}\n');
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  const messages = [
    {
      id: "u",
      role: "user" as const,
      status: "complete" as const,
      text: "hello",
    },
  ];
  const selection = { model: "gpt-6.1-sol", reasoningEffort: "high" };
  for await (const _chunk of reply(
    messages,
    "codex",
    "http://localhost:4311",
    "one",
    new AbortController().signal,
    selection,
  )) {
    /* drain */
  }
  for await (const _chunk of reply(
    messages,
    "codex",
    "http://localhost:4311",
    "two",
    new AbortController().signal,
  )) {
    /* drain */
  }
  assert.deepEqual(bodies[0]!.modelConfig, selection);
  assert.equal(bodies[1]!.modelConfig, undefined);
  assert.equal(bodies[0]!.sessionId, "one");
  assert.equal(bodies[1]!.sessionId, "two");
});

test("legacy streaming errors remain translatable without repeating requests and retain unknown messages and cancellation", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalLocale = language.getSnapshot().locale;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await language.systemChanged([originalLocale]);
  });
  const messages = [
    {
      id: "user",
      role: "user" as const,
      status: "complete" as const,
      text: "原始内容",
    },
  ];
  const signal = new AbortController().signal;
  const operations = [
    () => reply(messages, "codex", "https://synthetic.invalid", "one", signal),
    () =>
      codingTurn(
        "https://synthetic.invalid",
        { sessionId: "one", prompt: "原始内容", mode: "demo" },
        signal,
      ),
  ];
  let count = 0;
  const drain = async (iterator: AsyncGenerator<unknown>) => {
    for await (const _value of iterator) {
      /* drain synthetic stream */
    }
  };
  for (const response of [
    () =>
      new Response("old text", {
        status: 400,
        headers: { "X-Aura-Error-Code": "conversation_request_invalid" },
      }),
    () =>
      new Response(
        JSON.stringify({
          type: "error",
          message: "old text",
          code: "conversation_source_mismatch",
          params: { token: "private" },
        }) + "\n",
      ),
    () => new Response('{"type":"error"}\n'),
    () => new Response('{"type":"delta","text":"original reply"}\n'),
  ]) {
    globalThis.fetch = async (_input, init) => {
      count++;
      assert.equal(init?.signal, signal);
      assert.equal(String(init?.body).includes("locale"), false);
      return response();
    };
    for (const operation of operations) {
      let captured: MessageError | undefined;
      await assert.rejects(drain(operation()), (error) => {
        assert.ok(error instanceof MessageError);
        captured = error;
        return true;
      });
      const calls = count;
      const texts = new Set<string>();
      for (const locale of locales) {
        await language.systemChanged([locale]);
        const text = messageText(errorMessage(captured));
        assert.doesNotMatch(text, /old text|private|apiErrors:|conversation:/u);
        texts.add(text);
      }
      assert.equal(texts.size, 6);
      assert.equal(count, calls);
    }
  }
  globalThis.fetch = async () =>
    new Response(
      '{"type":"error","message":"External original error","code":"unknown"}\n',
    );
  for (const operation of operations)
    await assert.rejects(drain(operation()), (error) => {
      assert.ok(error instanceof MessageError);
      assert.equal(error.text, "External original error");
      return true;
    });
  const aborted = new DOMException("synthetic cancellation", "AbortError");
  globalThis.fetch = async () => {
    throw aborted;
  };
  for (const operation of operations)
    await assert.rejects(drain(operation()), (error) => error === aborted);

  let canceled = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          '{"type":"error","code":"conversation_message_empty"}\n',
        ),
      );
    },
    cancel() {
      canceled++;
    },
  });
  globalThis.fetch = async () => new Response(stream);
  await assert.rejects(drain(operations[0]()));
  assert.equal(canceled, 1);
  assert.equal(stream.locked, false);
});
