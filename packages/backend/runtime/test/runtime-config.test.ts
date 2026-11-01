import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { formatHttpUrl } from "../src/http-server.ts";
import {
  isLoopbackRuntimeHost,
  resolveRuntimeConfig,
} from "../src/runtime-config.ts";

test("runtime uses GPT-6.1 Sol unless AURA_CODEX_MODEL overrides it", () => {
  const previous = process.env.AURA_CODEX_MODEL;
  try {
    delete process.env.AURA_CODEX_MODEL;
    assert.equal(resolveRuntimeConfig().codexModel, "gpt-6.1-sol");
    process.env.AURA_CODEX_MODEL = "gpt-5.6-terra";
    assert.equal(resolveRuntimeConfig().codexModel, "gpt-5.6-terra");
  } finally {
    if (previous === undefined) delete process.env.AURA_CODEX_MODEL;
    else process.env.AURA_CODEX_MODEL = previous;
  }
});

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
  assert.equal(config.defaultPluginsDirectory, resolve(root, "plugins"));
  assert.equal(
    resolveRuntimeConfig({ root, tempDir: "scratch" }).tempDir,
    resolve("scratch"),
  );
  assert.equal(
    resolveRuntimeConfig({ root, defaultWorkspace: "chats" }).defaultWorkspace,
    resolve("chats"),
  );
  assert.equal(
    resolveRuntimeConfig({ root, defaultPluginsDirectory: "installed/plugins" })
      .defaultPluginsDirectory,
    resolve("installed/plugins"),
  );
  assert.equal(formatHttpUrl(config.host, config.port), "http://[::1]:4321");
  assert.equal(isLoopbackRuntimeHost("::1"), true);
  assert.equal(isLoopbackRuntimeHost("[::1]"), true);
  assert.equal(isLoopbackRuntimeHost("127.0.0.1"), true);
  assert.equal(isLoopbackRuntimeHost("0.0.0.0"), false);
  assert.equal(resolveRuntimeConfig({ root, port: 0 }).port, 0);
  assert.throws(() => resolveRuntimeConfig({ port: -1 }), /port is invalid/);
  assert.throws(
    () => resolveRuntimeConfig({ port: 65_536 }),
    /port is invalid/,
  );
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

test("scratch space defaults under local/ and conversations default outside the root", () => {
  const root = resolve("fixture-runtime-root");
  const saved = {
    temp: process.env.AURA_TEMP_DIR,
    workspace: process.env.AURA_DEFAULT_WORKSPACE,
  };
  try {
    delete process.env.AURA_TEMP_DIR;
    delete process.env.AURA_DEFAULT_WORKSPACE;
    const config = resolveRuntimeConfig({ root });
    assert.equal(config.tempDir, resolve(root, "local", "runtime"));
    assert.equal(
      config.defaultWorkspace,
      resolve(homedir(), "Documents", "Aura"),
    );
    // Cleaning the Aura root must never remove conversation files.
    assert.ok(!config.defaultWorkspace.startsWith(root));

    process.env.AURA_TEMP_DIR = resolve("env-scratch");
    process.env.AURA_DEFAULT_WORKSPACE = resolve("env-chats");
    assert.equal(
      resolveRuntimeConfig({ root }).tempDir,
      resolve("env-scratch"),
    );
    assert.equal(
      resolveRuntimeConfig({ root }).defaultWorkspace,
      resolve("env-chats"),
    );
  } finally {
    for (const [name, value] of [
      ["AURA_TEMP_DIR", saved.temp],
      ["AURA_DEFAULT_WORKSPACE", saved.workspace],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
