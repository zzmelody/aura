import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Context } from "@deepseek-ai/cordis";
import { GeneratedArtifacts } from "../src/generated-artifacts.ts";
import {
  VeyaWorldAgentCapability,
  VEYA_WORLD_AGENT_CAPABILITY,
} from "../src/veya-world-agent.ts";
import { imagePromptParts } from "../src/sessions.ts";
import { agentRequestSchema } from "../src/schema.ts";
import { TripoGameAssetCapability } from "../src/tripo-game-asset.ts";
import type { TripoGameAssetResult } from "@aura/tripo";

const signal = new AbortController().signal;
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const ref = {
  attachmentId: "sha256:" + "a".repeat(64),
  mediaType: "image/png" as const,
  bytes: png.length,
  width: 1,
  height: 1,
};
const glb = () => {
  const b = Buffer.alloc(24);
  b.write("glTF");
  b.writeUInt32LE(2, 4);
  b.writeUInt32LE(24, 8);
  b.writeUInt32LE(4, 12);
  b.writeUInt32LE(0x4e4f534a, 16);
  b.write("{}  ", 20);
  return b;
};
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "aura-veya-media-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("registered models persist across hosts; IDs are immutable and arbitrary paths cannot be staged", () =>
  fixture(async (root) => {
    const source = join(root, "model.glb"),
      store = join(root, "store"),
      exchange = join(root, "exchange");
    await writeFile(source, glb());
    const artifact = await new GeneratedArtifacts(store).registerModel(
      source,
      signal,
    );
    assert.equal(
      artifact.sha256,
      createHash("sha256").update(glb()).digest("hex"),
    );
    const reopened = new GeneratedArtifacts(store);
    await reopened.stageModel(artifact.artifactId, exchange, signal);
    await reopened.stageModel(artifact.artifactId, exchange, signal);
    assert.deepEqual(
      await readFile(join(exchange, `${artifact.artifactId}.glb`)),
      glb(),
    );
    await assert.rejects(
      reopened.stageModel(source, exchange, signal),
      /invalid_artifact_id/,
    );
    await assert.rejects(reopened.stageModel("b".repeat(64), exchange, signal));
    await writeFile(
      join(store, `${artifact.artifactId}.glb`),
      Buffer.alloc(24),
    );
    await assert.rejects(
      reopened.stageModel(artifact.artifactId, exchange, signal),
      /artifact_hash_mismatch/,
    );
    await assert.rejects(
      reopened.registerModel(join(store, `${artifact.artifactId}.glb`), signal),
      /invalid_model_artifact/,
    );
  }));

test("successful model production returns a registered model reference without changing legacy result fields", () =>
  fixture(async (root) => {
    const modelPath = join(root, "model.glb");
    await writeFile(modelPath, glb());
    const service = new TripoGameAssetCapability(
      {
        generateGameAsset: async () =>
          ({ modelPath, creditsConsumed: 42 }) as TripoGameAssetResult,
      },
      new GeneratedArtifacts(join(root, "store")),
    );
    const result = (await service.invoke(
      "aura.tripo.game-asset",
      "generate",
      { prompt: "fixture", outputDirectory: root },
      signal,
    )) as Record<string, any>;
    assert.equal(result.modelPath, modelPath);
    assert.equal(result.creditsConsumed, 42);
    assert.equal(result.modelArtifact.bytes, 24);
    assert.equal(result.modelArtifact.format, "glb");
  }));

test("import stages only a known artifact to the descriptor-bound exchange and preserves canonical HTTP arguments", () =>
  fixture(async (root) => {
    const artifacts = new GeneratedArtifacts(join(root, "store"));
    const source = join(root, "source.glb");
    await writeFile(source, glb());
    const artifact = await artifacts.registerModel(source, signal);
    const session = join(root, "session.json"),
      exchange = join(root, "exchange");
    await writeFile(
      session,
      JSON.stringify({
        protocol: "veya-world-http/1",
        tools_protocol: "veya-agent-tools/1",
        token: "a".repeat(64),
        base_url: "http://127.0.0.1:12345",
        exchange_root: exchange,
      }),
    );
    let calls = 0;
    const client = new VeyaWorldAgentCapability(
      session,
      (async (_url, init) => {
        calls++;
        assert.deepEqual(
          await readFile(join(exchange, `${artifact.artifactId}.glb`)),
          glb(),
        );
        assert.deepEqual(JSON.parse(String(init?.body)), {
          tool: "veya.assets.import",
          arguments: {
            artifact_id: artifact.artifactId,
            request_id: "request",
          },
        });
        return Response.json({
          ok: true,
          data: { operation_id: "cook", status: "queued" },
        });
      }) as typeof fetch,
      {
        artifacts,
        attachments: {
          saveImage: async () => {
            throw new Error("not image");
          },
        },
      },
    );
    const result = await client.invoke(
      VEYA_WORLD_AGENT_CAPABILITY,
      "veya.assets.import",
      { artifact_id: artifact.artifactId, request_id: "request" },
      signal,
    );
    assert.equal((result as any).status, "queued");
    assert.equal(calls, 1);
    await assert.rejects(
      client.invoke(
        VEYA_WORLD_AGENT_CAPABILITY,
        "veya.assets.import",
        { artifact_id: source },
        signal,
      ),
    );
    assert.equal(calls, 1);
  }));

