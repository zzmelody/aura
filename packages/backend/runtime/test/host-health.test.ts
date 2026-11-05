import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OrchestrationHost } from "../src/dsh/host.ts";

test(
  "readiness follows the real DSH listener through startup, hangs, exit and recovery",
  { timeout: 30000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "aura-host-health-"));
    const host = new OrchestrationHost({
      root,
      dshHome: join(root, ".aura", "dsh"),
      modelURL: "http://127.0.0.1:1/v1",
    });
    t.after(async () => {
      await host.close();
      await rm(root, { recursive: true, force: true });
    });
    assert.deepEqual(await host.health(), { status: "unavailable" });
    const opening = host.open();
    assert.deepEqual(await host.health(), { status: "starting" });
    const running = await opening;
    assert.deepEqual(await host.health(), { status: "ready" });
    if (process.platform !== "win32") {
      running.child.kill("SIGSTOP");
      try {
        assert.deepEqual(await host.health(), { status: "unavailable" });
      } finally {
        running.child.kill("SIGCONT");
      }
      assert.deepEqual(await host.health(), { status: "ready" });
    }
    running.child.kill();
    await running.exited;
    assert.deepEqual(await host.health(), { status: "unavailable" });
    await host.open();
    assert.deepEqual(await host.health(), { status: "ready" });
    await host.close();
    assert.deepEqual(await host.health(), { status: "stopped" });
  },
);

test("a failed start is unhealthy and a closed host never starts DSH", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aura-host-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dshHome = join(root, "not-a-directory");
  await writeFile(dshHome, "fixture");
  const host = new OrchestrationHost({
    root,
    dshHome,
    modelURL: "http://127.0.0.1:1/v1",
  });
  await assert.rejects(host.open(), /aura-host.log/);
  assert.deepEqual(await host.health(), { status: "unavailable" });
  await host.close();
  await assert.rejects(host.open(), /关闭/);
});
