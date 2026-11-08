import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import {
  GPT_IMAGE_CAPABILITY,
  GptImageService,
  gptImageCapability,
} from "../src/gpt-image.ts";
import { GeneratedArtifacts } from "../src/artifacts/generated.ts";
import type { FlowImageReference } from "../src/flow-api.ts";

const signal = () => AbortSignal.timeout(10_000);
const input = {
  prompt: "保留人物特征，转成轻动漫风",
  aspect: "portrait" as const,
};

async function fixture(
  t: TestContext,
  readAttachment?: (
    reference: FlowImageReference,
    signal: AbortSignal,
  ) => Promise<Uint8Array>,
) {
  const root = await mkdtemp(join(tmpdir(), "aura-image-references-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const png = await sharp({
    create: { width: 24, height: 36, channels: 4, background: "#d4375580" },
  })
    .png()
    .toBuffer();
  const artifacts = new GeneratedArtifacts(join(root, "store"));
  const bodies: Array<Record<string, unknown>> = [];
  const service = new GptImageService({
    signedIn: async () => true,
    artifacts,
    readAttachment,
    outputRoot: join(root, "outputs"),
    request: async (body) => {
      bodies.push(body);
      // Synthetic provider response: these tests never call the live Codex API.
      return new Response(
        `data: ${JSON.stringify({
          type: "response.output_item.done",
          item: {
            type: "image_generation_call",
            result: png.toString("base64"),
          },
        })}\n\n`,
      );
    },
  });
  return { root, png, artifacts, bodies, service };
}

function attachment(bytes: number): FlowImageReference {
  return {
    attachmentId: `sha256:${"b".repeat(64)}`,
    mediaType: "image/png",
    bytes,
    width: 24,
    height: 36,
    name: "人物参考",
  };
}

async function imagePart(bytes: Uint8Array) {
  const normalized = await sharp(bytes).rotate().png().toBuffer();
  return {
    type: "input_image",
    image_url: `data:image/png;base64,${normalized.toString("base64")}`,
    detail: "high",
  };
}

test("Codex receives asset and chat reference pixels in order in one image request", async (t) => {
  const seen: FlowImageReference[] = [];
  const { png, artifacts, bodies, service } = await fixture(
    t,
    async (ref, stop) => {
      stop.throwIfAborted();
      seen.push(ref);
      return chatBytes;
    },
  );
  const chatBytes = await sharp(png).webp().toBuffer();
  const jpeg = await sharp(png)
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const asset = await artifacts.registerImage(jpeg, signal());
  const ref = {
    ...attachment(chatBytes.length),
    mediaType: "image/webp" as const,
  };
  const references = [asset.artifactId, ref];
  const result = await gptImageCapability(service).invoke(
    GPT_IMAGE_CAPABILITY,
    "generate",
    { ...input, quality: "high", referenceImages: references },
    signal(),
  );
  assert.deepEqual(seen, [ref]);
  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0]!.input, [
    {
      role: "user",
      content: [
        { type: "input_text", text: `画幅：竖图（2:3）。\n${input.prompt}` },
        await imagePart(jpeg),
        await imagePart(chatBytes),
      ],
    },
  ]);
  assert.deepEqual(bodies[0]!.tools, [
    {
      type: "image_generation",
      output_format: "png",
      size: "1024x1536",
      quality: "high",
    },
  ]);
  assert.equal(bodies[0]!.model, undefined);
  assert.equal(result.model, "codex-image");
  assert.doesNotMatch(JSON.stringify(result), /data:image|base64/u);
  assert.deepEqual(references, [asset.artifactId, ref]);
  const rotated = await sharp(jpeg).rotate().png().toBuffer();
  assert.equal((await sharp(rotated).metadata()).width, 36);
});

test("PNG and GIF chat attachments are decoded into PNG inputs with alpha retained", async (t) => {
  let stored: Buffer;
  const { service, bodies, png } = await fixture(t, async () => stored);
  for (const format of ["png", "gif"] as const) {
    stored = await sharp(png).toFormat(format).toBuffer();
    await service.generate(
      {
        ...input,
        referenceImages: [
          { ...attachment(stored.length), mediaType: `image/${format}` },
        ],
      },
      signal(),
    );
    assert.deepEqual(bodies.at(-1)!.input, [
      {
        role: "user",
        content: [
          { type: "input_text", text: `画幅：竖图（2:3）。\n${input.prompt}` },
          await imagePart(stored),
        ],
      },
    ]);
  }
  assert.equal((await sharp(png).metadata()).hasAlpha, true);
});

