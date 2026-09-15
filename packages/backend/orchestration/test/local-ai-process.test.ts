import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Context } from "@deepseek-ai/cordis";
import LocalSubprocessRuntime from "@deepseek-ai/dsh-subprocess-local";
import { launchOwned } from "../src/local-ai/process.ts";
import { Hono } from "hono";
import { serve } from "@hono/node-server";

const supported =
  process.platform === "win32" &&
  process.arch === "x64" &&
  Number(process.versions.node.split(".")[0]) >= 24;
async function eventually(check: () => Promise<boolean>) {
  for (let n = 0; n < 100; n++) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error("Owned process cleanup did not settle");
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
const fixture = fileURLToPath(
  new URL("./fixtures/local-ai-owner.ts", import.meta.url),
);

test(
  "Windows Job kills worker descendants and releases GPU lease on hard owner death",
  { skip: !supported, timeout: 20_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "aura-ai-job-"));
    const path = join(root, "pids.json");
    // Raw direct kill is deliberate here: simulate a host crash without tree cleanup.
    const owner = spawn(process.execPath, [fixture, "owner", path], {
      windowsHide: true,
      stdio: "ignore",
    });
    const exited = new Promise((resolve) => owner.once("exit", resolve));
    let pids: { child: number; grandchild: number } | undefined;
    try {
      await eventually(async () => {
        try {
          pids = JSON.parse(await readFile(path, "utf8"));
          return true;
        } catch {
          return false;
        }
      });
      assert(pids);
      assert(alive(pids.child));
      assert(alive(pids.grandchild));
      const blocked = spawn(process.execPath, [fixture, "lease", path], {
        windowsHide: true,
        stdio: "ignore",
      });
      assert.notEqual(
        await new Promise((resolve) => blocked.once("exit", resolve)),
        0,
      );
      owner.kill();
      await exited;
      await eventually(
        async () => !alive(pids!.child) && !alive(pids!.grandchild),
      );
      const recovered = spawn(process.execPath, [fixture, "lease", path], {
        windowsHide: true,
        stdio: "ignore",
      });
      assert.equal(
        await new Promise((resolve) => recovered.once("exit", resolve)),
        0,
      );
    } finally {
      owner.kill();
      await exited;
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "owned process stop is idempotent and kills descendants; EOF before handshake launches nothing",
  { skip: !supported, timeout: 20_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "aura-ai-stop-"));
    const path = join(root, "pids.json");
    const ctx = new Context();
    const sub = new LocalSubprocessRuntime(ctx);
    const child = launchOwned(sub, {
      argv: [process.execPath, fixture, "child", path],
      cwd: root,
      env: {},
    });
    try {
      await eventually(async () => {
        try {
          await readFile(path);
          return true;
        } catch {
          return false;
        }
      });
      const pids = JSON.parse(await readFile(path, "utf8")) as {
        child: number;
        grandchild: number;
        port: number;
      };
      assert.equal(
        await child.ownsPort(pids.port, new AbortController().signal),
        true,
      );
      const external = serve({
        fetch: new Hono().fetch,
        hostname: "127.0.0.1",
        port: 0,
      });
      try {
        if (!external.listening)
          await new Promise((resolve) => external.once("listening", resolve));
        const address = external.address();
        assert(address && typeof address === "object");
        assert.equal(
          await child.ownsPort(address.port, new AbortController().signal),
          false,
        );
      } finally {
        await new Promise((resolve) => external.close(resolve));
      }
      await Promise.all([child.stop(), child.stop()]);
      await eventually(
        async () => !alive(pids.child) && !alive(pids.grandchild),
      );
      const gated = sub.spawn({
        argv: [
          process.execPath,
          fileURLToPath(new URL("../src/local-ai/worker.ts", import.meta.url)),
        ],
        cwd: root,
        stdio: {
          stdin: "pipe",
          stdout: { maxBytes: 1024 },
          stderr: { maxBytes: 1024 },
        },
        graceMs: 100,
      });
      gated.stdin!.end();
      assert.equal(await gated.waitForExit(AbortSignal.timeout(5_000)), true);
    } finally {
      await child.stop();
      await ctx.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);
