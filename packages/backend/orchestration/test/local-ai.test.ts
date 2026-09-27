import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import sharp from "sharp";
import type { SubprocessRuntime } from "@deepseek-ai/dsh-subprocess";
import { GeneratedArtifacts } from "../src/generated-artifacts.ts";
import { LocalAIManager, type Deployment } from "../src/local-ai/manager.ts";
import { imageGraph, videoGraph, type Graph } from "../src/local-ai/graphs.ts";
import { readJSON, saveAudio } from "../src/local-ai/http.ts";
import { prepareWorkflow } from "../src/local-ai/comfy.ts";

const signal = () => new AbortController().signal;
async function closeServer(server: ServerType) {
  if ("closeAllConnections" in server) server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
async function freePort() {
  const server = serve({
    fetch: new Hono().fetch,
    hostname: "127.0.0.1",
    port: 0,
  });
  if (!server.listening)
    await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  await closeServer(server);
  return address.port;
}
async function fixture(withAssets = false) {
  const root = await mkdtemp(join(tmpdir(), "aura-local-ai-"));
  const outputs = join(root, "outputs");
  const assets = withAssets
    ? new GeneratedArtifacts(join(root, "assets"))
    : undefined;
  const entries: Deployment[] = [];
  for (const id of ["qwen-image", "minimax-h3", "qwen3-tts"] as const)
    entries.push({
      id,
      port: await freePort(),
      health: id === "qwen3-tts" ? "/healthz" : "/system_stats",
      launch: {
        cwd: root,
        argv: [process.execPath, id],
        env: { QWEN_TTS_API_KEY: "fixture" },
      },
    });
  let launches = 0,
    stops = 0,
    live = 0,
    lease = false;
  let failing = false,
    pending = false,
    escape = false,
    unhealthy = false;
  let lastGraph: Graph | undefined;
  let stagedImages: string[] = [];
  let lastTTS: unknown;
  let startedTTS = false;
  let ownedPort = true;
  let portDelay = 0;
  const servers = new Set<ServerType>();
  const manager = new LocalAIManager({} as SubprocessRuntime, root, {
    assets,
    deployments: entries,
    outputs,
    idleMs: 40,
    startupMs: 150,
    pollMs: 5,
    lease: () => {
      assert.equal(lease, false, "GPU lease must not overlap");
      lease = true;
      return () => {
        lease = false;
      };
    },
    launch: async (spec) => {
      const inputAt = spec.argv.indexOf("--input-directory");
      stagedImages = inputAt >= 0 ? await readdir(spec.argv[inputAt + 1]) : [];
      launches++;
      live++;
      assert.equal(live, 1, "model processes must never overlap");
      const entry = entries.find((d) => d.id === spec.argv[1])!;
      const app = new Hono();
      app.get("/system_stats", (c) =>
        c.json(unhealthy ? {} : { system: {}, devices: [] }),
      );
      app.get("/healthz", (c) =>
        c.json({ status: unhealthy ? "incomplete" : "prepared" }),
      );
      let id: string;
      let uiOutputs: Record<string, unknown>;
      app.post("/prompt", async (c) => {
        const data = await c.req.json();
        id = data.prompt_id;
        lastGraph = data.prompt;
        uiOutputs = {};
        for (const [nodeId, node] of Object.entries(data.prompt as Graph)) {
          if (node.class_type === "FixtureText") {
            uiOutputs[nodeId] = { text: [node.inputs.text] };
            continue;
          }
          if (
            !["SaveImage", "SaveVideo", "PreviewImage"].includes(
              node.class_type,
            )
          )
            continue;
          const preview = node.class_type === "PreviewImage";
          const prefix = String(node.inputs.filename_prefix ?? "preview");
          const subfolder = dirname(prefix) === "." ? "" : dirname(prefix);
          const filename = `${basename(prefix)}${node.class_type === "SaveVideo" ? ".mp4" : ".png"}`;
          const target = preview
            ? join(spec.argv[spec.argv.indexOf("--temp-directory") + 1], "temp")
            : spec.argv[spec.argv.indexOf("--output-directory") + 1];
          const path = join(target, subfolder, filename);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(
            path,
            withAssets && node.class_type === "SaveImage"
              ? await sharp({
                  create: {
                    width: 8,
                    height: 8,
                    channels: 3,
                    background: "red",
                  },
                })
                  .png()
                  .toBuffer()
              : "fixture-artifact",
          );
          uiOutputs[nodeId] = {
            images: [
              {
                filename: escape ? "outside.png" : filename,
                subfolder: escape ? "../../" : subfolder,
                type: preview ? "temp" : "output",
              },
            ],
          };
        }
        return c.json({ prompt_id: id });
      });
      app.get("/history/:id", (c) =>
        c.json(
          pending
            ? {}
            : {
                [id]: {
                  status: {
                    status_str: failing ? "error" : "success",
                    completed: true,
                  },
                  outputs: uiOutputs,
                },
              },
        ),
      );
      app.post("/queue", (c) => c.json({}));
      app.post("/interrupt", (c) => c.json({}));
      app.post("/v1/tts/:mode", async (c) => {
        assert.equal(c.req.header("Authorization"), "Bearer fixture");
        startedTTS = true;
        lastTTS =
          c.req.param("mode") === "voice-clone"
            ? await c.req.parseBody()
            : await c.req.json();
        if (pending) await delay(150);
        if (failing) return c.json({ error: "fixture" }, 500);
        return c.body(new Uint8Array(128), 200, {
          "Content-Type": "audio/wav",
        });
      });
      const server = serve({
        fetch: app.fetch,
        port: entry.port,
        hostname: "127.0.0.1",
      });
      servers.add(server);
      let exited = false;
      return {
        pid: 1,
        async ownsPort(_port, signal) {
          if (portDelay) await delay(portDelay, undefined, { signal });
          return ownedPort;
        },
        get exited() {
          return exited;
        },
        async stop() {
          if (exited) return;
          exited = true;
          stops++;
          live--;
          await closeServer(server);
          servers.delete(server);
        },
      };
    },
  });
  return {
    manager,
    assets,
    root,
    outputs,
    entries,
    get counts() {
      return { launches, stops, live, lease };
    },
    get graph() {
      return lastGraph;
    },
    get stagedImages() {
      return stagedImages;
    },
    get tts() {
      return lastTTS;
    },
    get startedTTS() {
      return startedTTS;
    },
    set failing(value: boolean) {
      failing = value;
    },
    set pending(value: boolean) {
      pending = value;
    },
    set escape(value: boolean) {
      escape = value;
    },
    set unhealthy(value: boolean) {
      unhealthy = value;
    },
    set ownedPort(value: boolean) {
      ownedPort = value;
    },
    set portDelay(value: number) {
      portDelay = value;
    },
    async close() {
      await manager.close();
      for (const s of servers) await closeServer(s);
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("local AI lifecycle: duplicate starts, model switching, idle expiry, no external adoption", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await f.manager.service("qwen-image", "status", signal())).state,
      "stopped",
    );
    await f.manager.service("qwen-image", "start", signal());
    await f.manager.service("qwen-image", "start", signal());
    assert.equal(f.counts.launches, 1);
    // Stopping an unrelated service must not remove the active service's idle timer.
    await f.manager.service("qwen3-tts", "stop", signal());
    await f.manager.service("qwen-image", "start", signal());
    f.portDelay = 50;
    await assert.rejects(
      f.manager.service("qwen-image", "start", AbortSignal.timeout(5)),
    );
    f.portDelay = 0;
    assert.equal(
      f.counts.live,
      0,
      "cancelled renewal must stop its warm process",
    );
    await delay(100);
    assert.equal(f.counts.live, 0);
    await f.manager.service("qwen-image", "start", signal());
    await f.manager.service("qwen3-tts", "start", signal());
    assert.equal(f.counts.live, 1);
    await f.manager.service("qwen3-tts", "stop", signal());
    const external = serve({
      fetch: new Hono().fetch,
      port: f.entries[0].port,
      hostname: "127.0.0.1",
    });
    try {
      if (!external.listening)
        await new Promise((resolve) => external.once("listening", resolve));
      assert.equal(
        (await f.manager.service("qwen-image", "status", signal())).state,
        "external",
      );
      await assert.rejects(
        f.manager.image({ prompt: "test" }, signal()),
        /外部/,
      );
      await f.manager.service("qwen-image", "stop", signal());
      assert.equal(external.listening, true);
      assert.equal(f.counts.lease, false);
    } finally {
      await closeServer(external);
    }
  } finally {
    await f.close();
  }
});

