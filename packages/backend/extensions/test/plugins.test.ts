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
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  AuraPluginConfigurationError,
  AuraPluginManager,
  loadAuraPlugins,
  readAuraPluginConfiguration,
} from "../src/index.ts";

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "aura-plugins-test-"));
  try {
    await run(root);
  } finally {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith("aura-plugins-test-"));
    await rm(root, { recursive: true, force: true });
  }
}

async function writePlugin(
  root: string,
  id = "example.tools",
  capabilities: string[] = [],
) {
  const plugin = join(root, id);
  await mkdir(join(plugin, "actions", "echo"), { recursive: true });
  await mkdir(join(plugin, "flows", "report"), { recursive: true });
  await writeFile(
    join(plugin, "aura.plugin.json"),
    JSON.stringify({
      schemaVersion: 1,
      id,
      name: "Example tools",
      version: "0.1.0",
      engines: { aura: ">=0.1.0 <0.2.0", pluginSdk: "^1.0.0" },
      contributes: { actions: "./actions", flows: "./flows" },
      capabilities,
    }),
  );
  await writeFile(
    join(plugin, "package.json"),
    JSON.stringify({ name: id, version: "0.1.0", type: "module" }),
  );
  await writeFile(
    join(plugin, "actions", "echo", "echo.action.js"),
    "export default {};\n",
  );
  await writeFile(
    join(plugin, "flows", "report", "report.flow.js"),
    "export default {};\n",
  );
  return plugin;
}

const options = (configPath: string) => ({
  configPath,
  auraVersion: "0.1.0",
  pluginSdkVersion: "1.0.0",
});

test("default plugins recurse through categories, stop at manifests and skip links", async () =>
  fixture(async (root) => {
    const plugins = join(root, "plugins");
    const category = join(plugins, "personal", "chat");
    const first = await writePlugin(category, "nested.tools");
    await writePlugin(first, "must.not.discover");
    await writePlugin(join(plugins, "node_modules"), "must.not.load");
    const external = await writePlugin(join(root, "external"), "outside.tools");
    await symlink(
      external,
      join(plugins, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const config = join(root, ".aura", "plugins.json");
    const manager = await AuraPluginManager.create({
      ...options(config),
      defaultPluginsDirectory: plugins,
    });
    assert.deepEqual(
      manager.resolution.plugins.map((plugin) => plugin.id),
      ["nested.tools"],
    );
    assert.equal(manager.resolution.plugins[0]?.available, true);
    assert.equal((await manager.settings()).plugins[0]?.path, first);
    await assert.rejects(readFile(config), { code: "ENOENT" });
    await manager.updateSettings({
      plugins: [{ path: first, enabled: false }],
    });
    assert.equal(manager.resolution.actionRoots.length, 0);
    assert.equal((await manager.settings()).plugins[0]?.enabled, false);
  }));

test("explicit plugin ID overrides defaults, preserving disabled state and settings", async () =>
  fixture(async (root) => {
    const plugins = join(root, "plugins");
    await writePlugin(plugins, "override.tools");
    const external = await writePlugin(
      join(root, "external"),
      "override.tools",
    );
    const config = join(root, "plugins.json");
    await writeFile(
      config,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            path: external,
            enabled: false,
            trust: "local",
            settings: { retained: true },
          },
        ],
      }),
    );
    const manager = await AuraPluginManager.create({
      ...options(config),
      defaultPluginsDirectory: plugins,
    });
    assert.equal(manager.resolution.plugins.length, 1);
    assert.equal(manager.resolution.plugins[0]?.enabled, false);
    assert.deepEqual((await manager.settings()).plugins[0]?.settings, {
      retained: true,
    });
  }));

test("duplicate default plugin IDs are reported instead of silently overriding", async () =>
  fixture(async (root) => {
    await writePlugin(join(root, "plugins", "one"), "duplicate.tools");
    await writePlugin(join(root, "plugins", "two"), "duplicate.tools");
    const result = await loadAuraPlugins({
      ...options(join(root, "plugins.json")),
      defaultPluginsDirectory: join(root, "plugins"),
    });
    assert.equal(result.plugins[0]?.available, true);
    assert.equal(result.plugins[1]?.available, false);
    assert.match(result.plugins[1]?.error ?? "", /ID 重复/u);
  }));

test("missing configuration keeps built-in contributions available", async () =>
  fixture(async (root) => {
    const result = await loadAuraPlugins(options(join(root, "missing.json")));
    assert.deepEqual(result, {
      actionRoots: [],
      flowRoots: [],
      capabilityRoots: [],
      pageRoots: [],
      plugins: [],
    });
  }));

