import assert from "node:assert/strict";
import test from "node:test";
import { type AuraCapabilityClient } from "../src/action-api.ts";
import { actionCapabilities } from "../src/actions.ts";
import { AuraCapabilityRouter } from "../src/capability-router.ts";
import {
  legacyTripoCapability,
  LEGACY_TRIPO_PERMISSION,
} from "../src/plugin-capability-compatibility.ts";

test("Action host capabilities are limited to manifest grants", async () => {
  const calls: string[] = [];
  const host: AuraCapabilityClient = {
    async invoke(capability, operation) {
      calls.push(`${capability}:${operation}`);
      return { ok: true };
    },
  };
  const granted = actionCapabilities(
    {
      id: "example.plugin/world-list",
      permissions: ["aura.codex.image"],
    },
    host,
  );
  const undeclared = actionCapabilities(
    { id: "example.plugin/plain", permissions: [] },
    host,
  );
  const signal = new AbortController().signal;
  assert.deepEqual(
    await granted?.invoke("aura.codex.image", "generate", {}, signal),
    { ok: true },
  );
  assert.throws(
    () => undeclared?.invoke("aura.codex.image", "generate", {}, signal),
    /was not declared by example\.plugin\/plain/u,
  );
  assert.deepEqual(calls, ["aura.codex.image:generate"]);
});

test("Action capability forwards its durable Run identity to the host", async () => {
  const seen: unknown[] = [];
  const host = new AuraCapabilityRouter([
    [
      "aura.codex.image",
      {
        async invoke(_capability, _operation, _input, _signal, context) {
          seen.push(context);
          return { ok: true };
        },
      },
    ],
  ]);
  const granted = actionCapabilities(
    { id: "example.plugin/model", permissions: ["aura.codex.image"] },
    host,
    "creation-child-run",
  );
  await granted?.invoke(
    "aura.codex.image",
    "generate",
    {},
    new AbortController().signal,
  );
  assert.deepEqual(seen, [{ runId: "creation-child-run" }]);
});

test("the legacy Tripo permission dispatches only supported calls to the plugin", async () => {
  const calls: unknown[] = [];
  let enabled = true;
  const host = legacyTripoCapability(() => ({
    async request(method, input, signal) {
      if (!enabled) throw new Error("plugin_request_unavailable");
      calls.push({ method, input, signal });
      return { unreconciled: false, requests: [] };
    },
  }));
  const signal = new AbortController().signal;
  assert.deepEqual(
    await host.invoke(
      LEGACY_TRIPO_PERMISSION,
      "ledger",
      { scope: "test" },
      signal,
    ),
    { unreconciled: false, requests: [] },
  );
  assert.deepEqual(calls, [
    {
      method: "aura.tripo/legacy-capability",
      input: { operation: "ledger", input: { scope: "test" } },
      signal,
    },
  ]);
  await assert.rejects(
    host.invoke(LEGACY_TRIPO_PERMISSION, "save-settings", {}, signal),
    /操作无效/u,
  );
  enabled = false;
  await assert.rejects(
    host.invoke(LEGACY_TRIPO_PERMISSION, "ledger", { scope: "test" }, signal),
    /启用 Tripo 插件/u,
  );
});
