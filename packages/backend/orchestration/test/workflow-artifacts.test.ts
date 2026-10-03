import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { FlowRun } from "@aura/protocol/types";
import { GeneratedArtifacts } from "../src/generated-artifacts.ts";
import { WorkflowArtifactIndex } from "../src/workflow-artifacts.ts";
import { artifactResponse } from "../src/artifact-http.ts";
import { artifactCallBinding } from "../src/artifact-bindings.ts";
import { historicalArtifactReader } from "../src/artifact-history.ts";
import { selfContainedGlb } from "../src/artifact-media.ts";
import { createFlowApp } from "../src/index.ts";

function glb(extra: object = {}) {
  const json = JSON.stringify({
    asset: { version: "2.0" },
    scenes: [{ nodes: [] }],
    scene: 0,
    ...extra,
  });
  const data = Buffer.from(json.padEnd(Math.ceil(json.length / 4) * 4, " "));
  const header = Buffer.alloc(20);
  header.write("glTF");
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + data.length, 8);
  header.writeUInt32LE(data.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([header, data]);
}
const owner = { runId: "run", stepKey: "image", attempt: 1, callId: "call" };
const run = (id = "run", steps: FlowRun["steps"] = []): FlowRun => ({
  id,
  requestId: id,
  flow: { id: "test", title: "Test", description: "", sourceHash: "hash" },
  input: {},
  mode: "demo",
  status: "completed",
  createdAt: 1,
  steps,
});
async function fixture(
  work: (
    root: string,
    index: WorkflowArtifactIndex,
    store: GeneratedArtifacts,
  ) => Promise<void>,
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "aura-preview-")));
  const store = new GeneratedArtifacts(join(root, "store"));
  const index = new WorkflowArtifactIndex(store, root);
  index.attach((id) => {
    if (!["run", "other", "child"].includes(id)) throw new Error("Missing run");
    return run(id);
  });
  try {
    await work(root, index, store);
  } finally {
    await index.close();
    await rm(root, { recursive: true, force: true });
  }
}
async function png(path: string) {
  await writeFile(
    path,
    await sharp({
      create: { width: 32, height: 24, channels: 4, background: "#bda1ff" },
    })
      .png()
      .toBuffer(),
  );
}

test("images get bounded thumbnails; registrations survive restart and deduplicate concurrent calls without mutating output", () =>
  fixture(async (root, index, store) => {
    const image = join(root, "image.png");
    await png(image);
    const result = { service: "qwen-image", seed: 1, files: [image] };
    const saved = JSON.stringify(result);
    await Promise.all([
      index.capture(owner, result, "local-image"),
      index.capture({ ...owner, stepKey: "second" }, result, "local-image"),
    ]);
    assert.equal(JSON.stringify(result), saved);
    const reopened = new WorkflowArtifactIndex(store, root);
    reopened.attach((id) => run(id));
    const list = await reopened.list("run");
    await reopened.settle();
    assert.equal(list.artifacts.length, 2);
    assert.equal(list.artifacts[0].artifactId, list.artifacts[1].artifactId);
    const artifact = list.artifacts[0];
    assert.equal(artifact.status, "ready");
    assert.equal(artifact.width, 32);
    assert.equal(artifact.height, 24);
    assert.ok(artifact.thumbnailId);
    assert.ok(!JSON.stringify(list).includes(root));
    const thumbnail = await store.registerFile(
      join(store.root, `${artifact.thumbnailId}.webp`),
      AbortSignal.timeout(1000),
    );
    assert.equal(thumbnail.format, "webp");
    await rm(image);
    assert.equal(
      (await reopened.resolve("run", artifact.artifactId, false)).fileId,
      artifact.artifactId,
    );
    await assert.rejects(
      reopened.resolve("other", artifact.artifactId, false),
      /不存在/,
    );
    await assert.rejects(reopened.resolve("run", "../secret", false), /不存在/);
    await reopened.close();
  }));

