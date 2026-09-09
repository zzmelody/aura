import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { formatHttpUrl } from "../src/http-server.ts";
import { resolveRuntimeConfig } from "../src/runtime-config.ts";

test("runtime configuration resolves paths and validates network settings", () => {
  const root = resolve("fixture-runtime-root");
  const config = resolveRuntimeConfig({ root, host: "::1", port: 4_321 });

  assert.equal(config.root, root);
  assert.equal(config.host, "::1");
  assert.equal(config.port, 4_321);
  assert.equal(config.dshHome, resolve(root, ".aura", "dsh"));
  assert.equal(
    config.credentialPath,
    resolve(root, ".aura", "dsh", ".credentials.yaml"),
  );
  assert.equal(formatHttpUrl(config.host, config.port), "http://[::1]:4321");
  assert.throws(() => resolveRuntimeConfig({ port: 0 }), /port is invalid/);
  assert.throws(() => resolveRuntimeConfig({ host: " " }), /cannot be empty/);
});
