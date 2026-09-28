import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TripoTimeoutError } from "@vastai/tripo-sdk";
import {
  createTripoService,
  TripoGameAssetError,
  TripoNotConfiguredError,
  type TripoGameAssetResult,
  type TripoPaidTaskJournal,
} from "@aura/tripo";

test("Tripo remains available but disabled when no backend key exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "aura-tripo-empty-"));
  const service = await createTripoService({
    credentialPath: join(root, "api-key"),
    region: "global",
  });

  assert.deepEqual(service.status(), {
    configured: false,
    region: "global",
    apiVersion: "v3",
    features: ["text-to-model", "image-to-model", "task-status"],
  });
  await assert.rejects(
    service.textToModel({ prompt: "a small cat" }),
    TripoNotConfiguredError,
  );
});

test("Tripo uses the ignored credential file and sanitizes task output", async () => {
  const root = await mkdtemp(join(tmpdir(), "aura-tripo-key-"));
  const credentialPath = join(root, ".aura", "tripo", "api-key");
  await mkdir(join(root, ".aura", "tripo"), { recursive: true });
  await writeFile(credentialPath, "tsk_secret-test\n", { mode: 0o600 });
  const calls: unknown[] = [];
  const service = await createTripoService({
    credentialPath,
    region: "china",
    clientFactory(apiKey, baseUrl) {
      assert.equal(apiKey, "tsk_secret-test");
      assert.equal(baseUrl, "https://openapi.tripo3d.com/v3");
      return {
        async uploadFile() {
          throw new Error("not used");
        },
        async textToImage() {
          throw new Error("not used");
        },
        async imageToImage() {
          throw new Error("not used");
        },
        async multiviewToModel() {
          throw new Error("not used");
        },
        async waitForTask() {
          throw new Error("not used");
        },
        async textToModel(input) {
          calls.push(input);
          return "task-text";
        },
        async imageToModel(input) {
          calls.push(input);
          return "task-image";
        },
        async getTask(taskId) {
          assert.equal(taskId, "task-text");
          return {
            task_id: taskId,
            type: "text_to_model",
            status: "success",
            progress: 100,
            create_time: 1_725_000_000,
            input: { prompt: "must not cross the boundary" },
            output: {
              model_url: "https://cdn.example/model.glb?signature=temporary",
              rendered_image_url: "javascript:alert(1)",
              undocumented: "not public",
            },
          };
        },
      };
    },
  });

  assert.equal(
    await service.textToModel({
      prompt: "a game-ready cat",
      negativePrompt: "blurry",
      faceLimit: 3_000,
      texture: true,
    }),
    "task-text",
  );
  assert.deepEqual(calls, [
    {
      prompt: "a game-ready cat",
      negative_prompt: "blurry",
      model: undefined,
      texture: true,
      pbr: undefined,
      face_limit: 3_000,
      texture_quality: undefined,
      geometry_quality: undefined,
      quad: undefined,
      generate_parts: undefined,
    },
  ]);
  assert.deepEqual(await service.getTask("task-text"), {
    taskId: "task-text",
    type: "text_to_model",
    status: "success",
    progress: 100,
    createdAt: 1_725_000_000_000,
    output: {
      modelUrl: "https://cdn.example/model.glb?signature=temporary",
      modelUrls: undefined,
      baseModelUrl: undefined,
      pbrModelUrl: undefined,
      renderedImageUrl: undefined,
      riggable: undefined,
      rigType: undefined,
    },
    error: undefined,
  });
});

test("Tripo calls the official v3 SDK with backend-only bearer auth", async () => {
  let requestUrl = "";
  let authorization = "";
  let payload: unknown;
  const service = await createTripoService({
    credentialPath: join(tmpdir(), "missing-aura-tripo-key"),
    region: "global",
    apiKey: "tsk_sdk-test",
    async fetch(input, init) {
      requestUrl = String(input);
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      payload = JSON.parse(String(init?.body));
      return Response.json({ code: 0, data: { task_id: "task-sdk" } });
    },
  });

  assert.equal(
    await service.textToModel({ prompt: "a brass compass", pbr: true }),
    "task-sdk",
  );
  assert.equal(
    requestUrl,
    "https://openapi.tripo3d.ai/v3/generation/text-to-model",
  );
  assert.equal(authorization, "Bearer tsk_sdk-test");
  assert.deepEqual(payload, { prompt: "a brass compass", pbr: true });
});

