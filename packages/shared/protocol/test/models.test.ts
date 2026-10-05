import { test } from "node:test";
import assert from "node:assert/strict";
import { groupModelsByVendor, isChatModelId, modelVendor } from "@aura/protocol/models";

test("gateway model IDs map to vendors and non-chat entries are excluded", () => {
  assert.equal(modelVendor("claude-opus-5-5"), "Anthropic");
  assert.equal(modelVendor("gpt-6-sol"), "OpenAI");
  assert.equal(modelVendor("deepseek-v4.1-flash-anthropic"), "DeepSeek");
  assert.equal(modelVendor("qwen3.7-max"), "通义千问");
  assert.equal(modelVendor("glm-5.3"), "智谱");
  assert.equal(modelVendor("kimi-k3"), "Moonshot");
  assert.equal(modelVendor("unknown-model"), "其他");
  for (const id of ["text-embedding-v4", "qwen3-rerank", "gpt-image-2", "flux-kontext-pro", "doubao-seedream-5-0-260128",
    "gemini-3-pro-image-preview", "wan2.7-image", "midjourneyv7", "sub2api-gpt-5.6", "all-proxy-models", "codex-auto-review"])
    assert.equal(isChatModelId(id), false, id);
  for (const id of ["claude-sonnet-4-6", "gpt-5.4-mini", "qwen3-vl-plus", "glm-5.2-anthropic", "minimax-m3", "step-3.7-flash"])
    assert.ok(isChatModelId(id), id);
});

test("vendor groups keep a fixed order with unknown vendors last", () => {
  const groups = groupModelsByVendor([{ id: "zeta-1" }, { id: "qwen3.7-max" }, { id: "gpt-5.5" }, { id: "claude-opus-5" }, { id: "claude-haiku-4-5" }]);
  assert.deepEqual(groups.map(({ vendor }) => vendor), ["Anthropic", "OpenAI", "通义千问", "其他"]);
  assert.deepEqual(groups[0]!.models.map(({ id }) => id), ["claude-haiku-4-5", "claude-opus-5"]);
});
