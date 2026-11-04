import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadAuraPlugins } from "@aura/extensions";
import { buildPlugins } from "../scripts/build-plugins.ts";

test(
  "release builds execute extensionless pnpm launchers and Node entrypoints",
  {
    skip:
      process.platform === "win32" ? "Fixture uses a POSIX executable" : false,
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "aura-pnpm-release-"));
    const previous = process.env.npm_execpath;
    t.after(async () => {
      if (previous === undefined) delete process.env.npm_execpath;
      else process.env.npm_execpath = previous;
      await rm(root, { recursive: true, force: true });
    });
    const source = join(root, "source with spaces");
    await mkdir(source);
    await writeFile(join(source, "aura.plugin.json"), "{}");
    await writeFile(
      join(source, "package.json"),
      JSON.stringify({ files: ["built.txt"], scripts: { build: "fixture" } }),
    );
    for (const [name, content] of [
      [
        "pnpm",
        '#!/bin/sh\n[ "$1" = "--dir" ] && [ "$3" = "run" ] && [ "$4" = "build" ] || exit 1\nprintf built > "$2/built.txt"\n',
      ],
      [
        "pnpm.cjs",
        'require("node:fs").writeFileSync(require("node:path").join(process.argv[3], "built.txt"), "built");\n',
      ],
    ]) {
      const launcher = join(root, name);
      await writeFile(launcher, content);
      await chmod(launcher, 0o755);
      process.env.npm_execpath = launcher;
      await buildPlugins(source, join(root, "output"));
      assert.equal(
        await readFile(join(root, "output", "built.txt"), "utf8"),
        "built",
      );
      await rm(join(source, "built.txt"));
    }
  },
);

test("release plugins preserve nested layout and load without source plugin directories", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aura-plugin-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const plugin = join(source, "personal", "chat");
  await mkdir(join(plugin, "backend", "dist"), { recursive: true });
  await writeFile(
    join(plugin, "package.json"),
    JSON.stringify({ type: "module", files: ["backend/dist/index.js"] }),
  );
  await writeFile(
    join(plugin, "aura.plugin.json"),
    JSON.stringify({
      schemaVersion: 2,
      id: "test.release",
      name: "Release",
      version: "0.1.0",
      engines: { aura: "^0.1.0", pluginSdk: "^2.0.0" },
      contributes: { backend: "./backend/dist/index.js" },
    }),
  );
  await writeFile(
    join(plugin, "backend", "dist", "index.js"),
    'import { defineBackend } from "@aura/plugin-sdk/backend";\nexport default defineBackend({ open() { return {}; } });\n',
  );
  await mkdir(join(plugin, "backend", "dist", "cache"));
  await writeFile(
    join(plugin, "backend", "dist", "cache", "private.json"),
    "private",
  );
  await writeFile(join(plugin, "backend", "dist", "private.key"), "private");
  await writeFile(join(plugin, "unlisted.txt"), "private");
  const output = join(root, "installed", "plugins");
  await buildPlugins(source, output, false);
  await rm(source, { recursive: true, force: true });
  const installed = join(output, "personal", "chat");
  for (const file of [
    "unlisted.txt",
    "backend/dist/cache/private.json",
    "backend/dist/private.key",
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
    pluginSdkVersion: "2.0.0",
  });
  assert.equal(
    resolution.plugins[0]?.available,
    true,
    resolution.plugins[0]?.error,
  );
  assert.equal(resolution.backendRoots[0]?.plugin.id, "test.release");
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
