import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AuraPluginManager } from "../src/index.ts";

test("plugin metadata is available before activation and disabled entries never load executable contributions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aura-plugin-localization-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const plugin = join(root, "plugin");
  await mkdir(plugin);
  const localization = {
    catalogs: {
      en: { name: "Example tools", flow: "Create report" },
      fr: { name: "Outils d’exemple" },
    },
    nameKey: "name",
    flows: { report: { titleKey: "flow" } },
  };
  const manifest = {
    schemaVersion: 2,
    id: "example.tools",
    name: "Original name",
    version: "1.0.0",
    engines: { aura: "^0.1.0", pluginSdk: "^2.5.0" },
    contributes: { backend: "./backend.js" },
    localization,
  };
  await writeFile(join(plugin, "aura.plugin.json"), JSON.stringify(manifest));
  await writeFile(
    join(plugin, "package.json"),
    JSON.stringify({ type: "module" }),
  );
  await writeFile(
    join(plugin, "backend.js"),
    "throw new Error('Discovery must not execute this module');\n",
  );
  const configPath = join(root, "plugins.json");
  const stored = JSON.stringify({
    version: 1,
    plugins: [
      {
        path: plugin,
        enabled: true,
        trust: "local",
        settings: { keep: "original" },
      },
    ],
  });
  await writeFile(configPath, stored);
  const options = {
    configPath,
    auraVersion: "0.1.0",
    pluginSdkVersion: "2.5.0",
  };
  const manager = await AuraPluginManager.create(options);
  assert.deepEqual(manager.resolution.plugins[0].localization, localization);
  assert.equal(manager.resolution.plugins[0].name, "Original name");
  assert.deepEqual(
    manager.resolution.backendRoots[0].plugin,
    { id: "example.tools", name: "Original name", version: "1.0.0" },
    "durable identity excludes all presentation resources",
  );
  assert.deepEqual(
    (await manager.settings()).plugins[0].status.localization,
    localization,
  );
  assert.equal(await readFile(configPath, "utf8"), stored);

  const disabled = JSON.stringify({
    version: 1,
    plugins: [
      {
        path: plugin,
        enabled: false,
        trust: "local",
        settings: { keep: "original" },
      },
    ],
  });
  await writeFile(configPath, disabled);
  await rm(join(plugin, "backend.js"));
  const inactive = await AuraPluginManager.create(options);
  assert.equal(inactive.resolution.backendRoots.length, 0);
  assert.equal(
    inactive.resolution.plugins[0].id,
    undefined,
    "disabled activation identities retain the existing contract",
  );
  const row = (await inactive.settings()).plugins[0];
  assert.equal(row.status.name, "Original name");
  assert.equal(row.status.enabled, false);
  assert.equal(row.status.available, false);
  assert.deepEqual(row.status.localization, localization);
  assert.deepEqual(row.settings, { keep: "original" });
  assert.equal(await readFile(configPath, "utf8"), disabled);
  await writeFile(
    join(plugin, "aura.plugin.json"),
    JSON.stringify({
      ...manifest,
      localization: { ...localization, execute: "forbidden" },
    }),
  );
  assert.equal(
    (await inactive.settings()).plugins[0].status.localization,
    undefined,
  );
  assert.equal(await readFile(configPath, "utf8"), disabled);
});
