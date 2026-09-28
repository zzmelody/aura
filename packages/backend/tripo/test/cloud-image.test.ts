import test from "node:test";
import assert from "node:assert/strict";
import { TripoService } from "../src/index.ts";

test("cloud image submits one billed task and reports the provider's actual model", async () => {
  const png = Uint8Array.from({ length: 128 }, (_, i) => i === 0 ? 137 : 0);
  let submits = 0;
  const service = new TripoService("global", {
    async textToImage() { submits++; return "task-1"; },
    async waitForTask() { return { task_id: "task-1", type: "text_to_image", status: "success",
      input: { model: "chat_image_2.5_flare" }, output: { generated_image_url: "https://example.test/cloud.png" },
      credits_consumed: 1.5 }; },
  } as never, async () => new Response(png));
  const result = await service.generateCloudImage({ prompt: "clouds", model: "chat_image_2.5_flare",
    quality: "medium" }, new AbortController().signal);
  assert.equal(submits, 1);
  assert.equal(result.taskId, "task-1");
  assert.equal(result.actualModel, "chat_image_2.5_flare");
  assert.equal(result.creditsConsumed, 1.5);
});

test("an uncertain submit response is never automatically submitted again", async () => {
  let submits = 0;
  const service = new TripoService("global", {
    async textToImage() { submits++; throw new Error("response lost"); },
  } as never);
  await assert.rejects(service.generateCloudImage({ prompt: "clouds", model: "chat_image_2.5_flare",
    quality: "medium" }, new AbortController().signal), /response lost/u);
  assert.equal(submits, 1);
});

test("cloud download stops at the streamed 8 MiB limit without another paid task", async () => {
  let submits = 0;
  const service = new TripoService("global", {
    async textToImage() { submits++; return "task-oversize"; },
    async waitForTask() { return { task_id: "task-oversize", type: "text_to_image", status: "success",
      output: { generated_image_url: "https://example.test/oversize.png" } }; },
  } as never, async () => new Response(new Uint8Array(8 * 1024 * 1024 + 1)));
  await assert.rejects(service.generateCloudImage({ prompt: "clouds", model: "chat_image_2.5_flare",
    quality: "medium" }, new AbortController().signal), /exceeded 8 MiB/u);
  assert.equal(submits, 1);
});