test("GLB IDs remain compatible; malformed and external-resource models cannot preview but remain downloadable", () =>
  fixture(async (root, index, store) => {
    const path = join(root, "model.glb");
    await writeFile(path, glb());
    const existing = await store.registerModel(path, AbortSignal.timeout(1000));
    const artifact = (await index.register(owner, path))!;
    assert.equal(artifact.artifactId, existing.artifactId);
    assert.equal(artifact.status, "ready");
    const external = glb({
      images: [{ uri: "https://example.test/texture.png" }],
    });
    assert.equal(selfContainedGlb(external), false);
    assert.equal(
      selfContainedGlb(glb({ buffers: [{ uri: "../private.bin" }] })),
      false,
    );
    await writeFile(join(root, "external.glb"), external);
    const unsupported = (await index.register(
      owner,
      join(root, "external.glb"),
    ))!;
    assert.equal(unsupported.status, "unsupported");
    const descriptor = await index.resolve(
      "run",
      unsupported.artifactId,
      false,
    );
    await assert.rejects(
      artifactResponse(
        store.root,
        descriptor,
        new Request("http://aura/content"),
        false,
      ),
      /不支持/,
    );
    assert.equal(
      (
        await artifactResponse(
          store.root,
          descriptor,
          new Request("http://aura/content?download=1"),
          false,
        )
      ).status,
      200,
    );
    assert.equal(selfContainedGlb(Buffer.from("glTF")), false);
  }));

test("HTTP streams content/HEAD/ranges/ETags/download and denies changed bytes and symlinks", () =>
  fixture(async (root, index, store) => {
    const path = join(root, "model.glb");
    const bytes = glb();
    await writeFile(path, bytes);
    const artifact = (await index.register(owner, path))!;
    const descriptor = await index.resolve("run", artifact.artifactId, false);
    const request = (headers: Record<string, string> = {}, method = "GET") =>
      artifactResponse(
        store.root,
        descriptor,
        new Request("http://aura/content?download=1", { method, headers }),
        false,
      );
    const full = await request();
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);
    assert.equal(full.headers.get("content-type"), "model/gltf-binary");
    assert.match(full.headers.get("content-disposition")!, /^attachment/);
    const head = await request({}, "HEAD");
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    assert.equal(Number(head.headers.get("content-length")), bytes.length);
    const etag = full.headers.get("etag")!;
    assert.equal((await request({ "if-none-match": etag })).status, 304);
    const part = await request({ range: "bytes=0-3" });
    assert.equal(part.status, 206);
    assert.equal(await part.text(), "glTF");
    assert.equal(
      part.headers.get("content-range"),
      `bytes 0-3/${bytes.length}`,
    );
    const suffix = await request({ range: "bytes=-4" });
    assert.equal((await suffix.arrayBuffer()).byteLength, 4);
    for (const range of [
      "bytes=9999-",
      "bytes=1-0",
      "bytes=0-1,4-5",
      "bytes=-0",
    ])
      assert.equal((await request({ range })).status, 416);
    const ignored = await request({ range: "bytes=0-3", "if-range": '"old"' });
    assert.equal(ignored.status, 200);
    await ignored.arrayBuffer();
    await writeFile(
      join(store.root, `${artifact.artifactId}.glb`),
      Buffer.alloc(bytes.length),
    );
    await assert.rejects(request(), /不可用/);
    const linked = join(root, "linked.png");
    const original = join(root, "original.png");
    await png(original);
    await symlink(original, linked);
    assert.equal((await index.register(owner, linked))?.status, "unavailable");
  }));