test("local image/video/TTS use deployed APIs, bounded outputs, and always release GPU", async () => {
  const f = await fixture();
  try {
    const [image, video, speech] = await Promise.all([
      f.manager.image({ prompt: "image", seed: 1 }, signal()),
      f.manager.video({ prompt: "video", seed: 2 }, signal()),
      f.manager.tts(
        {
          text: "speech",
          seed: 3,
          mode: "voice-design",
          voiceDescription: "warm",
        },
        signal(),
      ),
    ]);
    assert.equal(image.seed, 1);
    assert.match(image.files[0], /image\.png$/);
    assert.equal(video.seed, 2);
    assert.match(video.files[0], /video\.mp4$/);
    assert.equal(speech.seed, 3);
    assert.match(speech.files[0], /speech\.wav$/);
    assert.equal(f.graph?.["6"].inputs.length, 39);
    assert.deepEqual(f.tts, {
      text: "speech",
      language: "Auto",
      seed: 3,
      max_new_tokens: 2048,
      voice_description: "warm",
    });
    assert.deepEqual(f.counts, {
      launches: 3,
      stops: 3,
      live: 0,
      lease: false,
    });
    const reference = join(f.root, "reference.wav");
    await writeFile(reference, "reference");
    await f.manager.tts(
      {
        text: "clone",
        mode: "voice-clone",
        referenceAudio: reference,
        referenceText: "reference",
      },
      signal(),
    );
    assert.equal(
      (f.tts as Record<string, unknown>).reference_text,
      "reference",
    );
    assert((await readdir(f.root)).includes("reference.wav"));
  } finally {
    await f.close();
  }
});

