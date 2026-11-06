import assert from "node:assert/strict";
import test from "node:test";
import type { AuraPluginStatus } from "@aura/protocol/types";
import {
  executionPlugins,
  catalogLocalization,
} from "../src/plugin-localization.ts";

test("plugin diagnostics are attached only to matching public statuses and excluded from execution snapshots", () => {
  const plugins: AuraPluginStatus[] = [
    {
      name: "Local plugin",
      enabled: true,
      available: false,
      error: "old diagnostic",
      errorDetails: { code: "plugin_sdk_incompatible" },
    },
  ];
  const raw = executionPlugins(plugins);
  assert.equal(raw[0]!.errorDetails, undefined);
  assert.equal(raw[0]!.error, "old diagnostic");
  const display = catalogLocalization(
    { flows: [], presets: [], plugins: raw },
    plugins,
  );
  assert.deepEqual(display.plugins![0]!.errorDetails, {
    code: "plugin_sdk_incompatible",
  });
  raw[0]!.error = "different diagnostic";
  assert.equal(
    catalogLocalization({ flows: [], presets: [], plugins: raw }, plugins)
      .plugins![0]!.errorDetails,
    undefined,
  );
  assert.equal(plugins[0]!.error, "old diagnostic");
});
