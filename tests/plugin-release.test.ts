import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadAuraPlugins } from "@aura/extensions";
import { buildPlugins } from "../scripts/build-plugins.ts";

test("release plugins preserve nested layout and load without source plugin directories", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aura-plugin-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const plugin = join(source, "personal", "chat");
  await mkdir(join(plugin, "capabilities", "echo"), { recursive: true });
  await writeFile(
    join(plugin, "package.json"),
    JSON.stringify({ type: "module", files: ["capabilities"] }),
  );
  await writeFile(
    join(plugin, "aura.plugin.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "test.release",
      name: "Release",
      version: "0.1.0",
      engines: { aura: "^0.1.0", pluginSdk: "^1.3.0" },
      contributes: { capabilities: "./capabilities" },
    }),
  );
  await writeFile(
    join(plugin, "capabilities", "echo", "echo.capability.js"),
    'export { defineCapabilityProvider as default } from "@aura/plugin-sdk/capability";',
  );
  await mkdir(join(plugin, "capabilities", "echo", "cache"));
  await writeFile(
    join(plugin, "capabilities", "echo", "cache", "private.json"),
    "private",
  );
  await writeFile(
    join(plugin, "capabilities", "echo", "private.key"),
    "private",
  );
  await writeFile(join(plugin, "unlisted.txt"), "private");
  const output = join(root, "installed", "plugins");
  await buildPlugins(source, output, false);
  await rm(source, { recursive: true, force: true });
  const installed = join(output, "personal", "chat");
  for (const file of [
    "unlisted.txt",
    "capabilities/echo/cache/private.json",
    "capabilities/echo/private.key",
  ]) {
    await assert.rejects(readFile(join(installed, file)), { code: "ENOENT" });
  }
  // Released plugins carry no SDK; the host provides it at load time.
  await assert.rejects(
    readFile(
      join(installed, "node_modules", "@aura", "plugin-sdk", "package.json"),
    ),
    { code: "ENOENT" },
  );
  const resolution = await loadAuraPlugins({
    configPath: join(root, "user-data", "plugins.json"),
    defaultPluginsDirectory: output,
    auraVersion: "0.1.0",
    pluginSdkVersion: "1.3.0",
  });
  assert.equal(
    resolution.plugins[0]?.available,
    true,
    resolution.plugins[0]?.error,
  );
  assert.equal(resolution.capabilityRoots[0]?.plugin.id, "test.release");
});

test("release rejects undeclared files and output inside source", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aura-plugin-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "aura.plugin.json"), "{}");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ files: ["../outside"] }),
  );
  await assert.rejects(
    buildPlugins(root, join(root, "dist"), false),
    /separate/u,
  );
  await assert.rejects(buildPlugins(root, `${root}-output`, false), /outside/u);
  t.after(() => rm(`${root}-output`, { recursive: true, force: true }));
});