test("history migration admits only managed Comfy paths, preserves missing files, resumes and retries without generation", () =>
  fixture(async (root, index, store) => {
    const directory = join(root, ".aura/local-ai/outputs/job-test/artifacts");
    await mkdir(directory, { recursive: true });
    const image = join(directory, "image.png"),
      missing = join(directory, "missing.png"),
      external = join(root, "private.png");
    await png(image);
    await png(external);
    const historical = run("run", [
      {
        id: "image",
        kind: "action",
        actionId: "local-image",
        input: {},
        output: { files: [image, missing, external] },
        status: "completed",
      },
    ]);
    const original = JSON.stringify(historical);
    index.attach(() => historical);
    assert.equal((await index.list("run")).pending, true);
    await index.settle();
    let list = await index.list("run");
    assert.equal(list.pending, false);
    assert.equal(list.artifacts.length, 3);
    assert.equal(list.artifacts.filter((a) => a.status === "ready").length, 1);
    assert.equal(JSON.stringify(historical), original);
    await png(missing);
    await index.list("run", true);
    await index.settle();
    list = await index.list("run");
    assert.equal(list.artifacts.filter((a) => a.status === "ready").length, 2);
    const reopened = new WorkflowArtifactIndex(store, root);
    reopened.attach(() => historical);
    assert.equal((await reopened.list("run")).pending, false);
    await reopened.close();
  }));

test("nested runs aggregate with original provenance; producer wrappers capture Agent calls even when outer output is discarded", () =>
  fixture(async (root, index) => {
    const image = join(root, "image.png");
    await png(image);
    let calls = 0;
    const binding = artifactCallBinding(
      index,
      { cwd: root, mode: "demo", runId: "child", stepId: "agent", attempt: 2 },
      {
        async image() {
          calls++;
          return { service: "qwen-image", seed: 1, files: [image] };
        },
      } as never,
    )!("tool-1");
    await binding.localAI!.image({ prompt: "test" }, AbortSignal.timeout(1000));
    index.attach((id) =>
      id === "run"
        ? run("run", [
            {
              id: "child",
              kind: "flow",
              status: "completed",
              flowId: "nested",
              sourceHash: "hash",
              input: {},
              outputSchema: {},
              childRequestId: "request",
              requestInputHash: "hash",
              childRunId: "child",
            },
          ])
        : run(id),
    );
    const list = await index.list("run");
    await index.settle();
    assert.equal(list.artifacts[0].runId, "child");
    assert.equal(list.artifacts[0].callId, "tool-1");
    assert.equal(list.artifacts[0].attempt, 2);
    assert.equal(calls, 1);
    assert.ok(await index.resolve("run", list.artifacts[0].artifactId, false));
  }));

test("Tripo history validates manifest and admits views, poster and existing GLB without contacting provider", () =>
  fixture(async (root, index) => {
    const directory = join(root, "generated");
    await mkdir(directory);
    const modelPath = join(directory, "model.glb"),
      previewPath = join(directory, "preview.png"),
      front = join(directory, "view-front.png"),
      manifestPath = join(directory, "manifest.json");
    await writeFile(modelPath, glb());
    await png(previewPath);
    await png(front);
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        generator: "aura-tripo-game-asset",
        tasks: { model: "task-1" },
        files: { model: "model.glb" },
      }),
    );
    const output = {
      outputDirectory: directory,
      modelPath,
      previewPath,
      manifestPath,
      imagePaths: { front },
      taskIds: { model: "task-1" },
    };
    await index.capture(owner, output, "plugin/model", true);
    const list = await index.list("run");
    await index.settle();
    assert.equal(list.artifacts.length, 3);
    assert.ok(list.artifacts.every((artifact) => artifact.status === "ready"));
    assert.ok(
      list.artifacts.find((artifact) => artifact.kind === "model")?.thumbnailId,
    );
    await index.capture(
      { ...owner, runId: "other" },
      { ...output, taskIds: { model: "wrong" } },
      "plugin/model",
      true,
    );
    const invalid = await index.list("other");
    await index.settle();
    assert.ok(
      invalid.artifacts.every((artifact) => artifact.status === "unavailable"),
    );
  }));