test("Veya binds the default output root, explicit user output wins, and registration failure preserves paid output", () =>
  fixture(async (root) => {
    const paths: string[] = [],
      modelPath = join(root, "bad.glb");
    await writeFile(modelPath, "invalid model fixture");
    const service = new TripoGameAssetCapability(
      {
        generateGameAsset: async (input) => {
          paths.push(input.outputDirectory);
          assert.equal("useVeyaOutputDirectory" in input, false);
          return { modelPath, creditsConsumed: 42 } as TripoGameAssetResult;
        },
      },
      new GeneratedArtifacts(join(root, "store")),
      async () => join(root, "veya-writable"),
    );
    const first = (await service.invoke(
      "aura.tripo.game-asset",
      "generate",
      {
        prompt: "fixture",
        outputDirectory: root,
        useVeyaOutputDirectory: true,
      },
      signal,
    )) as any;
    assert.equal(first.modelPath, modelPath);
    assert.equal(first.creditsConsumed, 42);
    assert.equal(
      first.artifactRegistration.code,
      "artifact_registration_failed",
    );
    assert.equal(first.modelArtifact, undefined);
    await service.invoke(
      "aura.tripo.game-asset",
      "generate",
      { prompt: "fixture", outputDirectory: root },
      signal,
    );
    assert.deepEqual(paths, [join(root, "veya-writable"), root]);
  }));

test("preview retries its frame barrier, verifies bytes, ignores arbitrary response paths and admits a durable attachment", () =>
  fixture(async (root) => {
    const previews = join(root, "previews");
    await mkdir(previews);
    const id = "c".repeat(32);
    await writeFile(join(previews, `${id}.png`), png);
    const session = join(root, "session.json");
    await writeFile(
      session,
      JSON.stringify({
        protocol: "veya-world-http/1",
        tools_protocol: "veya-agent-tools/1",
        token: "a".repeat(64),
        base_url: "http://127.0.0.1:12345",
        preview_root: previews,
      }),
    );
    let calls = 0,
      admissions = 0,
      corrupt = false;
    const client = new VeyaWorldAgentCapability(
      session,
      (async () => {
        if (++calls === 1)
          return Response.json(
            { ok: false, error: "preview_not_ready" },
            { status: 422 },
          );
        return Response.json({
          ok: true,
          data: {
            capture_id: id,
            screenshot: "C:/not-allowed/secret.png",
            mime_type: "image/png",
            bytes: png.length,
            sha256: corrupt
              ? "0".repeat(64)
              : createHash("sha256").update(png).digest("hex"),
          },
        });
      }) as typeof fetch,
      {
        artifacts: new GeneratedArtifacts(join(root, "store")),
        attachments: {
          saveImage: async (input) => {
            admissions++;
            assert.deepEqual(input.data, png);
            return ref as any;
          },
        },
      },
    );
    const capture = (await client.invoke(
      VEYA_WORLD_AGENT_CAPABILITY,
      "veya.preview.capture",
      {},
      signal,
    )) as any;
    assert.deepEqual(capture.image, ref);
    assert.equal(calls, 2);
    assert.equal(admissions, 1);
    corrupt = true;
    await assert.rejects(
      client.invoke(
        VEYA_WORLD_AGENT_CAPABILITY,
        "veya.preview.capture",
        {},
        signal,
      ),
      /preview_hash_mismatch/,
    );
    assert.equal(admissions, 1);
  }));

test("Agent image requests store only bounded refs and resolve verified pixels at the session boundary", async () => {
  const request = {
    id: "view",
    label: "view",
    preset: "test",
    prompt: "inspect",
    images: [ref],
  };
  assert.deepEqual(agentRequestSchema.parse(request).images, [ref]);
  assert.equal(
    agentRequestSchema.safeParse({
      ...request,
      images: [{ path: "secret.png" }],
    }).success,
    false,
  );
  assert.equal(
    agentRequestSchema.safeParse({ ...request, images: Array(5).fill(ref) })
      .success,
    false,
  );
  let reads = 0;
  const ctx = {
    attachments: {
      imageLimits: { maxImagesPerMessage: 4, maxMessageImageBytes: 1000 },
      readImage: async (image: unknown) => {
        assert.deepEqual(image, ref);
        reads++;
        return { ref, data: png };
      },
    },
  } as unknown as Pick<Context, "attachments">;
  const parts = await imagePromptParts(ctx, [ref], signal);
  assert.equal(reads, 1);
  assert.equal(parts[0].data, png.toString("base64"));
  await assert.rejects(
    imagePromptParts(ctx, [{ ...ref, bytes: 1001 }], signal),
    /上限/,
  );
});
