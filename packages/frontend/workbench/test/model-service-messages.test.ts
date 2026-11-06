import assert from "node:assert/strict";
import test from "node:test";
import { language, locales, messageText } from "@aura/i18n/runtime";
import { modelProbeFailures } from "@aura/protocol/model-checks";
import { modelServiceFeedback } from "../src/model-service-messages.ts";

test("retained model checks translate status, reason and counts while preserving model IDs and replies", async (t) => {
  const before = language.getSnapshot().locale;
  t.after(() => language.systemChanged([before]));
  const cases = [
    { code: "unchecked" },
    { code: "key_required" },
    { code: "discovery_failed" },
    { code: "catalog_failed" },
    { code: "models_synced", count: 2 },
    { code: "models_listed", count: 5 },
    {
      code: "probe_succeeded",
      model: "original-model",
      elapsedMs: 1250,
      reply: "原始回复 {{literal}}",
    },
    ...modelProbeFailures.map((reason) => ({
      code: "probe_failed",
      model: "original-model",
      reason,
    })),
  ];
  const feedback = cases.map((value) =>
    modelServiceFeedback(
      { ...value, token: "private-must-not-render" },
      "legacy response",
    ),
  );
  assert.deepEqual(
    feedback.map((item) => item.tone),
    [
      "info",
      "error",
      "error",
      "error",
      "ok",
      "info",
      "ok",
      ...modelProbeFailures.map(() => "error"),
    ],
  );
  const translations = cases.map(() => new Set<string>());
  for (const locale of locales) {
    await language.systemChanged([locale]);
    feedback.forEach((item, index) => {
      const text = messageText(item.text);
      assert.ok(
        text &&
          !text.includes("private-must-not-render") &&
          text !== "legacy response",
      );
      if (index >= 6) assert.ok(text.includes("original-model"));
      if (index === 6) assert.ok(text.includes("原始回复 {{literal}}"));
      translations[index].add(text);
    });
  }
  for (const values of translations) assert.equal(values.size, 6);
  await language.systemChanged(["ru"]);
  for (const [count, word] of [
    [1, "модель"],
    [2, "модели"],
    [5, "моделей"],
  ] as const)
    assert.ok(
      messageText(
        modelServiceFeedback({ code: "models_synced", count }, "legacy").text,
      ).includes(word),
    );
  assert.deepEqual(
    modelServiceFeedback(undefined, "Original third-party result"),
    { tone: "error", text: "Original third-party result" },
  );
  assert.equal(
    modelServiceFeedback({ code: "future" }, "Legacy result").text,
    "Legacy result",
  );
});
