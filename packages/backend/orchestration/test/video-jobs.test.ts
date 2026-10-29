import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { VideoJobs } from "../src/local-ai/video-jobs.ts";
import { referenceGraph } from "../src/local-ai/reference-graph.ts";
import { prepareWorkflow } from "../src/local-ai/comfy.ts";

test(
  "concurrent jobs and duplicate submissions keep independent atomic receipts",
  { timeout: 10_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "aura-video-concurrent-"));
    let calls = 0;
    const jobs = new VideoJobs(directory, async (input) => {
      calls++;
      return {
        service: "minimax-h3",
        seed: input.seed!,
        files: [],
        videoPath: `${input.prompt}.mp4`,
      };
    });
    const requests = Array.from({ length: 20 }, (_, i) => ({
      id: `shot-${i}`,
      owner: "run",
      input: { prompt: `shot-${i}`, seed: i },
    }));
    const signal = new AbortController().signal;
    try {
      await Promise.all(
        requests.flatMap((request) => [
          jobs.call("submit", request, signal),
          jobs.call("submit", request, signal),
        ]),
      );
      const results = await Promise.all(
        requests.map((request) => jobs.call("wait", request, signal)),
      );
      assert.equal(calls, 20);
      assert(
        results.every(
          (job, i) =>
            job.state === "completed" &&
            job.result?.videoPath === `shot-${i}.mp4`,
        ),
      );
    } finally {
      await jobs.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "video job submission is idempotent, waits survive client cancellation and explicit cancellation drains work",
  { timeout: 10_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "aura-video-jobs-"));
    let calls = 0;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const jobs = new VideoJobs(directory, async (_input, signal) => {
      calls++;
      markStarted();
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
      throw new Error("unreachable");
    });
    const request = {
      id: "clip",
      owner: "run",
      input: { prompt: "walking", seed: 42 },
    };
    try {
      const first = await jobs.call(
        "submit",
        request,
        new AbortController().signal,
      );
      const second = await jobs.call(
        "submit",
        request,
        new AbortController().signal,
      );
      await started;
      assert.equal(first.id, second.id);
      assert.equal(calls, 1);
      await assert.rejects(
        jobs.call(
          "submit",
          { ...request, input: { prompt: "changed" } },
          new AbortController().signal,
        ),
        /不能改变/u,
      );
      const abort = new AbortController();
      const wait = jobs.call("wait", request, abort.signal);
      abort.abort();
      await assert.rejects(wait);
      assert.equal(calls, 1);
      assert.equal(
        (await jobs.call("cancel", request, new AbortController().signal))
          .state,
        "cancelled",
      );
    } finally {
      await jobs.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "interrupted jobs are not silently resubmitted; a new explicit request resumes completed segments",
  { timeout: 10_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "aura-video-resume-"));
    const request = {
      id: "clip",
      owner: "run",
      input: { prompt: "walking", seed: 42 },
    };
    const id = createHash("sha256")
      .update(JSON.stringify([request.owner, request.id]))
      .digest("hex");
    await writeFile(
      join(directory, `${id}.json`),
      JSON.stringify({
        ...request,
        id,
        revision: "minimax-h3-v2",
        state: "running",
        progress: { segment: 2, total: 3 },
      }),
    );
    let resumed = "";
    const jobs = new VideoJobs(directory, async (_input, _signal, sourceId) => {
      resumed = sourceId;
      return {
        service: "minimax-h3",
        seed: 42,
        files: ["video.mp4"],
        videoPath: "video.mp4",
      };
    });
    try {
      assert.equal(
        (await jobs.call("submit", request, new AbortController().signal))
          .state,
        "interrupted",
      );
      assert.equal(resumed, "");
      const next = { ...request, owner: "new-run" };
      await jobs.call("submit", next, new AbortController().signal);
      const result = await jobs.call(
        "wait",
        next,
        new AbortController().signal,
      );
      assert.equal(result.state, "completed");
      assert.equal(resumed, id);
    } finally {
      await jobs.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "R2V graph connects video, role images, optional audio and continuation to the sampler",
  { timeout: 10_000 },
  async () => {
    const input = {
      prompt: "walk",
      width: 736,
      height: 1312,
      frames: 243,
      seed: 1,
      referenceVideo: {
        assetId: "a".repeat(64),
        start: 2,
        duration: 10,
        role: "motion",
        audio: true,
      },
      referenceImages: ["b".repeat(64)],
    };
    const graph = referenceGraph(input, "c".repeat(64));
    assert.deepEqual(graph["7"].inputs["ref_videos.ref_video_0"], ["6", 0]);
    assert.deepEqual(graph["7"].inputs["ref_images.ref_image_0"], ["100", 0]);
    assert.deepEqual(graph["7"].inputs["ref_video_audios.ref_video_audio_0"], [
      "6",
      1,
    ]);
    assert.deepEqual(graph["11"].inputs.conditioning, ["24", 0]);
    const prepared = await prepareWorkflow(
      {
        service: "minimax-h3",
        workflow: graph,
        videoBindings: [
          {
            nodeId: "5",
            assetId: input.referenceVideo.assetId,
            start: 2,
            duration: 10,
            width: 736,
            height: 1312,
          },
        ],
      },
      process.cwd(),
      new AbortController().signal,
    );
    assert.match(
      String(prepared.graph["5"].inputs.file),
      /^[a-f0-9]{64}\.mp4$/u,
    );
    await assert.rejects(
      prepareWorkflow(
        {
          service: "minimax-h3",
          workflow: graph,
          videoBindings: [
            {
              nodeId: "7",
              assetId: input.referenceVideo.assetId,
              start: 0,
              duration: 10,
              width: 736,
              height: 1312,
            },
          ],
        },
        process.cwd(),
        new AbortController().signal,
      ),
      /LoadVideo/u,
    );
  },
);
