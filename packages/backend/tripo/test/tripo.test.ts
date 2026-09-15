import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTripoService, TripoNotConfiguredError } from "@aura/tripo";

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