test("generated and uploaded images can anchor an isolated MiniMax H3 video", async () => {
  const f = await fixture(true);
  try {
    const uploaded = await f.assets!.registerImage(
      await sharp({
        create: { width: 16, height: 12, channels: 3, background: "blue" },
      })
        .png()
        .toBuffer(),
      signal(),
    );
    const generated = await f.manager.image(
      { prompt: "山门", seed: 4 },
      signal(),
    );
    assert.match(generated.imageAssetId ?? "", /^[a-f0-9]{64}$/u);
    const video = await f.manager.video(
      {
        prompt: "镜头缓慢推进",
        firstFrameAssetId: generated.imageAssetId,
        lastFrameAssetId: uploaded.artifactId,
        width: 352,
        height: 608,
        frames: 22,
        seed: 5,
      },
      signal(),
    );
    assert.equal(video.seed, 5);
    assert.deepEqual(f.graph?.["6"].inputs.first_frame, ["16", 0]);
    assert.deepEqual(f.graph?.["6"].inputs.last_frame, ["17", 0]);
    assert.deepEqual(
      f.stagedImages.sort(),
      [
        `${generated.imageAssetId}-352x608.png`,
        `${uploaded.artifactId}-352x608.png`,
      ].sort(),
    );
    assert.equal(
      await readdir(dirname(dirname(video.files[0]))).then((names) =>
        names.includes("comfy-input"),
      ),
      false,
    );
    await assert.rejects(
      f.manager.video(
        { prompt: "x", firstFrameAssetId: "0".repeat(64) },
        signal(),
      ),
      /不存在|已改变/,
    );
    assert.equal(
      f.counts.launches,
      2,
      "missing images must fail before starting ComfyUI",
    );
  } finally {
    await f.close();
  }
});

test("validation, startup failure, generation failure and output escape leave no processes", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.manager.image({ prompt: "x", width: 257 }, signal()),
    );
    await assert.rejects(
      f.manager.image({ prompt: "x", width: 1536, height: 1536 }, signal()),
    );
    await assert.rejects(
      f.manager.video({ prompt: "x", frames: 40 }, signal()),
    );
    await assert.rejects(
      f.manager.tts({ text: "x", mode: "voice-design" }, signal()),
    );
    await assert.rejects(
      f.manager.tts(
        {
          text: "x",
          mode: "voice-clone",
          referenceAudio: "relative.wav",
          xVectorOnly: true,
        },
        signal(),
      ),
    );
    assert.equal(f.counts.launches, 0);
    f.ownedPort = false;
    await assert.rejects(
      f.manager.image({ prompt: "must not submit" }, signal()),
      /不属于/,
    );
    assert.equal(f.graph, undefined);
    assert.equal(f.counts.live, 0);
    f.ownedPort = true;
    f.unhealthy = true;
    await assert.rejects(f.manager.service("qwen-image", "start", signal()));
    f.unhealthy = false;
    f.failing = true;
    await assert.rejects(
      f.manager.image({ prompt: "x" }, signal()),
      /生成失败/,
    );
    await assert.rejects(f.manager.tts({ text: "x" }, signal()), /WAV/);
    f.failing = false;
    f.escape = true;
    await writeFile(join(f.outputs, "outside.png"), "must remain");
    await assert.rejects(f.manager.image({ prompt: "x" }, signal()), /越过/);
    assert.deepEqual(await readdir(f.outputs), ["outside.png"]);
    assert.equal(f.counts.live, 0);
    assert.equal(f.counts.lease, false);
  } finally {
    await f.close();
  }
});

