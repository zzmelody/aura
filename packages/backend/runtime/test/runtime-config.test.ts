import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { formatHttpUrl } from "../src/http-server.ts";
import {
  isLoopbackRuntimeHost,
  resolveRuntimeConfig,
} from "../src/runtime-config.ts";

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
  assert.equal(
    config.tripoCredentialPath,
    resolve(root, ".aura", "tripo", "api-key"),
  );
  assert.equal(config.tripoRegion, "global");
  assert.equal(config.pluginConfigPath, resolve(root, ".aura", "plugins.json"));
  assert.match(
    config.worldAgentSessionPath,
    /Veya[/\\]world-agent-session\.json$/u,
  );
  assert.equal(formatHttpUrl(config.host, config.port), "http://[::1]:4321");
  assert.equal(isLoopbackRuntimeHost("::1"), true);
  assert.equal(isLoopbackRuntimeHost("[::1]"), true);
  assert.equal(isLoopbackRuntimeHost("127.0.0.1"), true);
  assert.equal(isLoopbackRuntimeHost("0.0.0.0"), false);
  assert.equal(resolveRuntimeConfig({ root, port: 0 }).port, 0);
  assert.throws(() => resolveRuntimeConfig({ port: -1 }), /port is invalid/);
  assert.throws(() => resolveRuntimeConfig({ port: 65_536 }), /port is invalid/);
  const previous = process.env.AURA_ROOT;
  try {
    process.env.AURA_ROOT = resolve("fixture-env-root");
    assert.equal(resolveRuntimeConfig().root, resolve("fixture-env-root"));
    assert.equal(resolveRuntimeConfig({ root }).root, root);
  } finally {
    if (previous === undefined) delete process.env.AURA_ROOT;
    else process.env.AURA_ROOT = previous;
  }
  assert.throws(() => resolveRuntimeConfig({ host: " " }), /cannot be empty/);
});