test("Image capability rejects paths, URLs, inline payloads and malformed or excessive references before dispatch", async () => {
  let calls = 0;
  const capability = gptImageCapability({
    available: async () => true,
    generate: async () => {
      calls++;
      throw new Error("must not dispatch");
    },
  });
  const invalid = [
    ["F:\\private\\photo.png"],
    ["https://example.com/photo.png"],
    ["data:image/png;base64,cGl4ZWxz"],
    ["a".repeat(63)],
    ["A".repeat(64)],
    Array(5).fill("a".repeat(64)),
    [{ ...attachment(10), attachmentId: "../../private" }],
    [{ ...attachment(10), bytes: 0 }],
    [{ ...attachment(10), width: 20_000 }],
    [{ ...attachment(10), url: "https://example.com/photo.png" }],
  ];
  for (const referenceImages of invalid) {
    await assert.rejects(
      capability.invoke(
        GPT_IMAGE_CAPABILITY,
        "generate",
        { ...input, referenceImages },
        signal(),
      ),
      /codex_image_input/u,
    );
  }
  assert.equal(calls, 0);
});

test("Direct image service calls validate the same reference limits before reading images", async (t) => {
  let reads = 0;
  const { service, bodies } = await fixture(t, async () => {
    reads++;
    return Buffer.from("unused");
  });
  await assert.rejects(
    service.generate(
      { ...input, referenceImages: Array(5).fill(attachment(10)) },
      signal(),
    ),
    /codex_image_input/u,
  );
  assert.equal(reads, 0);
  assert.equal(bodies.length, 0);
});

test("Missing or changed assets fail locally without silently sending a text-only request", async (t) => {
  const { service, artifacts, png, bodies, root } = await fixture(t);
  await assert.rejects(
    service.generate({ ...input, referenceImages: ["a".repeat(64)] }, signal()),
    /codex_image_reference/u,
  );
  const registered = await artifacts.registerImage(png, signal());
  await writeFile(
    join(root, "store", `${registered.artifactId}.png`),
    "changed",
  );
  await assert.rejects(
    service.generate(
      { ...input, referenceImages: [registered.artifactId] },
      signal(),
    ),
    /codex_image_reference/u,
  );
  await assert.rejects(
    service.generate({ ...input, referenceImages: [attachment(10)] }, signal()),
    /codex_image_reference/u,
  );
  assert.equal(bodies.length, 0);
});

test("Reference lookup failures never expose private paths or upstream details", async (t) => {
  const { service, bodies } = await fixture(t, async () => {
    throw new Error("private F:\\secret\\file.png token=credential");
  });
  await assert.rejects(
    service.generate({ ...input, referenceImages: [attachment(10)] }, signal()),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /codex_image_reference/u);
      assert.doesNotMatch(error.message, /private|secret|credential/u);
      assert.equal(error.cause, undefined);
      return true;
    },
  );
  assert.equal(bodies.length, 0);
});

test("Invalid rasters and unsupported formats are rejected before Codex is called", async (t) => {
  let stored = Buffer.from("not an image");
  const { service, bodies } = await fixture(t, async () => stored);
  for (const bytes of [
    stored,
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>',
    ),
  ]) {
    stored = bytes;
    await assert.rejects(
      service.generate(
        { ...input, referenceImages: [attachment(1)] },
        signal(),
      ),
      /codex_image_reference/u,
    );
  }
  assert.equal(bodies.length, 0);
});

test("Reference size limits use actual bytes and include all images instead of trusting attachment metadata", async (t) => {
  let stored: Buffer;
  const { service, bodies, png } = await fixture(t, async () => stored);
  stored = Buffer.alloc(32 * 1024 * 1024 + 1);
  await assert.rejects(
    service.generate({ ...input, referenceImages: [attachment(1)] }, signal()),
    /codex_image_reference/u,
  );
  // A valid PNG with trailing bytes keeps each input below the per-message cap.
  stored = Buffer.concat([png, Buffer.alloc(17 * 1024 * 1024)]);
  await assert.rejects(
    service.generate(
      { ...input, referenceImages: [attachment(1), attachment(1)] },
      signal(),
    ),
    /codex_image_reference/u,
  );
  assert.equal(bodies.length, 0);
});

test("Cancellation before or during reference reads prevents a Codex request and preserves the abort reason", async (t) => {
  const controller = new AbortController();
  const reason = new Error("cancelled by user");
  let reads = 0;
  const { service, bodies, png } = await fixture(t, async () => {
    reads++;
    controller.abort(reason);
    return png;
  });
  const request = { ...input, referenceImages: [attachment(png.length)] };
  await assert.rejects(
    service.generate(request, controller.signal),
    (error: unknown) => error === reason,
  );
  assert.equal(reads, 1);
  await assert.rejects(
    service.generate(request, controller.signal),
    (error: unknown) => error === reason,
  );
  assert.equal(reads, 1);
  assert.equal(bodies.length, 0);
});