test("Tripo generates four GPT Image 2.5 views and publishes a game GLB", async () => {
  const root = await mkdtemp(join(tmpdir(), "aura-tripo-game-"));
  const outputRoot = join(root, "assets", "generated");
  const calls: Array<{ method: string; input: unknown }> = [];
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
  const glb = Uint8Array.from([
    0x67, 0x6c, 0x54, 0x46, 0x02, 0x00, 0x00, 0x00, 0x0c, 0x00, 0x00, 0x00,
  ]);
  const taskIds = ["image-left", "image-back", "image-right"];

  try {
    const service = await createTripoService({
      credentialPath: join(root, "missing-key"),
      region: "global",
      apiKey: "tsk_game-test",
      async fetch(input) {
        const url = String(input);
        if (url.endsWith("model.glb")) return new Response(glb);
        if (url.endsWith("preview.jpg")) return new Response(jpeg);
        return new Response(png);
      },
      clientFactory() {
        return {
          async uploadFile() {
            throw new Error("not used");
          },
          async textToImage(input) {
            calls.push({ method: "textToImage", input });
            return "image-front";
          },
          async imageToImage(input) {
            calls.push({ method: "imageToImage", input });
            return taskIds.shift()!;
          },
          async multiviewToModel(input) {
            calls.push({ method: "multiviewToModel", input });
            return "model-task";
          },
          async waitForTask(taskId, options) {
            calls.push({
              method: "waitForTask",
              input: { taskId, timeoutMs: options?.timeoutMs },
            });
            return taskId === "model-task"
              ? {
                  task_id: taskId,
                  type: "multiview_to_model",
                  status: "success",
                  credits_consumed: 20,
                  output: {
                    model_url: "https://cdn.example/model.glb",
                    rendered_image_url: "https://cdn.example/preview.jpg",
                  },
                }
              : {
                  task_id: taskId,
                  type: "image_to_image",
                  status: "success",
                  credits_consumed: 2,
                  output: {
                    generated_image_url: `https://cdn.example/${taskId}.png`,
                  },
                };
          },
          async textToModel() {
            throw new Error("not used");
          },
          async imageToModel() {
            throw new Error("not used");
          },
          async getTask() {
            throw new Error("not used");
          },
        };
      },
    });

    let published: TripoGameAssetResult | undefined;
    const submitted = new Map<string, string>();
    const journal: TripoPaidTaskJournal = {
      workId: "observatory-test",
      async prepare(stage) { return submitted.get(stage); },
      async submitted(stage, taskId) { submitted.set(stage, taskId); },
      async completed() {},
      async result() { return published; },
      async published(result) { published = result; },
    };
    const request = {
        prompt: "A compact brass observatory robot",
        outputDirectory: outputRoot,
        assetName: "observatory-robot",
        faceLimit: 12_000,
      };
    const result = await service.generateGameAsset(
      request,
      new AbortController().signal,
      journal,
    );
    const callsAfterPublication = calls.length;
    assert.deepEqual(await service.generateGameAsset(request, new AbortController().signal, journal), result);
    assert.equal(calls.length, callsAfterPublication, "a recovered published result must not resubmit paid work");

    assert.match(result.outputDirectory, /observatory-robot-model-task$/u);
    assert.equal(result.imageModel, "chat_image_2.5_sunburst");
    assert.equal(result.modelVersion, "P1-20260311");
    assert.equal(result.creditsConsumed, 28);
    assert.deepEqual(new Uint8Array(await readFile(result.modelPath)), glb);
    for (const path of Object.values(result.imagePaths))
      assert.equal((await stat(path)).size, png.byteLength);
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    assert.equal(manifest.model.faceLimit, 12_000);
    assert.equal(manifest.inputMode, "text-to-image");
    assert.equal(
      calls.filter(({ method }) => method === "textToImage").length,
      1,
    );
    assert.equal(
      calls.filter(({ method }) => method === "imageToImage").length,
      3,
    );
    assert.deepEqual(
      calls
        .filter(({ method }) => method === "waitForTask")
        .map(({ input }) => input),
      [
        { taskId: "image-front", timeoutMs: 90_000 },
        { taskId: "image-left", timeoutMs: 90_000 },
        { taskId: "image-back", timeoutMs: 90_000 },
        { taskId: "image-right", timeoutMs: 90_000 },
        { taskId: "model-task", timeoutMs: 120_000 },
      ],
    );
    const modelCall = calls.find(({ method }) => method === "multiviewToModel");
    assert.deepEqual(modelCall?.input, {
      inputs: [
        "https://cdn.example/image-front.png",
        "https://cdn.example/image-left.png",
        "https://cdn.example/image-back.png",
        "https://cdn.example/image-right.png",
      ],
      model: "P1-20260311",
      face_limit: 12_000,
      texture: true,
      pbr: true,
      texture_alignment: "original_image",
      texture_quality: "standard",
      auto_size: true,
      export_uv: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Tripo exposes the exact product stage when a generated view times out", async () => {
  const root = await mkdtemp(join(tmpdir(), "aura-tripo-stage-error-"));
  const outputRoot = join(root, "assets", "generated");

  try {
    const service = await createTripoService({
      credentialPath: join(root, "missing-key"),
      region: "global",
      apiKey: "tsk_stage-test",
      clientFactory() {
        return {
          async uploadFile() {
            throw new Error("not used");
          },
          async textToImage() {
            return "image-front";
          },
          async imageToImage() {
            return "image-left";
          },
          async multiviewToModel() {
            throw new Error("model generation must not start");
          },
          async waitForTask(taskId) {
            if (taskId === "image-left") {
              const timeout = new TripoTimeoutError(taskId);
              Object.assign(timeout, { taskId, timeoutMs: 90_000 });
              throw timeout;
            }
            return {
              task_id: taskId,
              type: "text_to_image",
              status: "success",
              output: {
                generated_image_url: "https://cdn.example/front.png",
              },
            };
          },
          async textToModel() {
            throw new Error("not used");
          },
          async imageToModel() {
            throw new Error("not used");
          },
          async getTask() {
            throw new Error("not used");
          },
        };
      },
    });

    await assert.rejects(
      service.generateGameAsset(
        {
          prompt: "A walkable stone chapel",
          outputDirectory: outputRoot,
          imageQuality: "high",
        },
        new AbortController().signal,
      ),
      (error: unknown) => {
        assert.ok(error instanceof TripoGameAssetError);
        assert.equal(error.stage, "generate-left");
        assert.equal(error.reason, "timeout");
        assert.equal(
          error.message,
          "模型生成未完成 · 生成左视图：等待超过 90 秒，任务可能仍在 Tripo 后台处理。请勿立即重复提交，以免重复计费。",
        );
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Tripo accepts an optional local reference without exposing its path upstream", async () => {
  const root = await mkdtemp(join(tmpdir(), "aura-tripo-reference-"));
  const referencePath = join(root, "reference.png");
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const glb = Uint8Array.from([
    0x67, 0x6c, 0x54, 0x46, 0x02, 0x00, 0x00, 0x00, 0x0c, 0x00, 0x00, 0x00,
  ]);
  await writeFile(referencePath, png);
  const imageInputs: unknown[] = [];
  const imageIds = ["front", "left", "back", "right"];

  try {
    const service = await createTripoService({
      credentialPath: join(root, "missing-key"),
      region: "global",
      apiKey: "tsk_reference-test",
      async fetch(input) {
        return String(input).endsWith("model.glb")
          ? new Response(glb)
          : new Response(png);
      },
      clientFactory() {
        return {
          async uploadFile(bytes, options) {
            assert.deepEqual([...bytes], [...png]);
            assert.deepEqual(options, {
              filename: "reference.png",
              contentType: "image/png",
            });
            return { file_token: "file-reference" };
          },
          async textToImage() {
            throw new Error("reference mode must not call textToImage");
          },
          async imageToImage(input) {
            imageInputs.push(input);
            return imageIds.shift()!;
          },
          async multiviewToModel() {
            return "model";
          },
          async waitForTask(taskId) {
            return taskId === "model"
              ? {
                  task_id: taskId,
                  type: "multiview_to_model",
                  status: "success",
                  output: { model_url: "https://cdn.example/model.glb" },
                }
              : {
                  task_id: taskId,
                  type: "image_to_image",
                  status: "success",
                  output: {
                    generated_image_url: `https://cdn.example/${taskId}.png`,
                  },
                };
          },
          async textToModel() {
            throw new Error("not used");
          },
          async imageToModel() {
            throw new Error("not used");
          },
          async getTask() {
            throw new Error("not used");
          },
        };
      },
    });

    const result = await service.generateGameAsset(
      {
        prompt: "A ceramic fox mask",
        referenceImagePath: referencePath,
        outputDirectory: join(root, "output"),
      },
      new AbortController().signal,
    );

    assert.equal(imageInputs.length, 4);
    assert.equal((imageInputs[0] as { input: string }).input, "file-reference");
    assert.equal((imageInputs[1] as { input: string }).input, "front");
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    assert.equal(manifest.inputMode, "image-to-image");
    assert.doesNotMatch(JSON.stringify(manifest), /reference\.png/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
