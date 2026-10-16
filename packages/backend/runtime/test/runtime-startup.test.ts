import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

test(
  "standalone readiness is 503 during DSH startup and AURA_READY follows the handshake",
  { timeout: 30000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "aura-server-ready-"));
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(
          new URL("../../../../apps/server/server.ts", import.meta.url),
        ),
      ],
      {
        env: { ...process.env, AURA_ROOT: root, PORT: "0" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const exited = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    t.after(async () => {
      child.kill();
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      await exited;
      clearTimeout(timer);
      await rm(root, { recursive: true, force: true });
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    // Only project safe stderr in assertions; the runtime owns its diagnostic log.
    child.stderr.resume();
    const deadline = Date.now() + 20000;
    let url: string | undefined;
    while (!url && Date.now() < deadline) {
      try {
        const descriptor = JSON.parse(
          await readFile(join(root, ".aura", "service.json"), "utf8"),
        ) as { base_url: string };
        url = new URL(descriptor.base_url).origin;
      } catch {
        await delay(25);
      }
    }
    assert.ok(url, "API publishes its address before DSH readiness");
    const starting = await fetch(url + "/health");
    assert.equal(starting.status, 503);
    assert.equal((await starting.json()).dsh.status, "starting");
    assert.doesNotMatch(output, /AURA_READY/);
    while (!output.includes("AURA_READY") && Date.now() < deadline)
      await delay(25);
    assert.match(output, /AURA_READY/);
    const ready = await fetch(url + "/health");
    assert.equal(ready.status, 200);
    assert.equal((await ready.json()).dsh.status, "ready");
  },
);
