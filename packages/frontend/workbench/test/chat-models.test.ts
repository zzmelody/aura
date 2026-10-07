import assert from "node:assert/strict";
import test from "node:test";
import type { ChatModelCatalog } from "@aura/protocol/types";
import { selectChatModel } from "../src/chatModels.ts";
import { reply } from "../src/transport.ts";

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
