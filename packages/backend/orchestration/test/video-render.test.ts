import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GeneratedArtifacts } from "../src/artifacts/generated.ts";
import { mediaCommand, probeVideo } from "../src/local-ai/media.ts";
import { renderVideo } from "../src/local-ai/video-render.ts";
import type { ComfyWorkflowInput } from "../src/local-ai/api.ts";

test(
  "continuous R2V resumes completed segments, anchors each continuation and exports exactly 720 frames",
  { timeout: 30_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "aura-video-render-"));
    const signal = new AbortController().signal;
    const source = join(root, "source.mp4");
    const calls: ComfyWorkflowInput[] = [];
    let interrupt = true;
    try {
      await mediaCommand(
        [
          "-v",
          "error",
          "-y",
          "-f",
          "lavfi",
          "-i",
          "color=c=blue:s=64x64:r=24",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:sample_rate=32000",
          "-t",
          "11",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          source,
        ],
        signal,
      );
      const options = {
        id: "continuous",
        outputs: root,
        assets: new GeneratedArtifacts(join(root, "assets")),
        report: async ({ segment }: { segment: number }) => {
          if (segment === 2 && interrupt) {
            interrupt = false;
            throw new Error("host interrupted");
          }
        },
        execute: async (input: ComfyWorkflowInput) => {
          calls.push(input);
          return {
            service: "minimax-h3" as const,
            promptId: "fixture",
            workflowHash: "a".repeat(64),
            files: [source],
            outputs: { "16": { video: { path: source } } },
          };
        },
      };
      const input = {
        prompt: "walking",
        frames: 720,
        seed: 42,
        width: 256,
        height: 256,
        referenceVideo: {
          assetId: "a".repeat(64),
          start: 0,
          duration: 0.5,
          role: "motion",
          audio: false,
        },
      };
      await assert.rejects(
        renderVideo(input, signal, options),
        /host interrupted/u,
      );
      assert.equal(calls.length, 1);
      const result = await renderVideo(input, signal, options);
      assert.equal(
        calls.length,
        3,
        "the completed first segment must not be regenerated",
      );
      assert.deepEqual(
        result.segments?.map((segment) => segment.frames),
        [240, 240, 240],
      );
      for (const call of calls.slice(1))
        assert(
          call.imageBindings?.some((binding) => binding.nodeId === "23"),
          "continuations must carry the previous last frame",
        );
      const info = await probeVideo(result.videoPath!, signal);
      assert(
        Math.abs(info.durationSeconds - 30) <= 0.05,
        String(info.durationSeconds),
      );
      const decoded = await mediaCommand(
        [
          "-i",
          result.videoPath!,
          "-map",
          "0:v:0",
          "-vf",
          "scale=1:1",
          "-f",
          "null",
          "-",
        ],
        signal,
      );
      assert.match(decoded, /frame=\s*720\b/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
