import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OrchestrationHost } from "../src/dsh/host.ts";
import { CodedFlowError } from "@aura/protocol/errors";
import type { AuraPluginStatus, FlowCatalog } from "@aura/protocol/types";

test(
  "readiness follows the real DSH listener through startup, hangs, exit and recovery",
  { timeout: 30000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "aura-host-health-"));
    const plugin: AuraPluginStatus = {
      id: "example.metadata",
      name: "Original plugin",
      version: "1.0.0",
      enabled: true,
      available: true,
      localization: {
        nameKey: "name",
        catalogs: {
          en: {
            name: "Translated plugin",
            ...Object.fromEntries(
              Array.from({ length: 12 }, (_, i) => [
                `padding${i}`,
                "x".repeat(3_000),
              ]),
            ),
          },
        },
      },
    };
    assert.ok(
      JSON.stringify(plugin.localization).length > 32_768,
      "UI resources must not enter Windows child-process environment variables",
    );
    const host = new OrchestrationHost({
      root,
      dshHome: join(root, ".aura", "dsh"),
      modelURL: "http://127.0.0.1:1/v1",
      plugins: [plugin],
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
    const catalog = await host.request<FlowCatalog>("catalog");
    assert.deepEqual(catalog.plugins?.[0].localization, plugin.localization);
    const raw = (await running.rpc.request("catalog", {})) as {
      ok: boolean;
      data: FlowCatalog;
    };
    assert.equal(raw.ok, true);
    assert.equal(
      raw.data.plugins?.[0].localization,
      undefined,
      "execution and model-tool catalogs never carry display resources",
    );
    const updated = {
      ...plugin,
      localization: {
        nameKey: "name",
        catalogs: { en: { name: "Updated plugin" } },
      },
    };
    await host.configureContributions({
      flowRoots: [],
      actionRoots: [],
      backendRoots: [],
      plugins: [updated],
    });
    assert.deepEqual(
      (await host.request<FlowCatalog>("catalog")).plugins?.[0].localization,
      updated.localization,
    );
    const after = (await running.rpc.request("catalog", {})) as {
      data: FlowCatalog;
    };
    assert.equal(after.data.plugins?.[0].localization, undefined);
    await assert.rejects(host.request("missing-operation"), (error) => {
      assert.ok(error instanceof CodedFlowError);
      assert.equal(error.status, 404);
      assert.equal(error.message, "未知的编排操作。");
      assert.deepEqual(error.details, { code: "flow_endpoint_not_found" });
      return true;
    });
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
