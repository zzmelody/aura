import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GeneratedArtifacts } from "../artifacts/generated.ts";
import type {
  ComfyWorkflowInput,
  ComfyWorkflowResult,
  MediaResult,
  VideoInput,
  VideoJob,
} from "./api.ts";
import { videoGraph } from "./graphs.ts";
import { referenceGraph } from "./reference-graph.ts";
import { alignedFrames, mediaCommand, probeVideo } from "./media.ts";
import { CALL_TIMEOUT_MS } from "../timeouts.ts";

type Execute = (
  input: ComfyWorkflowInput,
  signal: AbortSignal,
  executionMs?: number,
) => Promise<ComfyWorkflowResult>;
interface Segment {
  index: number;
  frames: number;
  videoPath: string;
  lastFrameAssetId: string;
}

/** A continuous model clip may contain several inference segments, never editorial cuts. */
export async function renderVideo(
  input: VideoInput,
  signal: AbortSignal,
  options: {
    outputs: string;
    assets?: GeneratedArtifacts;
    execute: Execute;
    id?: string;
    report?: (progress: VideoJob["progress"]) => Promise<void>;
  },
): Promise<MediaResult> {
  if (options.id && !/^[a-zA-Z0-9_-]{1,128}$/u.test(options.id))
    throw new Error("视频任务 ID 无效。");
  const { assets } = options;
  const seed = input.seed ?? 0;
  const width = input.width ?? 736;
  const height = input.height ?? 1312;
  const totalFrames = input.frames ?? 240;
  const reference = Boolean(
    input.referenceVideo || input.referenceImages?.length,
  );
  const segmentFrames = reference ? 240 : 124;
  const total = Math.ceil(totalFrames / segmentFrames);
  const directory = join(
    options.outputs,
    `job-video-${options.id ?? randomUUID()}`,
  );
  await mkdir(directory, { recursive: true });
  const receiptPath = join(directory, "segments.json");
  let completed: Segment[] = [];
  try {
    const receipt: unknown = JSON.parse(await readFile(receiptPath, "utf8"));
    if (!Array.isArray(receipt) || receipt.length > total)
      throw new Error("视频分段记录无效。");
    completed = receipt.map((value: unknown, index): Segment => {
      if (!value || typeof value !== "object")
        throw new Error("视频分段记录无效。");
      const row = value as Record<string, unknown>;
      if (
        row.index !== index ||
        row.frames !==
          Math.min(segmentFrames, totalFrames - index * segmentFrames) ||
        row.videoPath !== join(directory, `segment-${index}.mp4`) ||
        typeof row.lastFrameAssetId !== "string" ||
        !/^[a-f0-9]{64}$/u.test(row.lastFrameAssetId)
      )
        throw new Error("视频分段记录与任务不匹配。");
      return {
        index,
        frames: row.frames as number,
        videoPath: row.videoPath as string,
        lastFrameAssetId: row.lastFrameAssetId,
      };
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (let index = 0; index < total; index++) {
    signal.throwIfAborted();
    await options.report?.({ segment: index + 1, total });
    if (completed[index]) {
      const info = await probeVideo(completed[index].videoPath, signal);
      if (Math.abs(info.durationSeconds - completed[index].frames / 24) > 0.05)
        throw new Error("已完成视频分段损坏。");
      continue;
    }
    const frames = Math.min(segmentFrames, totalFrames - index * segmentFrames);
    const previous = completed[index - 1]?.lastFrameAssetId;
    const modelFrames = Math.max(
      alignedFrames(frames),
      input.referenceVideo
        ? alignedFrames(Math.ceil(input.referenceVideo.duration * 24))
        : 5,
    );
    const parsed = {
      ...input,
      width,
      height,
      seed: (seed + index) % 2147483647,
      frames: modelFrames,
      firstFrameAssetId: index === 0 ? input.firstFrameAssetId : previous,
      lastFrameAssetId:
        index === total - 1 ? input.lastFrameAssetId : undefined,
    };
    const graph = reference
      ? referenceGraph(parsed, previous)
      : videoGraph(parsed, "video/clip");
    const outputNodeId = reference ? "16" : "15";
    const imageBindings = reference
      ? [
          ...(input.referenceImages ?? []).map((assetId, i) => ({
            nodeId: String(100 + i),
            assetId,
          })),
          ...(previous ? [{ nodeId: "23", assetId: previous }] : []),
        ]
      : [
          ...(parsed.firstFrameAssetId
            ? [
                {
                  nodeId: "16",
                  assetId: parsed.firstFrameAssetId,
                  resize: { width, height },
                },
              ]
            : []),
          ...(parsed.lastFrameAssetId
            ? [
                {
                  nodeId: "17",
                  assetId: parsed.lastFrameAssetId,
                  resize: { width, height },
                },
              ]
            : []),
        ];
    const result = await options.execute(
      {
        service: "minimax-h3",
        workflow: graph,
        imageBindings,
        videoBindings: input.referenceVideo
          ? [{ nodeId: "5", ...input.referenceVideo, width, height }].map(
              ({ nodeId, assetId, start, duration, width, height }) => ({
                nodeId,
                assetId,
                start,
                duration,
                width,
                height,
              }),
            )
          : [],
        outputNodeIds: [outputNodeId],
      },
      signal,
      CALL_TIMEOUT_MS,
    );
    const selected = result.outputs[outputNodeId];
    const paths: string[] = [];
    const visit = (value: unknown) => {
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
      } else if (value && typeof value === "object") {
        const row = value as Record<string, unknown>;
        if (typeof row.path === "string" && row.path.endsWith(".mp4"))
          paths.push(row.path);
        else for (const item of Object.values(row)) visit(item);
      }
    };
    visit(selected);
    if (paths.length !== 1) throw new Error("视频输出节点必须返回一个 MP4。");
    const output = join(directory, `segment-${index}.mp4`);
    await mediaCommand(
      [
        "-v",
        "error",
        "-y",
        "-i",
        paths[0],
        "-vf",
        `fps=24,trim=end_frame=${frames},setpts=N/(24*TB)`,
        "-af",
        `aresample=32000,apad,atrim=duration=${frames / 24},asetpts=PTS-STARTPTS`,
        "-t",
        String(frames / 24),
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-ar",
        "32000",
        "-ac",
        "2",
        "-movflags",
        "+faststart",
        output,
      ],
      signal,
    );
    const last = join(directory, `last-${index}.png`);
    await mediaCommand(
      [
        "-v",
        "error",
        "-y",
        "-i",
        output,
        "-vf",
        `select=eq(n\\,${frames - 1})`,
        "-frames:v",
        "1",
        last,
      ],
      signal,
    );
    if (!assets && total > 1) throw new Error("连续视频需要受管资产服务。");
    const lastFrameAssetId = assets
      ? (await assets.registerFile(last, signal, directory)).artifactId
      : "";
    completed.push({ index, frames, videoPath: output, lastFrameAssetId });
    await writeFile(receiptPath, JSON.stringify(completed), { signal });
  }
  const concat = join(directory, "segments.ffconcat");
  await writeFile(
    concat,
    "ffconcat version 1.0\n" +
      completed
        .map(
          (s) =>
            `file '${s.videoPath.replace(/\\/gu, "/").replace(/'/gu, "'\\''")}'`,
        )
        .join("\n") +
      "\n",
    { signal },
  );
  const videoPath = join(directory, "video.mp4");
  await mediaCommand(
    [
      "-v",
      "error",
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      concat,
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      videoPath,
    ],
    signal,
  );
  const info = await probeVideo(videoPath, signal);
  if (Math.abs(info.durationSeconds - totalFrames / 24) > 0.05)
    throw new Error("视频时长与目标帧数不一致。");
  return {
    service: "minimax-h3",
    seed,
    files: [videoPath],
    videoPath,
    segments: completed.map(({ lastFrameAssetId: _, ...segment }) => segment),
  };
}