test("contributed capability providers are granted by ID and receive plugin settings", async () =>
  fixture(async (root) => {
    const plugin = await writePlugin(root, "example.providers");
    const manifestPath = join(plugin, "aura.plugin.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.contributes.capabilities = "./capabilities";
    await writeFile(manifestPath, JSON.stringify(manifest));
    await mkdir(join(plugin, "capabilities", "world-agent"), {
      recursive: true,
    });
    await writeFile(
      join(plugin, "capabilities", "world-agent", "world-agent.capability.js"),
      "export default {};\n",
    );
    const config = join(root, "plugins.json");
    await writeFile(
      config,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            path: plugin,
            enabled: true,
            trust: "local",
            settings: { session: "s" },
          },
        ],
      }),
    );
    const result = await loadAuraPlugins(options(config));
    assert.equal(result.plugins[0]?.available, true, result.plugins[0]?.error);
    assert.deepEqual(result.actionRoots[0]?.capabilities, [
      "example.providers/world-agent",
    ]);
    assert.equal(
      result.capabilityRoots[0]?.path,
      await realpath(join(plugin, "capabilities")),
    );
    assert.deepEqual(result.capabilityRoots[0]?.settings, { session: "s" });

    // The settings UI edits paths only; plugin-owned settings survive a save.
    const manager = await AuraPluginManager.create(options(config));
    manager.setActivator(async () => undefined);
    await manager.updateSettings({
      plugins: [{ path: plugin, enabled: true }],
    });
    assert.deepEqual(
      (await readAuraPluginConfiguration(config)).plugins[0]?.settings,
      { session: "s" },
    );

    await writeFile(join(plugin, "capabilities", "stray.js"), "");
    assert.match(
      (await loadAuraPlugins(options(config))).plugins[0]?.error ?? "",
      /贡献根目录只能包含直接贡献目录/u,
    );
  }));

test("loads an explicitly enabled relative plugin directory", async () =>
  fixture(async (root) => {
    const plugin = await writePlugin(root);
    const config = join(root, "settings", "plugins.json");
    await mkdir(dirname(config), { recursive: true });
    await writeFile(
      config,
      JSON.stringify({
        version: 1,
        plugins: [{ path: "../example.tools", enabled: true, trust: "local" }],
      }),
    );
    const result = await loadAuraPlugins(options(config));
    assert.equal(result.plugins[0]?.available, true);
    assert.equal(
      result.actionRoots[0]?.path,
      await realpath(resolve(plugin, "actions")),
    );
    assert.equal(result.flowRoots[0]?.namespace, "example.tools");
    assert.deepEqual(result.actionRoots[0]?.capabilities, []);
  }));

test("loads only plugins whose declared host capabilities are supported", async () =>
  fixture(async (root) => {
    const plugin = await writePlugin(root, "example.capability", [
      "aura.tripo.game-asset",
    ]);
    const config = join(root, "plugins.json");
    await writeFile(
      config,
      JSON.stringify({
        version: 1,
        plugins: [{ path: plugin, enabled: true, trust: "local" }],
      }),
    );

    const missing = await loadAuraPlugins(options(config));
    assert.equal(missing.plugins[0]?.available, false);
    assert.match(missing.plugins[0]?.error ?? "", /未提供的能力/u);

    const supported = await loadAuraPlugins({
      ...options(config),
      supportedCapabilities: ["aura.tripo.game-asset"],
    });
    assert.equal(supported.plugins[0]?.available, true);
    assert.deepEqual(supported.actionRoots[0]?.capabilities, [
      "aura.tripo.game-asset",
    ]);
  }));

test("isolates invalid and duplicate plugins as unavailable", async () =>
  fixture(async (root) => {
    const first = await writePlugin(root, "example.first");
    const second = await writePlugin(root, "example.second");
    const duplicateManifest = JSON.parse(
      await readFile(join(first, "aura.plugin.json"), "utf8"),
    );
    await writeFile(
      join(second, "aura.plugin.json"),
      JSON.stringify({ ...duplicateManifest, name: "Duplicate" }),
    );
    const config = join(root, "plugins.json");
    await writeFile(
      config,
      JSON.stringify({
        version: 1,
        plugins: [
          { path: first, enabled: true, trust: "local" },
          { path: second, enabled: true, trust: "local" },
          { path: join(root, "missing"), enabled: true, trust: "local" },
        ],
      }),
    );
    const result = await loadAuraPlugins(options(config));
    assert.equal(result.plugins.filter((plugin) => plugin.available).length, 1);
    assert.equal(
      result.plugins.filter((plugin) => !plugin.available).length,
      2,
    );
    assert.equal(result.flowRoots.length, 1);
  }));