test("cancel waiting work without spawning; cancel active inference and close settle cleanup", async () => {
  const f = await fixture();
  try {
    f.pending = true;
    const active = new AbortController();
    const first = f.manager.tts({ text: "x" }, active.signal);
    // Attach rejection handlers immediately to avoid an unhandled cancellation.
    const firstCheck = assert.rejects(first);
    while (!f.startedTTS) await delay(5);
    const waiting = new AbortController();
    const secondCheck = assert.rejects(
      f.manager.image({ prompt: "queued" }, waiting.signal),
    );
    waiting.abort();
    await secondCheck;
    assert.equal(f.counts.launches, 1);
    active.abort();
    await firstCheck;
    assert.equal(f.counts.live, 0);
    const thirdCheck = assert.rejects(
      f.manager.image({ prompt: "close" }, signal()),
    );
    await delay(25);
    await f.manager.close();
    await thirdCheck;
    assert.equal(f.counts.lease, false);
    assert.deepEqual(await readdir(f.outputs), []);
  } finally {
    await f.close();
  }
});

test("binary/JSON response guards and deployed graph constants", async () => {
  await assert.rejects(
    readJSON(new Response("x".repeat(2 * 1024 * 1024 + 1))),
    /2 MiB/,
  );
  const root = await mkdtemp(join(tmpdir(), "aura-ai-download-"));
  try {
    await assert.rejects(
      saveAudio(
        new Response("short", { headers: { "Content-Type": "audio/wav" } }),
        join(root, "bad.wav"),
        signal(),
      ),
      /不完整/,
    );
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  const image = imageGraph(
    {
      prompt: "x",
      negative: "",
      width: 512,
      height: 512,
      seed: 1,
      steps: 1,
      cfg: 4,
    },
    "job/image",
  );
  assert.equal(
    image["1"].inputs.unet_name,
    "qwen_image_2512_fp8_e4m3fn.safetensors",
  );
  const video = videoGraph(
    { prompt: "x", width: 608, height: 352, frames: 22, seed: 1 },
    "job/video",
  );
  assert.equal(video["14"].inputs.fps, 24);
  assert.equal(video["9"].inputs.steps, 8);
});

const customGraph = () => ({
  source: { class_type: "FixtureSource", inputs: { width: 128 } },
  saved: {
    class_type: "SaveImage",
    inputs: { images: ["source", 0], filename_prefix: "nested/custom" },
    _meta: { title: "My image" },
  },
  preview: { class_type: "PreviewImage", inputs: { images: ["source", 0] } },
  message: { class_type: "FixtureText", inputs: { text: "original" } },
});

test("custom ComfyUI workflow accepts inline/wrapped/file graphs, overrides, previews and arbitrary output IDs", async () => {
  const f = await fixture();
  try {
    const graph = customGraph();
    const result = await f.manager.comfyWorkflow(
      {
        service: "qwen-image",
        workflow: graph,
        overrides: { message: { text: "overridden" } },
      },
      signal(),
    );
    assert.equal(
      graph.message.inputs.text,
      "original",
      "caller graph must remain unchanged",
    );
    assert.equal(f.graph?.message.inputs.text, "overridden");
    assert.deepEqual(result.outputs.message, { text: ["overridden"] });
    assert.equal(result.files.length, 2);
    assert.match(result.promptId, /^[a-f0-9-]{36}$/);
    assert.match(result.workflowHash, /^[a-f0-9]{64}$/);
    for (const path of result.files)
      assert.equal(await readFile(path, "utf8"), "fixture-artifact");
    const saved = result.outputs.saved as { images: Array<{ path: string }> };
    assert.equal(saved.images[0].path, result.files[0]);
    const job = dirname(dirname(result.files[0]));
    assert.deepEqual(
      await readdir(job),
      ["artifacts"],
      "runtime output/temp directories must be removed",
    );
    const path = join(f.root, "custom-api.json");
    await writeFile(path, JSON.stringify({ prompt: graph }));
    const fileResult = await f.manager.comfyWorkflow(
      {
        service: "minimax-h3",
        workflowFile: "custom-api.json",
        outputNodeIds: ["message"],
      },
      signal(),
    );
    assert.deepEqual(fileResult.outputs, { message: { text: ["original"] } });
    assert.equal(fileResult.files.length, 0);
    graph.message.inputs.text = "edited";
    await writeFile(path, JSON.stringify(graph));
    const edited = await f.manager.comfyWorkflow(
      { service: "qwen-image", workflowFile: path, outputNodeIds: ["message"] },
      signal(),
    );
    assert.notEqual(edited.workflowHash, fileResult.workflowHash);
    assert.deepEqual(edited.outputs.message, { text: ["edited"] });
    assert.deepEqual(
      JSON.parse(await readFile(path, "utf8")),
      graph,
      "source file remains read-only",
    );
    assert.equal(f.counts.live, 0);
    assert.equal(f.counts.lease, false);
  } finally {
    await f.close();
  }
});

test("ComfyUI rejects ambiguous/UI/non-JSON/oversize workflows and invalid overrides before launch", async () => {
  const f = await fixture();
  try {
    const base = { service: "qwen-image" as const };
    await assert.rejects(
      f.manager.comfyWorkflow(base, signal()),
      /只能提供一个/,
    );
    await assert.rejects(
      f.manager.comfyWorkflow(
        { ...base, workflow: customGraph(), workflowFile: "x" },
        signal(),
      ),
      /只能提供一个/,
    );
    await assert.rejects(
      f.manager.comfyWorkflow(
        { ...base, workflow: { nodes: [], links: [] } },
        signal(),
      ),
      /画布格式/,
    );
    await assert.rejects(
      f.manager.comfyWorkflow(
        {
          ...base,
          workflow: customGraph(),
          overrides: { missing: { text: "x" } },
        },
        signal(),
      ),
      /未知节点/,
    );
    await assert.rejects(
      f.manager.comfyWorkflow(
        {
          ...base,
          workflow: customGraph(),
          overrides: { message: { typo: "x" } },
        },
        signal(),
      ),
      /不存在输入/,
    );
    await assert.rejects(
      f.manager.comfyWorkflow(
        { ...base, workflow: customGraph(), outputNodeIds: ["missing"] },
        signal(),
      ),
      /输出节点不存在/,
    );
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await assert.rejects(
      f.manager.comfyWorkflow({ ...base, workflow: cyclic }, signal()),
    );
    const path = join(f.root, "bad.json");
    await writeFile(path, "x".repeat(256 * 1024 + 1));
    await assert.rejects(
      f.manager.comfyWorkflow({ ...base, workflowFile: path }, signal()),
      /256 KiB/,
    );
    await writeFile(path, "{invalid}");
    await assert.rejects(
      f.manager.comfyWorkflow({ ...base, workflowFile: path }, signal()),
    );
    assert.equal(f.counts.launches, 0);
  } finally {
    await f.close();
  }
});

test("ComfyUI pins file contents before execution and cleans up failures/cancellation", async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "pinned.json");
    await writeFile(path, JSON.stringify(customGraph()));
    const input = { service: "qwen-image" as const, workflowFile: path };
    const prepared = await prepareWorkflow(input, f.root, signal());
    f.pending = true;
    const running = f.manager.comfyWorkflow(input, signal());
    while (!f.graph) await delay(5);
    const changed = customGraph();
    changed.message.inputs.text = "new";
    await writeFile(path, JSON.stringify(changed));
    f.pending = false;
    assert.equal((await running).workflowHash, prepared.workflowHash);
    const successful = await readdir(f.outputs);
    f.failing = true;
    await assert.rejects(f.manager.comfyWorkflow(input, signal()), /生成失败/);
    f.failing = false;
    f.pending = true;
    await assert.rejects(
      f.manager.comfyWorkflow(input, AbortSignal.timeout(25)),
    );
    f.pending = false;
    await assert.rejects(
      f.manager.comfyWorkflow(
        { ...input, outputNodeIds: ["source"] },
        signal(),
      ),
      /没有返回 UI 输出/,
    );
    assert.deepEqual(
      await readdir(f.outputs),
      successful,
      "failed runs must remove only their own files",
    );
    assert.equal(f.counts.live, 0);
    assert.equal(f.counts.lease, false);
  } finally {
    await f.close();
  }
});
