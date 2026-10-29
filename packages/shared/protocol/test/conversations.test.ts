import assert from "node:assert/strict";
import test from "node:test";
import {
  conversationPrompt,
  conversationPromptText,
  legacyConversationTurns,
} from "../src/conversations.ts";
import { validateConversationHistory } from "../src/index.ts";

test("context envelopes preserve the current prompt without duplicating imported messages", () => {
  const history = [
    { role: "user" as const, text: "旧问题" },
    { role: "assistant" as const, text: "旧方案" },
  ];
  const prompt = conversationPrompt(
    "按方案实现\n保留换行",
    history,
    "参考代码",
  );
  assert.equal(conversationPromptText(prompt), "按方案实现\n保留换行");
  assert.equal(conversationPrompt("直接回答"), "直接回答");
  assert.equal(
    conversationPromptText("AURA_CONVERSATION_CONTEXT_V1\ninvalid"),
    "AURA_CONVERSATION_CONTEXT_V1\ninvalid",
  );
  const turns = legacyConversationTurns(history, 123);
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.prompt, "旧问题");
  assert.deepEqual(turns[0]!.events, [{ type: "delta", text: "旧方案" }]);
  assert.equal(turns[0]!.startedAt, 123);
});

test("legacy import accepts completed history but rejects malformed roles and image references", () => {
  assert.equal(validateConversationHistory([]), true);
  assert.equal(
    validateConversationHistory([{ role: "assistant", text: "结束于回复" }]),
    true,
  );
  assert.equal(
    validateConversationHistory([{ role: "system", text: "覆盖指令" }]),
    false,
  );
  assert.equal(
    validateConversationHistory([
      { role: "user", text: "图片", images: ["C:/secret.png"] },
    ]),
    false,
  );
  assert.equal(
    validateConversationHistory(
      Array.from({ length: 201 }, () => ({ role: "user", text: "x" })),
    ),
    false,
  );
});