test("plugin manager applies UI updates before persisting them", async () =>
  fixture(async (root) => {
    const plugin = await writePlugin(root);
    const config = join(root, ".aura", "plugins.json");
    const manager = await AuraPluginManager.create(options(config));
    const applied: string[][] = [];
    manager.setActivator(async (resolution) => {
      applied.push(
        resolution.plugins
          .filter(({ available }) => available)
          .map(({ id }) => id!),
      );
    });
    assert.deepEqual(manager.resolution.plugins, []);

    const settings = await manager.updateSettings({
      plugins: [{ path: plugin, enabled: true }],
    });
    assert.equal(settings.applyRequired, false);
    assert.equal(settings.plugins[0]?.status.available, true);
    assert.deepEqual(applied, [["example.tools"]]);
    assert.deepEqual(await readAuraPluginConfiguration(config), {
      version: 1,
      plugins: [{ path: plugin, enabled: true, trust: "local" }],
    });

    const disabled = await manager.updateSettings({
      plugins: [{ path: plugin, enabled: false }],
    });
    assert.equal(disabled.plugins[0]?.enabled, false);
    assert.deepEqual(applied, [["example.tools"], []]);
    assert.deepEqual(await readAuraPluginConfiguration(config), {
      version: 1,
      plugins: [{ path: plugin, enabled: false, trust: "local" }],
    });

    await assert.rejects(
      manager.updateSettings({ plugins: [{ path: "", enabled: true }] }),
      AuraPluginConfigurationError,
    );
  }));

test("plugin manager keeps disk and active state unchanged when live apply fails", async () =>
  fixture(async (root) => {
    const plugin = await writePlugin(root);
    const config = join(root, ".aura", "plugins.json");
    const manager = await AuraPluginManager.create(options(config));
    manager.setActivator(async () => {
      throw new Error("load failed");
    });

    await assert.rejects(
      manager.updateSettings({
        plugins: [{ path: plugin, enabled: true }],
      }),
      AuraPluginConfigurationError,
    );
    assert.deepEqual(await readAuraPluginConfiguration(config), {
      version: 1,
      plugins: [],
    });
    assert.deepEqual(manager.resolution.plugins, []);
  }));

test("page-only plugins contribute a built browser bundle", async () =>
  fixture(async (root) => {
    const plugin = join(root, "example.pages");
    await mkdir(join(plugin, "client"), { recursive: true });
    await writeFile(
      join(plugin, "aura.plugin.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "example.pages",
        name: "Pages",
        version: "0.1.0",
        engines: { aura: ">=0.1.0 <0.2.0", pluginSdk: "^1.0.0" },
        contributes: { pages: "./client/client.js" },
      }),
    );
    await writeFile(
      join(plugin, "package.json"),
      JSON.stringify({
        name: "example.pages",
        version: "0.1.0",
        type: "module",
      }),
    );
    await writeFile(
      join(plugin, "client", "client.js"),
      "window.__ModuleLoader__.load({id:'example.pages',factory(){return {}}});\n",
    );
    const config = join(root, "plugins.json");
    await writeFile(
      config,
      JSON.stringify({
        version: 1,
        plugins: [{ path: plugin, enabled: true, trust: "local" }],
      }),
    );
    const result = await loadAuraPlugins(options(config));
    assert.equal(result.plugins[0]?.available, true, result.plugins[0]?.error);
    assert.equal(result.pageRoots.length, 1);
    assert.equal(
      result.pageRoots[0]?.bundlePath,
      await realpath(join(plugin, "client", "client.js")),
    );
    assert.equal(result.actionRoots.length, 0);
    await writeFile(join(plugin, "client", "client.js"), "");
    assert.match(
      (await loadAuraPlugins(options(config))).plugins[0]?.error ?? "",
      /非空文件/u,
    );
  }));

test("explicit relocation grants preserve IDs and duplicate owners are rejected", async () =>
  fixture(async (dir) => {
    const one = await writePlugin(dir, "one.tools");
    const two = await writePlugin(dir, "two.tools");
    const compatibility = {
      flows: { report: { from: ["a".repeat(64)], to: "b".repeat(64) } },
      actions: { echo: { from: ["c".repeat(64)], to: "d".repeat(64) } },
      storageDomains: ["legacy_documents"],
      rpcPrefixes: ["documents/"],
    };
    for (const path of [one, two]) {
      const manifest = JSON.parse(
        await readFile(join(path, "aura.plugin.json"), "utf8"),
      );
      manifest.compatibility = compatibility;
      await writeFile(join(path, "aura.plugin.json"), JSON.stringify(manifest));
    }
    const config = join(dir, "plugins.json");
    await writeFile(
      config,
      JSON.stringify({
        version: 1,
        plugins: [one, two].map((path) => ({
          path,
          enabled: true,
          trust: "local",
        })),
      }),
    );
    const result = await loadAuraPlugins(options(config));
    assert.equal(result.plugins[0]?.available, true);
    assert.equal(result.plugins[1]?.available, false);
    assert.match(result.plugins[1]?.error ?? "", /already owned/u);
    assert.deepEqual(result.flowRoots[0]?.compatibility, compatibility);
    const manifest = JSON.parse(
      await readFile(join(one, "aura.plugin.json"), "utf8"),
    );
    manifest.compatibility.flows.missing = manifest.compatibility.flows.report;
    await writeFile(join(one, "aura.plugin.json"), JSON.stringify(manifest));
    assert.match(
      (await loadAuraPlugins(options(config))).plugins[0]?.error ?? "",
      /no matching entry/u,
    );
  }));
