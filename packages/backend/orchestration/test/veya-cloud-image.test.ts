import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { GeneratedArtifacts } from "../src/generated-artifacts.ts";
import { VEYA_CLOUD_IMAGE_CAPABILITY, VeyaCloudImageCapability } from "../src/veya-cloud-image.ts";

test("one generated square PNG is registered, admitted to vision and staged byte-for-byte", async () => {
  const root = await mkdtemp(join(tmpdir(), "aura-cloud-image-"));
  const controller = new AbortController();
  try {
    const png = await sharp({ create: { width: 512, height: 512, channels: 4,
      background: { r: 155, g: 155, b: 155, alpha: 1 } } }).png().toBuffer();
    let calls = 0;
    const capability = new VeyaCloudImageCapability({
      async generateCloudImage() { calls++; return { bytes: png, taskId: "paid-1", creditsConsumed: 1.25,
        actualModel: "chat_image_2.5_flare" }; },
    }, new GeneratedArtifacts(join(root, "store")), {
      async saveImage() { return { attachmentId: "sha256:" + "a".repeat(64) } as never; },
    });
    const result = await capability.invoke(VEYA_CLOUD_IMAGE_CAPABILITY, "generate",
      { prompt: "abstract cloud mask", model: "chat_image_2.5_flare", quality: "medium" }, controller.signal);
    assert.equal(calls, 1);
    assert.equal((result as { status: string }).status, "ready");
    const id = (result as { artifactId: string }).artifactId;
    await new GeneratedArtifacts(join(root, "store")).stageCloudPng(id, join(root, "exchange"), controller.signal);
    assert.deepEqual(await readFile(join(root, "exchange", `${id}.png`)), png);
    const corrupt = Buffer.from(png);
    corrupt[corrupt.length - 1] ^= 1;
    await writeFile(join(root, "store", `${id}.png`), corrupt);
    await assert.rejects(new GeneratedArtifacts(join(root, "store")).stageCloudPng(id,
      join(root, "exchange-2"), controller.signal), /artifact_hash_mismatch/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("invalid paid cloud image is reported and not admitted or regenerated", async () => {
  const png = await sharp({ create: { width: 512, height: 256, channels: 4,
    background: { r: 155, g: 155, b: 155, alpha: 1 } } }).png().toBuffer();
  let calls = 0;
  const capability = new VeyaCloudImageCapability({
    async generateCloudImage() { calls++; return { bytes: png, taskId: "paid-invalid", creditsConsumed: 1,
      actualModel: "chat_image_2.5_flare" }; },
  }, {} as GeneratedArtifacts, {} as never);
  const result = await capability.invoke(VEYA_CLOUD_IMAGE_CAPABILITY, "generate",
    { prompt: "abstract clouds" }, new AbortController().signal);
  assert.equal((result as { status: string }).status, "image_validation_failed");
  assert.equal(calls, 1);
});

test("unknown paid outcome is not retried", async () => {
  let calls = 0;
  const capability = new VeyaCloudImageCapability({
    async generateCloudImage() { calls++; throw new Error("lost submit response"); },
  }, {} as GeneratedArtifacts, {} as never);
  await assert.rejects(capability.invoke(VEYA_CLOUD_IMAGE_CAPABILITY, "generate",
    { prompt: "abstract cloud mask" }, new AbortController().signal), /cloud_image_result_unknown/u);
  assert.equal(calls, 1);
});
