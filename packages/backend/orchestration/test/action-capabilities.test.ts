import assert from "node:assert/strict";
import test from "node:test";
import type { AuraCapabilityClient } from "../src/action-api.ts";
import { actionCapabilities } from "../src/actions.ts";
import { AuraCapabilityRouter } from "../src/capability-router.ts";
import { TripoGameAssetCapability } from "../src/tripo-game-asset.ts";

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

test("Tripo game asset capability validates and routes one bounded operation", async () => {
  const calls: unknown[] = [];
  const tripo = new TripoGameAssetCapability({
    async generateGameAsset(input, signal) {
      calls.push(input);
      assert.equal(signal.aborted, false);
      return {
        outputDirectory: "F:\\project\\assets\\generated\\crate-task",
        modelPath: "F:\\project\\assets\\generated\\crate-task\\model.glb",
        imagePaths: {
          front: "front.png",
          left: "left.png",
          back: "back.png",
          right: "right.png",
        },
        manifestPath: "manifest.json",
        taskIds: {
          front: "front-task",
          left: "left-task",
          back: "back-task",
          right: "right-task",
          model: "model-task",
        },
        creditsConsumed: 50,
        imageModel: "chat_image_2.5_sunburst",
        modelVersion: "P1-20260311",
        faceLimit: 12_000,
      };
    },
  });
  const router = new AuraCapabilityRouter([["aura.tripo.game-asset", tripo]]);
  const signal = new AbortController().signal;
  const result = await router.invoke(
    "aura.tripo.game-asset",
    "generate",
    {
      prompt: "a low-poly wooden crate",
      outputDirectory: "F:\\project\\assets\\generated",
      faceLimit: 12_000,
    },
    signal,
  );

  assert.equal((result as { faceLimit: number }).faceLimit, 12_000);
  assert.deepEqual(calls, [
    {
      prompt: "a low-poly wooden crate",
      outputDirectory: "F:\\project\\assets\\generated",
      faceLimit: 12_000,
    },
  ]);
  await assert.rejects(
    router.invoke(
      "aura.tripo.game-asset",
      "unknown",
      { prompt: "crate", outputDirectory: "F:\\output" },
      signal,
    ),
    /Unsupported Tripo game-asset operation/u,
  );
});
