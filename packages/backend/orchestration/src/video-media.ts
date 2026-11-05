import { spawn } from "node:child_process";
import ffmpeg from "ffmpeg-static";

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
