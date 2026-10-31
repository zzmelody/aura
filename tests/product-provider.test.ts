import { memoryBackend } from "./plugin-backend-fixture.ts";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import test from "node:test";
import { loadAuraPlugins } from "@aura/extensions";
import { PluginBackends } from "../packages/backend/orchestration/src/plugin-backends.ts";
type JsonValue = Parameters<PluginBackends["invokeFromPage"]>[2];

test("default product providers honor page ownership and close independently", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "aura-product-plugins-"));
  const resolution = await loadAuraPlugins({
    configPath: join(directory, "plugins.json"),
    defaultPluginsDirectory: resolve("plugins"),
    auraVersion: "0.1.0",
    pluginSdkVersion: "2.0.0",
  });
  // Only site-launcher ships with Aura; other plugins load from explicit paths.
  assert.deepEqual(
    resolution.plugins.map((plugin) => plugin.id),
    ["site-launcher"],
  );
  const products = resolution.plugins;
  assert.ok(
    products.every((plugin) => plugin.available),
    JSON.stringify(products),
  );
  const providers = new PluginBackends({
    dataRoot: directory,
    host: memoryBackend(directory),
  });
  t.after(async () => {
    await providers.close();
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });
  await providers.replace(
    resolution.backendRoots.map((entry) => ({
      root: entry.path,
      pluginRoot: entry.pluginRoot,
      namespace: entry.namespace,
      plugin: entry.plugin,
      permissions: entry.permissions,
      compatibility: entry.compatibility,
      http: entry.http,
      presets: entry.presets,
    })),
  );
  const signal = new AbortController().signal;
  const pageInvoke = (
    pluginId: string,
    operation: string,
    input: JsonValue = {},
  ) => providers.invokeFromPage(pluginId, operation, input, signal);
  // A page may call only its own plugin's backend.
  await assert.rejects(
    pageInvoke("another-plugin", "status"),
    /page_backend_unavailable/u,
  );
  const project = join(directory, "project");
  await mkdir(project);
  await writeFile(
    join(project, "package.json"),
    JSON.stringify({ name: "fixture", scripts: { dev: "node server.js" } }),
  );
  const described = await pageInvoke("site-launcher", "describe", {
    directory: project,
  });
  assert.equal((described as { name: string }).name, "fixture");
  assert.deepEqual(await pageInvoke("site-launcher", "status"), []);
  await assert.rejects(
    pageInvoke("site-launcher", "open", {
      id: project,
    }),
  );
  const socket = createServer();
  await new Promise<void>((resolvePort, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolvePort);
  });
  const address = socket.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolvePort) => socket.close(() => resolvePort()));
  await writeFile(
    join(project, "server.js"),
    'import { serve } from "@hono/node-server";\n' +
      'import { Hono } from "hono";\n' +
      'serve({ fetch: new Hono().fetch, hostname: "127.0.0.1", port: Number(process.env.PORT) });\n',
  );
  assert.ok(
    described && typeof described === "object" && !Array.isArray(described),
  );
  const running = await pageInvoke("site-launcher", "start", {
    ...described,
    url: `http://127.0.0.1:${address.port}/`,
  });
  assert.ok(
    running &&
      typeof running === "object" &&
      !Array.isArray(running) &&
      typeof running.pid === "number",
    JSON.stringify(running),
  );
  const pid = running.pid;
  await providers.replace([]);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  await assert.rejects(pageInvoke("site-launcher", "status"));
  assert.equal(
    (await readFile(join(project, "package.json"), "utf8")).includes("fixture"),
    true,
  );
});
