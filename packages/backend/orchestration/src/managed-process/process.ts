import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { Readable } from "node:stream";
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

export const MANAGED_PROCESS_PERMISSION = "aura.process.manage";

export interface ManagedProcesses {
  launch(spec: LaunchSpec): Promise<OwnedProcess>;
  acquireLease(name: string): () => void;
}

function readWorkerPid(stream: Readable): Promise<number> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const cleanup = () => {
      clearTimeout(timer);
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onEnd = () => fail(new Error("受管进程 worker 未报告进程身份。"));
    const onError = (error: Error) => fail(error);
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      if (buffer.length > 256)
        return fail(new Error("受管进程 worker 的进程身份无效。"));
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const identity = JSON.parse(buffer.slice(0, newline)) as {
          pid?: unknown;
        };
        if (
          !Number.isSafeInteger(identity.pid) ||
          (identity.pid as number) <= 0
        )
          throw new Error("受管进程 worker 的进程身份无效。");
        cleanup();
        stream.resume(); // Drain later child output without copying it to logs.
        resolve(identity.pid as number);
      } catch (error) {
        fail(
          error instanceof Error
            ? error
            : new Error("受管进程 worker 的进程身份无效。"),
        );
      }
    };
    const timer = setTimeout(
      () => fail(new Error("受管进程 worker 进程身份等待超时。")),
      5_000,
    );
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
  });
}

export async function launchOwned(
  subprocess: SubprocessRuntime,
  spec: LaunchSpec,
): Promise<OwnedProcess> {
  const handle = subprocess.spawn({
    argv: [
      process.execPath,
      fileURLToPath(new URL("./worker.ts", import.meta.url)),
    ],
    cwd: spec.cwd,
    env: { ELECTRON_RUN_AS_NODE: "1" },
    stdio: {
      stdin: "pipe",
      stdout: "pipe",
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
        throw new Error("受管进程未完成回收。");
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
    if (!handle.stdout || !handle.stdin)
      throw new Error("无法启动受管进程 worker。");
    const pid = await readWorkerPid(handle.stdout);
    job = ownProcessTree(pid);
    handle.stdin.write(JSON.stringify(spec) + "\n");
    return {
      pid,
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
            // Busy Windows hosts can report hundreds of thousands of bytes of
            // unrelated TCP connections; a truncated table must fail closed.
            stdout: { maxBytes: 4 * 1024 * 1024 },
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
    await stop();
    throw error;
  }
}
