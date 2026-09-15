import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { SubprocessRuntime } from "@deepseek-ai/dsh-subprocess";
import { ownProcessTree } from "./ownership.ts";

export interface LaunchSpec {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
}
export interface OwnedProcess {
  readonly pid: number;
  readonly exited: boolean;
  ownsPort(port: number, signal: AbortSignal): Promise<boolean>;
  stop(): Promise<void>;
}

export function launchOwned(
  subprocess: SubprocessRuntime,
  spec: LaunchSpec,
): OwnedProcess {
  const handle = subprocess.spawn({
    argv: [
      process.execPath,
      fileURLToPath(new URL("./worker.ts", import.meta.url)),
    ],
    cwd: spec.cwd,
    env: { ELECTRON_RUN_AS_NODE: "1" },
    stdio: {
      stdin: "pipe",
      stdout: { maxBytes: 16_384 },
      stderr: { maxBytes: 16_384 },
    },
    graceMs: 1_000,
  });
  let exited = false;
  let job: ReturnType<typeof ownProcessTree> | undefined;
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      handle.stdin?.destroy();
      // DSH handles normal tree teardown; the Job also covers hard owner death.
      handle.terminate();
      job?.close();
      await handle.done.catch(() => undefined);
      if (!(await handle.waitForExit(AbortSignal.timeout(10_000))))
        throw new Error("本地 AI 进程未完成回收；禁止启动下一个模型。");
    })());
  void handle.done.then(
    () => {
      exited = true;
    },
    () => {
      exited = true;
    },
  );
  handle.stdin?.on("error", () => {
    void stop().catch(() => undefined);
  });
  try {
    if (handle.pid <= 0 || !handle.stdin)
      throw new Error("无法启动本地 AI worker。");
    job = ownProcessTree(handle.pid);
    handle.stdin.write(JSON.stringify(spec) + "\n");
    return {
      pid: handle.pid,
      get exited() {
        return exited;
      },
      async ownsPort(port, signal) {
        signal.throwIfAborted();
        const probe = subprocess.spawn({
          argv: [
            join(
              process.env.SystemRoot ?? "C:/Windows",
              "System32",
              "netstat.exe",
            ),
            "-ano",
            "-p",
            "tcp",
          ],
          cwd: spec.cwd,
          stdio: {
            stdin: "ignore",
            stdout: { maxBytes: 256 * 1024 },
            stderr: { maxBytes: 1024 },
          },
          graceMs: 500,
          signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
        });
        try {
          const outcome = await probe.done;
          signal.throwIfAborted();
          const output = probe.collected.stdout?.readFrom(0);
          if (outcome.exitCode !== 0 || !output || output.lossy) return false;
          const listeners = output.text
            .split(/\r?\n/)
            .map((line) => line.trim().split(/\s+/))
            .filter(
              (fields) =>
                fields[1] === `127.0.0.1:${port}` && fields[2] === "0.0.0.0:0",
            );
          return (
            listeners.length > 0 &&
            listeners.every((fields) => job?.contains(Number(fields.at(-1))))
          );
        } finally {
          probe.terminate();
          await probe.waitForExit(AbortSignal.timeout(5_000));
        }
      },
      stop,
    };
  } catch (error) {
    void stop().catch(() => undefined);
    throw error;
  }
}
