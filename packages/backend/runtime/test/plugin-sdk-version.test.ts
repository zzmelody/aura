import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { pluginSdkVersion } from "../src/plugin-sdk-version.ts";

const require = createRequire(import.meta.url);

test("runtime validates plugins against the installed Plugin SDK version", () => {
  const manifest = require("@aura/plugin-sdk/package.json") as {
    version: string;
  };

  assert.equal(pluginSdkVersion, manifest.version);
});
