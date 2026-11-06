import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "@aura/core/types";
import {
  hasWorkflowContent,
  storedWorkflowValue,
  workflowDuration,
  workflowExecutions,
  workflowProgress,
} from "../src/workflowPresentation.ts";
import type { FlowRun } from "@aura/protocol/types";

test("execution turns pair input by run identity and retain unrelated history", () => {
  const messages: Message[] = [
    { id: "a:input", role: "user", text: "Input A", status: "complete" },
    { id: "b:input", role: "user", text: "Input B", status: "complete" },
    {
      id: "a:output",
      role: "assistant",
      text: "Output A",
      status: "complete",
      workflowRunId: "a",
    },
    { id: "note", role: "user", text: "An earlier note", status: "complete" },
    {
      id: "b:output",
      role: "assistant",
      text: "Output B",
      status: "streaming",
      workflowRunId: "b",
    },
  ];
  const cards = workflowExecutions(messages);
  assert.equal(cards.length, 3);
  assert.equal(cards[0].input?.text, "Input A");
  assert.equal(cards[1].message.id, "note");
  assert.equal(cards[2].input?.text, "Input B");
  assert.equal(messages.length, 5);
  assert.equal(workflowExecutions([messages[2]])[0].input, undefined);
});

test("empty reports are distinct from valid zero and false results", () => {
  for (const value of [
    undefined,
    null,
    "",
    "  ",
    {},
    [],
    { report: "" },
    { nested: [null, " "] },
  ])
    assert.equal(hasWorkflowContent(value), false);
  for (const value of [
    0,
    false,
    { count: 0 },
    [false],
    { report: "## Result\n- Done" },
  ])
    assert.equal(hasWorkflowContent(value), true);
});

test("saved inputs and outputs preserve structured values and markdown text", () => {
  assert.deepEqual(storedWorkflowValue('{"task":"One","limit":2}'), {
    task: "One",
    limit: 2,
  });
  assert.deepEqual(storedWorkflowValue('[{"title":"A"}]'), [{ title: "A" }]);
  assert.equal(
    storedWorkflowValue("# Result\n\n**Complete**"),
    "# Result\n\n**Complete**",
  );
  assert.equal(storedWorkflowValue("false"), false);
});

test("progress keeps concurrent active steps and does not count failures as completed", () => {
  const run = {
    steps: [
      { label: "Prepare", status: "completed" },
      { label: "Research", status: "running" },
      { label: "Review", status: "running" },
      { label: "Save", status: "failed" },
    ],
  } as FlowRun;
  assert.deepEqual(workflowProgress(run), {
    completed: 1,
    total: 4,
    current: ["Research", "Review"],
  });
  assert.deepEqual(workflowProgress(undefined), {
    completed: 0,
    total: 0,
    current: [],
  });
});

test("run durations use localized units while retaining truncation and elapsed time", () => {
  const short = {
    "zh-CN": "1分钟5秒",
    en: "1 min, 5 sec",
    ja: "1 分 5 秒",
    ko: "1분 5초",
    ru: "1 мин 5 с",
    fr: "1 min et 5 s",
  };
  for (const [locale, expected] of Object.entries(short))
    assert.equal(workflowDuration(0, 65_999, locale), expected, locale);
  assert.equal(workflowDuration(2000, 1000, "en"), "0 sec");
  assert.equal(workflowDuration(0, 3660999, "en"), "1 hr, 1 min");
});

test("outputs made only of local file paths can fold behind their media", async () => {
  const { onlyFileReferences } = await import("../src/workflowPresentation.ts");
  assert.equal(
    onlyFileReferences({ audioPath: String.raw`F:\aura\.aura\job\speech.wav` }),
    true,
  );
  assert.equal(
    onlyFileReferences({ videoPath: "/tmp/out/final.mp4", durationSeconds: 4 }),
    true,
  );
  assert.equal(
    onlyFileReferences({ files: ["C:/a/b.png", "C:/a/c.png"] }),
    true,
  );
  assert.equal(
    onlyFileReferences({ audioPath: "F:/x/a.wav", note: "旁白偏快" }),
    false,
  );
  assert.equal(onlyFileReferences({ report: "完成" }), false);
  assert.equal(
    onlyFileReferences({
      imagePath: "C:/a/out.png",
      imageAssetId: "a".repeat(64),
      seed: 7,
    }),
    true,
  );
  assert.equal(
    onlyFileReferences({
      imagePath: "C:/a/out.png",
      engine: "gpt",
      model: "chat_image_2.5_flare",
    }),
    true,
  );
  assert.equal(
    onlyFileReferences({ imagePath: "C:/a/out.png", note: "已改用本机模型" }),
    false,
  );
});

test("generated model metadata folds behind its preview without hiding reports or warnings", async () => {
  const { onlyFileReferences } = await import("../src/workflowPresentation.ts");
  const result = {
    outputDirectory: "F:/creative/assets/generated/axe",
    modelPath: "F:/creative/assets/generated/axe/model.glb",
    previewPath: "F:/creative/assets/generated/axe/preview.png",
    imagePaths: { front: "F:/creative/assets/generated/axe/view-front.png" },
    manifestPath: "F:/creative/assets/generated/axe/manifest.json",
    taskIds: {
      front: "image-task-1",
      model: "28cecb11-847e-4a85-bc8a-4eb01b95f7db",
    },
    imageModel: "chat_image_2.5_sunburst",
    modelVersion: "P1-20260311",
    creditsConsumed: 90,
    faceLimit: 15000,
    modelArtifact: { artifactId: "a".repeat(64), bytes: 1000, format: "glb" },
  };
  assert.equal(onlyFileReferences(result), true);
  assert.equal(
    onlyFileReferences({ ...result, note: "模型缺少贴图，请检查" }),
    false,
  );
  assert.equal(
    onlyFileReferences({ ...result, report: "## 模型验收\n尺寸偏大" }),
    false,
  );
  assert.equal(
    onlyFileReferences({ ...result, taskIds: { error: "生成失败，请重试" } }),
    false,
  );
});
