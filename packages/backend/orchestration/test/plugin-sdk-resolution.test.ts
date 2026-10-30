import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
const hook = pathToFileURL(
  join(import.meta.dirname, "../src/plugin-sdk-resolution.ts"),
).href;

/**
 * Runs in a fresh process: the hook is process-wide, and a plugin directory
 * outside any workspace has no `node_modules` that could provide the SDK.
 */
test("plugins without a local SDK resolve the host copy as one instance", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aura-sdk-resolution-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const host = join(root, "host/node_modules/@aura/plugin-sdk");
  await mkdir(host, { recursive: true });
  await writeFile(
    join(host, "package.json"),
    JSON.stringify({
      name: "@aura/plugin-sdk",
      version: "9.9.9",
      type: "module",
      exports: { "./capability": "./capability.js" },
    }),
  );
  await writeFile(
    join(host, "capability.js"),
    "export const marker = Symbol.for('host-sdk');\nexport const instance = {};\n",
  );
  const plugin = join(root, "plugin");
  await mkdir(plugin);
  await writeFile(join(plugin, "package.json"), '{"type":"module"}');
  await writeFile(
    join(plugin, "entry.js"),
    'export { instance } from "@aura/plugin-sdk/capability";\n',
  );
  const script = `
    import { installHostPluginSdkResolution } from ${JSON.stringify(hook)};
    const pluginEntry = ${JSON.stringify(pathToFileURL(join(plugin, "entry.js")).href)};
    await import(pluginEntry).then(
      () => { throw new Error("resolved without the hook"); },
      (error) => { if (error.code !== "ERR_MODULE_NOT_FOUND") throw error; },
    );
    installHostPluginSdkResolution(${JSON.stringify(join(host, "package.json"))});
    installHostPluginSdkResolution(${JSON.stringify(join(host, "package.json"))});
    const fromPlugin = await import(pluginEntry + "?again");
    const fromHost = await import(${JSON.stringify(pathToFileURL(join(host, "capability.js")).href)});
    if (fromPlugin.instance !== fromHost.instance) throw new Error("duplicate SDK instance");
    let refused = false;
    try { installHostPluginSdkResolution("elsewhere/package.json"); } catch { refused = true; }
    if (!refused) throw new Error("rebinding was allowed");
    console.log("ok");
  `;
  const { stdout } = await run(
    process.execPath,
    ["--import", "tsx/esm", "--input-type=module", "-e", script],
    { cwd: join(import.meta.dirname, "..") },
  );
  assert.equal(stdout.trim(), "ok");
});