test("history reader pairs structured tool results to call and attempt, ignores prose and failed results", async () => {
  const captured: unknown[] = [];
  const reader = historicalArtifactReader({
    sessionController: {
      async inspect() {
        return {
          events: [
            {
              type: "tool/call",
              data: { callId: "call", name: "local-image" },
            },
            {
              type: "tool/result",
              data: {
                message: {
                  content: [
                    {
                      type: "tool-result",
                      toolCallId: "call",
                      content: [
                        {
                          type: "text",
                          text: '{"files":["/generated/image.png"]}',
                        },
                      ],
                    },
                  ],
                },
              },
            },
            {
              type: "tool/result",
              data: {
                message: {
                  content: [
                    {
                      type: "tool-result",
                      toolCallId: "call",
                      isError: true,
                      content: [
                        { type: "text", text: '{"files":["/secret.png"]}' },
                      ],
                    },
                  ],
                },
              },
            },
          ],
        };
      },
    },
  } as never);
  await reader(
    run("run", [
      {
        id: "agent",
        kind: "agent",
        status: "completed",
        preset: "p",
        sessionId: "session",
        attempts: [
          {
            number: 2,
            sessionId: "session",
            status: "completed",
            startedAt: 1,
          },
        ],
      },
    ]),
    async (...args) => {
      captured.push(args);
    },
  );
  assert.deepEqual(captured, [
    [
      { runId: "run", stepKey: "agent", attempt: 2, callId: "call" },
      { files: ["/generated/image.png"] },
      "local-image",
    ],
  ]);
});

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

test("local TTS WAV outputs become playable audio artifacts", () =>
  fixture(async (root, index) => {
    const samples = 8000;
    const wav = Buffer.alloc(44 + samples * 2);
    wav.write("RIFF", 0);
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write("WAVE", 8);
    wav.write("fmt ", 12);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(16000, 24);
    wav.writeUInt32LE(32000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(samples * 2, 40);
    const speech = join(root, "speech.wav");
    await writeFile(speech, wav);
    await index.capture(
      { ...owner, stepKey: "speech" },
      { service: "qwen3-tts", seed: 1, files: [speech] },
      "local-tts",
    );
    const { artifacts } = await index.list("run");
    await index.settle();
    const audio = artifacts.find((artifact) => artifact.stepKey === "speech");
    assert.equal(audio?.kind, "audio");
    assert.equal(audio?.format, "wav");
    assert.equal(audio?.mimeType, "audio/wav");
    assert.equal(audio?.status, "ready");
    assert.equal(audio?.durationSeconds, 0.5);
  }));

test("uploaded chat images are served and read back only by verified content ID", async () => {
  const { OrchestrationHost } = await import("../src/index.ts");
  const { artifactHash } = await import("../src/artifact-media.ts");
  const root = await realpath(await mkdtemp(join(tmpdir(), "aura-chat-image-")));
  try {
    const dshHome = join(root, "dsh");
    const store = new GeneratedArtifacts(join(dshHome, "aura-generated-assets"));
    const bytes = await sharp({
      create: { width: 8, height: 6, channels: 3, background: "#8052EA" },
    })
      .png()
      .toBuffer();
    const { artifactId } = await store.registerImage(bytes, AbortSignal.timeout(5000));
    assert.equal(artifactId, artifactHash(bytes));
    const read = await store.readImage(artifactId, AbortSignal.timeout(5000));
    assert.equal(read.mediaType, "image/png");
    assert.equal(read.bytes.length, bytes.length);

    const host = new OrchestrationHost({ root, dshHome, modelURL: "http://127.0.0.1:1/v1" });
    const ok = await host.imageAssetContent(artifactId, new Request("http://x/img"));
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "image/png");
    assert.equal((await ok.arrayBuffer()).byteLength, bytes.length);
    await assert.rejects(host.imageAssetContent("../etc", new Request("http://x/img")), /图片不存在/u);
    await assert.rejects(host.imageAssetContent("f".repeat(64), new Request("http://x/img")), /图片不存在/u);

    // A file whose bytes no longer match its name is refused on both paths.
    const forged = "e".repeat(64);
    await writeFile(join(store.root, `${forged}.png`), bytes);
    await assert.rejects(store.readImage(forged, AbortSignal.timeout(5000)), /内容已改变/u);
    await assert.rejects(host.imageAssetContent(forged, new Request("http://x/img")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
