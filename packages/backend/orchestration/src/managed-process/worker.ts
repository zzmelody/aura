import { Context } from "@deepseek-ai/cordis";
import LocalSubprocessRuntime from "@deepseek-ai/dsh-subprocess-local";
import type { SubprocessHandle } from "@deepseek-ai/dsh-subprocess";

// This internal worker starts nothing until its owner has assigned the Windows
// Job and sent a launch message. EOF before that handshake cannot orphan Python.
const ctx = new Context();
const subprocess = new LocalSubprocessRuntime(ctx);
let child: SubprocessHandle | undefined;
let stopping = false;
let buffer = "";
let launched = false;
const startup = setTimeout(() => void stop(), 15_000);
async function stop() {
  if (stopping) return;
  stopping = true;
  clearTimeout(startup);
  child?.terminate();
  await ctx.fiber.dispose();
  process.exit(0);
}
process.stdin.setEncoding("utf8");
process.stdin.on("end", () => void stop());
process.stdin.on("error", () => void stop());
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
process.stdin.on("data", (chunk: string) => {
  if (launched || stopping) return;
  buffer += chunk;
  if (buffer.length > 32_768) return void stop();
  if (!buffer.includes("\n")) return;
  clearTimeout(startup);
  launched = true;
  try {
    const spec = JSON.parse(buffer.slice(0, buffer.indexOf("\n"))) as {
      argv: string[];
      cwd: string;
      env: Record<string, string>;
    };
    buffer = "";
    child = subprocess.spawn({
      ...spec,
      stdio: { stdin: "ignore", stdout: "inherit", stderr: "inherit" },
      graceMs: 1_000,
    });
    void child.done.then(
      () => stop(),
      () => stop(),
    );
  } catch {
    void stop();
  }
});
// Publish only our PID; the owner attaches this idle worker to its Job before
// sending the launch spec. DSH no longer exposes a PID on SubprocessHandle.
process.stdout.write(JSON.stringify({ pid: process.pid }) + "\n");
