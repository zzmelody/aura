import assert from "node:assert/strict";
import test from "node:test";
import type { AuraCapabilityClient } from "../src/action-api.ts";
import { actionCapabilities } from "../src/actions.ts";

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
      capabilities: ["aura.veya.world-agent"],
    },
    host,
  );
  const undeclared = actionCapabilities(
    { id: "example.plugin/plain", capabilities: [] },
    host,
  );
  const signal = new AbortController().signal;

  assert.deepEqual(
    await granted?.invoke("aura.veya.world-agent", "worlds.list", {}, signal),
    { ok: true },
  );
  assert.throws(
    () =>
      undeclared?.invoke("aura.veya.world-agent", "worlds.list", {}, signal),
    /was not declared by example\.plugin\/plain/u,
  );
  assert.deepEqual(calls, ["aura.veya.world-agent:worlds.list"]);
});
