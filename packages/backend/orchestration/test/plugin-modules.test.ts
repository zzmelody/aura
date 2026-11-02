import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PluginModules } from "../src/plugin-modules.ts";

test("plugin helper revisions reload when the plugin directory contains a symbolic link", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aura-plugin-modules-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const actual = join(root, "actual");
  const alias = join(root, "alias");
  await mkdir(actual);
  await symlink(
    actual,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  await writeFile(join(actual, "package.json"), '{"type":"module"}');
  await writeFile(
    join(actual, "entry.js"),
    'export { version } from "./helper.js";',
  );
  await writeFile(join(actual, "helper.js"), 'export const version = "one";');
  const modules = new PluginModules();
  t.after(() => modules.close());
  const first = await modules.import(join(alias, "entry.js"), alias, "first");
  assert.ok(first && typeof first === "object" && "version" in first);
  assert.equal(first.version, "one");
  await writeFile(join(actual, "helper.js"), 'export const version = "two";');
  const second = await modules.import(join(alias, "entry.js"), alias, "second");
  assert.ok(second && typeof second === "object" && "version" in second);
  assert.equal(second.version, "two");
});
