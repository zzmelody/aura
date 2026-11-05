import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { GptImageService, readCodexImageStream } from "../src/gpt-image.ts";
import { GeneratedArtifacts } from "../src/artifacts/generated.ts";

test("Codex image parsing ignores malformed event shapes and accepts a later image", async () => {
  const events = [
    null,
    1,
    [],
    { type: "response.output_item.done", item: null },
    {
      type: "response.output_item.done",
      item: {
        type: "image_generation_call",
        result: Buffer.from("image").toString("base64"),
      },
    },
  ];
  const response = new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
  );
  const image = await readCodexImageStream(response);
  assert.equal(Buffer.from(image.bytes).toString(), "image");
});

const sse = (...events: object[]) =>
  new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  );

test("Codex stream parsing returns the finished image or a clear failure", async () => {
  const image = await readCodexImageStream(
    sse(
      { type: "response.created" },
      { type: "response.output_item.done", item: { type: "message" } },
      {
        type: "response.output_item.done",
        item: {
          type: "image_generation_call",
          result: Buffer.from("png-bytes").toString("base64"),
          revised_prompt: "refined",
        },
      },
    ),
  );
  assert.equal(Buffer.from(image.bytes).toString(), "png-bytes");
  assert.equal(image.revisedPrompt, "refined");
  await assert.rejects(
    readCodexImageStream(
      sse({
        type: "response.failed",
        response: { error: { message: "policy" } },
      }),
    ),
    /图片生成失败：policy/u,
  );
  await assert.rejects(
    readCodexImageStream(sse({ type: "response.completed" })),
    /没有生成图片/u,
  );
});

test("GPT image service sends one Codex request with the size, saves a previewable file and registers the asset", async () => {
  const root = await mkdtemp(join(tmpdir(), "aura-gpt-image-"));
  try {
    const png = await sharp({
      create: { width: 32, height: 48, channels: 3, background: "#8052EA" },
    })
      .png()
      .toBuffer();
    const bodies: Array<Record<string, unknown>> = [];
    const service = new GptImageService({
      request: async (body) => {
        bodies.push(body);
        return sse({
          type: "response.output_item.done",
          item: {
            type: "image_generation_call",
            result: png.toString("base64"),
          },
        });
      },
      signedIn: async () => true,
      artifacts: new GeneratedArtifacts(join(root, "store")),
      outputRoot: join(root, "outputs"),
    });
    assert.equal(await service.available(), true);
    const result = await service.generate(
      { prompt: "竖图灯塔", aspect: "portrait" },
      AbortSignal.timeout(5000),
    );
    assert.equal(bodies.length, 1);
    assert.deepEqual(bodies[0]!.tools, [
      { type: "image_generation", output_format: "png", size: "1024x1536" },
    ]);
    assert.match(bodies[0]!.input[0].content[0].text, /竖图.*\n竖图灯塔/su);
    assert.equal(result.width, 32);
    assert.equal(result.height, 48);
    assert.match(result.imageAssetId, /^[a-f0-9]{64}$/u);
    assert.ok(result.files[0]!.startsWith(join(root, "outputs")));
    assert.deepEqual(await readFile(result.files[0]!), png);

    const expired = new GptImageService({
      request: async () => new Response("", { status: 401 }),
      signedIn: async () => true,
      artifacts: new GeneratedArtifacts(join(root, "store")),
      outputRoot: root,
    });
    await assert.rejects(
      expired.generate(
        { prompt: "x", aspect: "square" },
        AbortSignal.timeout(1000),
      ),
      /登录已失效/u,
    );
    const limited = new GptImageService({
      request: async () => new Response("", { status: 429 }),
      signedIn: async () => true,
      artifacts: new GeneratedArtifacts(join(root, "store")),
      outputRoot: root,
    });
    await assert.rejects(
      limited.generate(
        { prompt: "x", aspect: "square" },
        AbortSignal.timeout(1000),
      ),
      /额度已达上限/u,
    );
    let sent = 0;
    const lost = new GptImageService({
      request: async () => {
        sent++;
        throw new Error("network");
      },
      signedIn: async () => true,
      artifacts: new GeneratedArtifacts(join(root, "store")),
      outputRoot: root,
    });
    await assert.rejects(
      lost.generate(
        { prompt: "x", aspect: "square" },
        AbortSignal.timeout(1000),
      ),
      /无法连接 Codex/u,
    );
    assert.equal(sent, 1);
    const unknown = new GptImageService({
      request: async () => {
        throw new Error("x");
      },
      signedIn: async () => {
        throw new Error("store down");
      },
      artifacts: new GeneratedArtifacts(join(root, "store")),
      outputRoot: root,
    });
    assert.equal(await unknown.available(), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
