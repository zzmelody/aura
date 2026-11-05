import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Hono } from "hono";
import sharp from "sharp";
import { GeneratedArtifacts } from "@aura/orchestration/host";
import { createFlowApp } from "../src/flow-routes.ts";

const png = () =>
  sharp({
    create: { width: 16, height: 12, channels: 3, background: "blue" },
  })
    .png()
    .toBuffer();

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
