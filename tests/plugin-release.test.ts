import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { loadAuraPlugins } from "@aura/extensions";
import { buildPlugins } from "../scripts/build-plugins.ts";
import { PluginCapabilities } from "../packages/backend/orchestration/src/plugin-capabilities.ts";
import { memoryBackend } from "./self-media/plugin-fixture.ts";

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
  await mkdir(join(root, "installed", "node_modules", "@aura"), {
    recursive: true,
  });
  await symlink(
    resolve("packages/backend/plugin-sdk"),
    join(root, "installed", "node_modules", "@aura", "plugin-sdk"),
    process.platform === "win32" ? "junction" : "dir",
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

test("staged self-media backend loads from release assets through public runtime peers", async () => {
  const root = await mkdtemp(join(tmpdir(), "aura-product-release-"));
  const install = join(root, "installed");
  const providers = new PluginCapabilities({
    dataRoot: join(root, "state"),
    backend: memoryBackend(root),
  });
  try {
    await buildPlugins(resolve("plugins"), join(install, "plugins"), false);
    for (const [name, target] of [
      ["@aura/plugin-sdk", "packages/backend/plugin-sdk"],
      ["@aura/protocol", "packages/shared/protocol"],
      ["hono", "apps/server/node_modules/hono"],
      ["zod", "apps/server/node_modules/zod"],
    ]) {
      const link = join(install, "node_modules", name);
      await mkdir(join(link, ".."), { recursive: true });
      await symlink(
        await realpath(resolve(target)),
        link,
        process.platform === "win32" ? "junction" : "dir",
      );
    }
    const resolution = await loadAuraPlugins({
      configPath: join(root, "plugins.json"),
      defaultPluginsDirectory: join(install, "plugins"),
      auraVersion: "0.1.0",
      pluginSdkVersion: "1.4.0",
    });
    const plugin = resolution.plugins.find((item) => item.id === "self-media");
    assert.ok(plugin?.available, JSON.stringify(resolution.plugins));
    const entry = resolution.capabilityRoots.find(
      (item) => item.plugin.id === "self-media",
    )!;
    const { path, ...metadata } = entry;
    await providers.replace([{ ...metadata, root: path }]);
    assert.deepEqual(
      await providers.invokeFromPage(
        "self-media",
        "self-media/studio",
        "request",
        { path: "/content-projects", method: "GET" },
        new AbortController().signal,
      ),
      { status: 200, data: [] },
    );
    assert.ok(entry.http?.entry.startsWith(join(install, "plugins")));
    assert.equal(
      await readFile(
        join(
          install,
          "plugins/self-media/presets/content-editor-v1/preset.yml",
        ),
        "utf8",
      ).then((value) => Boolean(value)),
      true,
    );
    await assert.rejects(
      readFile(join(install, "plugins/self-media/backend/service.ts")),
      { code: "ENOENT" },
    );
  } finally {
    await providers.close();
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});
