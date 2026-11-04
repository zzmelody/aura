import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Hono } from "hono";
import sharp from "sharp";
import { GeneratedArtifacts } from "../src/artifacts/generated.ts";
import { prepareWorkflow, isolateComfyLaunch } from "../src/local-ai/comfy.ts";
import { createFlowApp } from "../src/index.ts";

const signal = () => new AbortController().signal;
const png = () =>
  sharp({
    create: { width: 16, height: 12, channels: 3, background: "blue" },
  })
    .png()
    .toBuffer();

test("managed images are content-addressed, verified and normalized for ComfyUI", async () => {
  const root = await mkdtemp(join(tmpdir(), "aura-comfy-image-"));
  try {
    const store = new GeneratedArtifacts(join(root, "assets"));
    const bytes = await png();
    const image = await store.registerImage(bytes, signal());
    assert.match(image.artifactId, /^[a-f0-9]{64}$/u);
    assert.equal(
      (await store.registerImage(bytes, signal())).artifactId,
      image.artifactId,
    );
    const filename = await store.stageImage(
      image.artifactId,
      join(root, "input"),
      signal(),
      {
        width: 352,
        height: 608,
      },
    );
    const staged = await readFile(join(root, "input", filename));
    const metadata = await sharp(staged).metadata();
    assert.deepEqual([metadata.width, metadata.height], [352, 608]);
    assert.equal(metadata.format, "png");
    await writeFile(join(root, "assets", `${image.artifactId}.png`), "changed");
    await assert.rejects(
      store.stageImage(image.artifactId, join(root, "input"), signal()),
      /不存在|已改变/,
    );
    await assert.rejects(
      store.stageImage("../secret", join(root, "input"), signal()),
      /ID/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ComfyUI snapshots managed LoadImage bindings and isolates the input directory", async () => {
  const assetId = "a".repeat(64);
  const input = {
    service: "minimax-h3" as const,
    workflow: {
      source: { class_type: "LoadImage", inputs: { image: "old.png" } },
      saved: {
        class_type: "SaveImage",
        inputs: { images: ["source", 0], filename_prefix: "test" },
      },
    },
    imageBindings: [{ nodeId: "source", assetId }],
  };
  const prepared = await prepareWorkflow(input, process.cwd(), signal());
  assert.equal(prepared.graph.source.inputs.image, `${assetId}.png`);
  assert.notEqual(
    prepared.workflowHash,
    (
      await prepareWorkflow(
        {
          ...input,
          imageBindings: [{ nodeId: "source", assetId: "b".repeat(64) }],
        },
        process.cwd(),
        signal(),
      )
    ).workflowHash,
  );
  await assert.rejects(
    prepareWorkflow(
      { ...input, imageBindings: [{ nodeId: "saved", assetId }] },
      process.cwd(),
      signal(),
    ),
    /LoadImage/,
  );
  const job = join(process.cwd(), "test-job");
  const isolated = isolateComfyLaunch(
    {
      cwd: process.cwd(),
      argv: ["python", "main.py", "--input-directory", "old"],
    },
    job,
  );
  assert.deepEqual(isolated.argv.slice(-6), [
    "--input-directory",
    join(job, "comfy-input"),
    "--output-directory",
    join(job, "comfy-output"),
    "--temp-directory",
    join(job, "comfy-temp"),
  ]);
});

test("Flow HTTP admits raw image uploads and returns a reusable asset ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "aura-image-upload-"));
  try {
    const store = new GeneratedArtifacts(join(root, "assets"));
    const app = createFlowApp({
      async request() {
        throw new Error("unexpected RPC");
      },
      uploadImage: (bytes, signal) => store.registerImage(bytes, signal),
    });
    const bytes = await png();
    const response = await app.request("/assets/images", {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: new Uint8Array(bytes),
    });
    assert.equal(response.status, 201);
    const body = (await response.json()) as {
      assetId: string;
      width: number;
      height: number;
    };
    assert.match(body.assetId, /^[a-f0-9]{64}$/u);
    assert.deepEqual([body.width, body.height], [16, 12]);
    const large = await sharp(randomBytes(640 * 640 * 3), {
      raw: { width: 640, height: 640, channels: 3 },
    })
      .png()
      .toBuffer();
    assert(large.length > 256 * 1024);
    const mounted = new Hono().route("/flows", app);
    assert.equal(
      (
        await mounted.request("/flows/assets/images", {
          method: "POST",
          headers: { "Content-Type": "image/png" },
          body: new Uint8Array(large),
        })
      ).status,
      201,
    );
    const oversized = await mounted.request("/flows/assets/images", {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: new Uint8Array(32 * 1024 * 1024 + 1),
    });
    assert.equal(oversized.status, 413);
    assert.deepEqual(await oversized.json(), {
      message: "图片不能超过 32 MB。",
    });
    const oversizedFlow = await mounted.request("/flows/fixture/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "x".repeat(256 * 1024) }),
    });
    assert.equal(oversizedFlow.status, 413);
    assert.deepEqual(await oversizedFlow.json(), {
      message: "Flow 请求过大。",
    });
    assert.equal(
      (
        await app.request("/assets/images", {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: "not an image",
        })
      ).status,
      415,
    );
    assert.equal(
      (
        await app.request("/assets/images", {
          method: "POST",
          headers: { "Content-Type": "image/png" },
          body: "not an image",
        })
      ).status,
      400,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
