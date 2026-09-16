import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { ActionRun, FlowCatalog, JsonValue } from "@aura/protocol/types";
import { OrchestrationHost } from "../src/index.ts";

const sessionPath = process.env.AURA_VEYA_WORLD_AGENT_SESSION;
const pluginRoot = process.env.AURA_VEYA_PLUGIN_ROOT;
const enabled = process.env.AURA_VEYA_COOKER_LIVE === "1";

function object(value: JsonValue | undefined): Record<string, JsonValue> {
  assert.ok(value && !Array.isArray(value) && typeof value === "object");
  return value;
}

test(
  "Aura invokes a complete Veya Cooker Lua pipeline through the plugin capability",
  {
    timeout: 120_000,
    skip:
      enabled && sessionPath && pluginRoot
        ? false
        : "set AURA_VEYA_COOKER_LIVE=1, AURA_VEYA_WORLD_AGENT_SESSION and AURA_VEYA_PLUGIN_ROOT",
  },
  async () => {
    const dshHome = await mkdtemp(join(tmpdir(), "aura-veya-cooker-live-"));
    const plugin = {
      id: "zzmelody.veya",
      name: "Veya Creative",
      version: "0.3.0",
    };
    const host = new OrchestrationHost({
      root: process.cwd(),
      dshHome,
      modelURL: "http://127.0.0.1:1/v1",
      actionRoots: [
        {
          root: resolve(pluginRoot!, "actions"),
          namespace: plugin.id,
          plugin,
          capabilities: ["aura.veya.world-agent"],
        },
      ],
      plugins: [{ ...plugin, enabled: true, available: true }],
      worldAgentSessionPath: resolve(sessionPath!),
    });

    const invoke = async (
      action: string,
      input: Record<string, JsonValue>,
    ): Promise<Record<string, JsonValue>> => {
      const run: ActionRun = await host.invokeAction(action, {
        input,
        mode: "demo",
      });
      assert.equal(run.status, "completed", JSON.stringify(run));
      return object(run.output);
    };

    try {
      const catalog = await host.request<FlowCatalog>("catalog");
      for (const id of [
        "cooker-capabilities",
        "cooker-submit",
        "cooker-status",
        "cooker-cancel",
      ]) {
        const action = catalog.actions?.find(
          (entry) => entry.id === `zzmelody.veya/${id}`,
        );
        assert.equal(action?.available, true, JSON.stringify(action));
      }
      const capabilities = await invoke(
        "zzmelody.veya/cooker-capabilities",
        {},
      );
      assert.equal(capabilities.available, true);
      const cooker = object(capabilities.cooker);
      assert.ok(
        Array.isArray(cooker.operations) &&
          cooker.operations.includes("run-recipe"),
      );

      const suffix = Date.now().toString(36);
      const output = `res://assets/generated/aura_live_${suffix}/r1/example.res`;
      const manifest = `res://assets/generated/aura_live_${suffix}/r1/asset.manifest.json`;
      const pack = `res://content/releases/aura-live-${suffix}.pck`;
      const pipeline = [
        `local output = ${JSON.stringify(output)}`,
        "return {",
        ' {name="generate",operation="run-recipe",source="res://content/scripts/cooker/aura_recipe.luau",output=output},',
        ' {name="validate",operation="validate-resource",source=output,type="BoxMesh"},',
        ` {name="manifest",operation="asset-manifest",output=${JSON.stringify(manifest)},asset_id="aura_live_${suffix}",revision=1,kind="model",entry="example.res",files={"example.res"},source="aura-live-test",generator="Aura Agent Lua"},`,
        ` {name="pack",operation="pack",files={output},output=${JSON.stringify(pack)}},`,
        "}",
      ].join("\n");
      const submitted = await invoke("zzmelody.veya/cooker-submit", {
        pipelineSource: pipeline,
        sources: [
          {
            path: "content/scripts/cooker/aura_recipe.luau",
            source: 'return cooker.primitive("box", {size={3,2,1}})',
          },
        ],
        timeoutSeconds: 30,
      });
      assert.equal(submitted.status, "queued");
      assert.equal(typeof submitted.operation_id, "string");

      let result = submitted;
      for (
        let attempt = 0;
        attempt < 300 &&
        !["succeeded", "failed", "cancelled"].includes(
          String(result.status),
        );
        attempt += 1
      ) {
        await delay(50);
        result = await invoke("zzmelody.veya/cooker-status", {
          operationId: submitted.operation_id!,
        });
      }

      assert.equal(result.status, "succeeded", JSON.stringify(result));
      assert.equal(object(result.cooker).steps?.length, 4);
      assert.equal(result.assets?.length, 1);

      const terminalCancel = await invoke("zzmelody.veya/cooker-cancel", {
        operationId: submitted.operation_id!,
      });
      assert.equal(terminalCancel.status, "succeeded");
    } finally {
      await host.close();
      await rm(dshHome, { recursive: true, force: true });
    }
  },
);
