import { spawn } from "node:child_process";
import ffmpeg from "ffmpeg-static";
import { createHash } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { GeneratedArtifacts } from "../artifacts/generated.ts";
import type { ComfyWorkflowInput } from "./api.ts";

export type VideoBinding = NonNullable<
  ComfyWorkflowInput["videoBindings"]
>[number];
export const alignedFrames = (frames: number) =>
  5 + 17 * Math.max(0, Math.ceil((frames - 5) / 17));
export const videoBindingName = (binding: VideoBinding) =>
  `${createHash("sha256").update(JSON.stringify(binding)).digest("hex")}.mp4`;

export async function stageVideoBinding(
  store: GeneratedArtifacts,
  directory: string,
  binding: VideoBinding,
  signal: AbortSignal,
) {
  const source = await store.read(binding.assetId, signal);
  if (source.artifact.format !== "mp4")
    throw new Error("视频参考必须为受管 MP4。");
  const path = join(directory, `${binding.assetId}.source.mp4`);
  await writeFile(path, source.bytes, { signal });
  try {
    const info = await probeVideo(path, signal);
    const seconds = Math.min(
      binding.duration,
      info.durationSeconds - binding.start,
    );
    if (seconds < 0.2) throw new Error("参考视频截取范围为空。");
    const scale = Math.min(
      1,
      binding.width / info.width,
      binding.height / info.height,
    );
    const width = Math.max(32, Math.ceil((info.width * scale) / 32) * 32);
    const height = Math.max(32, Math.ceil((info.height * scale) / 32) * 32);
    const frames = alignedFrames(Math.ceil(seconds * 24 - 1e-6));
    await mediaCommand(
      [
        "-v",
        "error",
        "-y",
        "-ss",
        String(binding.start),
        "-i",
        path,
        "-map",
        "0:v:0",
        "-vf",
        `trim=duration=${seconds},setpts=PTS-STARTPTS,fps=24,scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,tpad=stop_mode=clone:stop_duration=1,trim=end_frame=${frames},setpts=N/(24*TB)`,
        ...(info.audio
          ? [
              "-map",
              "0:a:0",
              "-af",
              `atrim=duration=${seconds},asetpts=PTS-STARTPTS,aresample=32000,apad,atrim=duration=${frames / 24}`,
              "-c:a",
              "aac",
              "-ar",
              "32000",
              "-ac",
              "2",
            ]
          : ["-an"]),
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-t",
        String(frames / 24),
        "-movflags",
        "+faststart",
        join(directory, videoBindingName(binding)),
      ],
      signal,
    );
  } finally {
    await unlink(path);
  }
}

/** Bounded media subprocess with cancellation, shared by model preprocessing. */
export async function mediaCommand(
  args: string[],
  signal: AbortSignal,
): Promise<string> {
  const binary = ffmpeg;
  if (!binary) throw new Error("FFmpeg 不可用。");
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ["-nostdin", "-hide_banner", ...args], {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let output = "";
    child.stderr.on("data", (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-16000);
    });
    const abort = () => child.kill();
    signal.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (code) => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) reject(signal.reason);
      else if (code) reject(new Error(`媒体处理失败：${output.slice(-500)}`));
      else resolve(output);
    });
  });
}

export async function probeVideo(path: string, signal: AbortSignal) {
  const text = await mediaCommand(
    ["-i", path, "-map", "0:v:0", "-frames:v", "1", "-f", "null", "-"],
    signal,
  );
  const size = text.match(/Video:.*?\b(\d{2,5})x(\d{2,5})\b/u);
  const time = text.match(/Duration:\s*(\d+):(\d+):([\d.]+)/u);
  if (!size || !time) throw new Error("无法读取视频尺寸或时长。");
  return {
    width: Number(size[1]),
    height: Number(size[2]),
    durationSeconds:
      Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3]),
    audio: /Audio:/u.test(text),
  };
}
