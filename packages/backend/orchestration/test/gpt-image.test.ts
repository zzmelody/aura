import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import imageAction from "../action/image-generate/image-generate.action.js";
import {
  GptImageService,
  readCodexImageStream,
  type GptImageClient,
} from "../src/gpt-image.ts";
import { GeneratedArtifacts } from "../src/generated-artifacts.ts";

type Execute = (
  ctx: Record<string, unknown>,
  input: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

async function action(): Promise<Execute> {
  let execute: Execute | undefined;
  await (imageAction as unknown as {
    apply(ctx: unknown, config: unknown): Promise<void>;
  }).apply(
    {
      auraActionRegistry: {
        async register(
          _config: unknown,
          registration: {
            tool(
              name: string,
              binding: unknown,
            ): {
              execute(
                input: unknown,
                exec: { callId: string; signal: AbortSignal },
              ): Promise<unknown>;
            };
          },
        ) {
          execute = (ctx, input) =>
            registration
              .tool("image_generate", ctx)
              .execute(input, {
                callId: "call",
                signal: new AbortController().signal,
              }) as Promise<Record<string, unknown>>;
        },
      },
    },
    { actionId: "image-generate", directory: ".", entry: "image-generate.action.js" },
  );
  assert(execute);
  return execute;
}

const local = (calls: unknown[]) => ({
  async image(input: unknown) {
    calls.push(input);
    return {
      service: "qwen-image",
      seed: 3,
      files: ["local.png"],
      imageAssetId: "b".repeat(64),
    };
  },
});
const gpt = (signedIn: boolean, calls: unknown[]): GptImageClient => ({
  async available() {
    return signedIn;
  },
  async generate(input) {
    calls.push(input);
    return {
      service: "codex-image",
      model: "codex-image",
      files: ["gpt.png"],
      imageAssetId: "c".repeat(64),
      width: 1024,
      height: 1536,
      revisedPrompt: "a lighthouse",
    };
  },
});

test("image action prefers GPT via Codex and falls back to the local model when signed out", async () => {
  const execute = await action();
  const gptCalls: unknown[] = [];
  const localCalls: unknown[] = [];
  const preferred = await execute(
    { gptImage: gpt(true, gptCalls), localAI: local(localCalls) },
    { prompt: "海边灯塔", aspect: "portrait" },
  );
  assert.equal(preferred.engine, "gpt");
  assert.equal(preferred.revisedPrompt, "a lighthouse");
  assert.deepEqual(gptCalls, [{ prompt: "海边灯塔", aspect: "portrait" }]);
  assert.equal(localCalls.length, 0);

  const fallback = await execute(
    { gptImage: gpt(false, gptCalls), localAI: local(localCalls) },
    { prompt: "海边灯塔", aspect: "portrait" },
  );
  assert.equal(fallback.engine, "local");
  assert.match(String(fallback.fallbackReason), /未登录 Codex/u);
  assert.deepEqual(localCalls[0], { prompt: "海边灯塔", width: 864, height: 1152 });

  const forcedLocal = await execute(
    { gptImage: gpt(true, gptCalls), localAI: local(localCalls) },
    { prompt: "x", engine: "local" },
  );
  assert.equal(forcedLocal.engine, "local");
  assert.equal(forcedLocal.fallbackReason, undefined);
  assert.equal(gptCalls.length, 1);

  await assert.rejects(
    execute(
      { gptImage: gpt(false, gptCalls), localAI: local(localCalls) },
      { prompt: "x", engine: "gpt" },
    ),
    /请先在右上角登录 Codex/u,
  );
});

test("a failed GPT request never silently falls back to another engine", async () => {
  const execute = await action();
  const localCalls: unknown[] = [];
  await assert.rejects(
    execute(
      {
        gptImage: {
          async available() {
            return true;
          },
          async generate() {
            throw new Error("result unknown");
          },
        },
        localAI: local(localCalls),
      },
      { prompt: "x" },
    ),
    /result unknown/u,
  );
  assert.equal(localCalls.length, 0);
});

const sse = (...events: object[]) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

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
    readCodexImageStream(sse({ type: "response.failed", response: { error: { message: "policy" } } })),
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
    const bodies: Record<string, any>[] = [];
    const service = new GptImageService({
      request: async (body) => {
        bodies.push(body);
        return sse({
          type: "response.output_item.done",
          item: { type: "image_generation_call", result: png.toString("base64") },
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
      expired.generate({ prompt: "x", aspect: "square" }, AbortSignal.timeout(1000)),
      /登录已失效/u,
    );
    const limited = new GptImageService({
      request: async () => new Response("", { status: 429 }),
      signedIn: async () => true,
      artifacts: new GeneratedArtifacts(join(root, "store")),
      outputRoot: root,
    });
    await assert.rejects(
      limited.generate({ prompt: "x", aspect: "square" }, AbortSignal.timeout(1000)),
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
      lost.generate({ prompt: "x", aspect: "square" }, AbortSignal.timeout(1000)),
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
