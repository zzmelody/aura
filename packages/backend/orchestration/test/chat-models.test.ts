import assert from "node:assert/strict";
import test from "node:test";
import { LlmError, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { chatModelCatalog, resolveChatModel } from "../src/chat-models.ts";
import { agentDefaults } from "../src/agent-config.ts";

function runtime() {
  const calls: Array<{ model: string; reasoningEffort?: string }> = [];
  const llm: Parameters<typeof resolveChatModel>[0] = {
    async listModels(provider) {
      return ["gpt-6.1-sol", "limited", "plain"].map((id) => ({
        provider,
        id,
        name: id,
      }));
    },
    async resolveModelInfo(provider, model) {
      if (model === "unknown")
        throw new LlmError("sensitive upstream detail", "UNKNOWN_MODEL");
      const ids =
        model === "limited"
          ? ["low", "high"]
          : ["low", "medium", "high", "xhigh"];
      return {
        provider,
        id: model,
        name: model,
        ...(model === "plain"
          ? {}
          : {
              reasoning: {
                defaultEffort: ReasoningEffortId("low"),
                efforts: ids.map((id) => ({
                  id: ReasoningEffortId(id),
                  name: id,
                })),
              },
            }),
      };
    },
    async resolveCallConfig(config) {
      calls.push(config);
      if (config.reasoningEffort === "invalid")
        throw new LlmError("private detail", "UNSUPPORTED_REASONING_EFFORT");
      return config;
    },
  };
  return { llm, calls };
}

test("chat catalog projects DSH capabilities and model-specific defaults", async () => {
  const { llm } = runtime();
  const catalog = await chatModelCatalog(
    llm,
    "codex",
    AbortSignal.timeout(5000),
  );
  assert.equal(catalog.models[0]!.defaultReasoningEffort, "xhigh");
  assert.equal(catalog.models[1]!.defaultReasoningEffort, "low");
  assert.deepEqual(catalog.models[2]!.reasoningEfforts, []);
  assert.equal(catalog.models[2]!.defaultReasoningEffort, undefined);
});

test("chat choices are per request, do not mutate Flow defaults and never silently downgrade explicit efforts", async () => {
  const { llm } = runtime();
  const original = agentDefaults("codex");
  const signal = AbortSignal.timeout(5000);
  const [first, second] = await Promise.all([
    resolveChatModel(
      llm,
      "codex",
      { model: "limited", reasoningEffort: "high" },
      signal,
    ),
    resolveChatModel(llm, "codex", {}, signal),
  ]);
  assert.equal(first.model, "limited");
  assert.equal(first.reasoningEffort, "high");
  assert.equal(second.model, original.model);
  assert.equal(second.reasoningEffort, original.reasoningEffort);
  assert.deepEqual(agentDefaults("codex"), original);
  assert.equal(
    (await resolveChatModel(llm, "codex", { model: "limited" }, signal))
      .reasoningEffort,
    "low",
  );
  assert.equal(
    (await resolveChatModel(llm, "codex", { model: "plain" }, signal))
      .reasoningEffort,
    undefined,
  );
  for (const selection of [
    { model: "unknown" },
    { reasoningEffort: "invalid" },
  ]) {
    await assert.rejects(
      resolveChatModel(llm, "codex", selection, signal),
      (error: Error & { status?: number }) => {
        assert.equal(error.status, 422);
        assert.match(
          error.message,
          /UNKNOWN_MODEL|UNSUPPORTED_REASONING_EFFORT/,
        );
        assert.doesNotMatch(error.message, /private|sensitive/);
        return true;
      },
    );
  }
});

test("models the subscription refused leave the catalog, the default never does", async () => {
  const { RejectedChatModels } = await import("../src/chat-models.ts");
  const { llm } = runtime();
  const rejected = new RejectedChatModels();
  rejected.reject("codex", "limited");
  rejected.reject("codex", agentDefaults("codex").model);
  const catalog = await chatModelCatalog(
    llm,
    "codex",
    AbortSignal.timeout(5000),
    rejected,
  );
  assert.deepEqual(
    catalog.models.map(({ id }) => id),
    ["gpt-6.1-sol", "plain"].filter((id) => id !== "limited"),
  );
  const demo = await chatModelCatalog(
    llm,
    "demo",
    AbortSignal.timeout(5000),
    rejected,
  );
  assert.ok(demo.models.some(({ id }) => id === "limited"));
});

test("a ChatGPT-account model refusal becomes a clear, forwardable message", async () => {
  const { agentFailure } = await import("../src/sessions.ts");
  const refused = agentFailure(
    '{"detail":"The \'gpt-5.4-mini\' model is not supported when using Codex with a ChatGPT account."}',
  );
  assert.equal(refused.status, 422);
  assert.equal(
    refused.message,
    "模型 gpt-5.4-mini 不支持 Codex 订阅账号，请换一个模型再试。",
  );
  assert.notEqual(agentFailure("boom").status, 422);
});
