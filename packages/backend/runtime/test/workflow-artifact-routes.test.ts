import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { GeneratedArtifacts } from "@aura/orchestration/host";
import { createFlowApp } from "../src/flow-routes.ts";

test("artifact routes delegate only identifiers, support HEAD and preserve binary responses", async () => {
  const calls: unknown[] = [];
  const app = createFlowApp({
    async request<T>(method: string, params?: object) {
      calls.push([method, params]);
      return { artifacts: [], pending: false } as T;
    },
    async artifactContent(id, artifactId, thumbnail, request) {
      calls.push([id, artifactId, thumbnail, request.method]);
      return new Response(request.method === "HEAD" ? null : "image", {
        headers: { "content-type": "image/png" },
      });
    },
  });
  assert.equal((await app.request("/runs/run/artifacts?retry=1")).status, 200);
  assert.equal(
    await (await app.request("/runs/run/artifacts/abc/content")).text(),
    "image",
  );
  assert.equal(
    (await app.request("/runs/run/artifacts/abc/thumbnail", { method: "HEAD" }))
      .status,
    200,
  );
  assert.deepEqual(calls, [
    ["artifacts/list", { id: "run", retry: true }],
    ["run", "abc", false, "GET"],
    ["run", "abc", true, "HEAD"],
  ]);
});

test("uploaded chat images are served and read back only by verified content ID", async () => {
  const { OrchestrationHost } = await import("../src/dsh/host.ts");
  const artifactHash = (data: Uint8Array) =>
    createHash("sha256").update(data).digest("hex");
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "aura-chat-image-")),
  );
  try {
    const dshHome = join(root, "dsh");
    const store = new GeneratedArtifacts(
      join(dshHome, "aura-generated-assets"),
    );
    const bytes = await sharp({
      create: { width: 8, height: 6, channels: 3, background: "#8052EA" },
    })
      .png()
      .toBuffer();
    const { artifactId } = await store.registerImage(
      bytes,
      AbortSignal.timeout(5000),
    );
    assert.equal(artifactId, artifactHash(bytes));
    const read = await store.readImage(artifactId, AbortSignal.timeout(5000));
    assert.equal(read.mediaType, "image/png");
    assert.equal(read.bytes.length, bytes.length);

    const host = new OrchestrationHost({
      root,
      dshHome,
      modelURL: "http://127.0.0.1:1/v1",
    });
    const ok = await host.imageAssetContent(
      artifactId,
      new Request("http://x/img"),
    );
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "image/png");
    assert.equal((await ok.arrayBuffer()).byteLength, bytes.length);
    await assert.rejects(
      host.imageAssetContent("../etc", new Request("http://x/img")),
      /图片不存在/u,
    );
    await assert.rejects(
      host.imageAssetContent("f".repeat(64), new Request("http://x/img")),
      /图片不存在/u,
    );

    // A file whose bytes no longer match its name is refused on both paths.
    const forged = "e".repeat(64);
    await writeFile(join(store.root, `${forged}.png`), bytes);
    await assert.rejects(
      store.readImage(forged, AbortSignal.timeout(5000)),
      /内容已改变/u,
    );
    await assert.rejects(
      host.imageAssetContent(forged, new Request("http://x/img")),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
