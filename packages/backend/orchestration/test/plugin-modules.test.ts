import assert from "node:assert/strict";
import fs, { type FSWatcher } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { PluginModules } from "../src/plugin-modules.ts";

test("late notifications for unchanged loaded sources do not reopen their module generation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aura-plugin-source-events-"));
  const nativeWatch = fs.watch;
  let watcher: FSWatcher | undefined;
  const wrapped = t.mock.method(
    fs,
    "watch",
    (...args: Parameters<typeof fs.watch>) => {
      watcher = nativeWatch(...args);
      return watcher;
    },
  );
  syncBuiltinESMExports();
  const modules = new PluginModules();
  t.after(async () => {
    modules.close();
    wrapped.mock.restore();
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  });
  const entry = join(root, "entry.js");
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await writeFile(entry, 'export const version = "one";');
  const initial = await modules.revision(root);
  assert.ok(watcher);
  watcher.emit("change", "change", "entry.js");
  assert.equal(
    await modules.revision(root),
    initial,
    "notifications before the first load belong to its initial version",
  );
  await modules.import(entry, root);
  const before = await modules.revision(root);
  assert.ok(watcher);
  // Deliver a stale native notification after the module has finished loading.
  watcher.emit("change", "change", "entry.js");
  assert.equal(await modules.revision(root), before);
  await writeFile(entry, 'export const version = "two";');
  watcher.emit("change", "change", "entry.js");
  const changed = await modules.revision(root);
  assert.ok(changed > before);
  watcher.emit("change", "change", "entry.js");
  assert.equal(
    await modules.revision(root),
    changed,
    "duplicate notifications do not create another revision",
  );
  await rm(entry);
  watcher.emit("change", "rename", "entry.js");
  assert.ok(
    (await modules.revision(root)) > changed,
    "removed source still invalidates its backend",
  );
});

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

test(
  "native source notifications reload helpers after an atomic file replacement",
  { timeout: 10_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "aura-plugin-module-watch-"));
    const modules = new PluginModules();
    t.after(async () => {
      modules.close();
      await rm(root, { recursive: true, force: true });
    });
    const nested = join(root, "nested");
    await mkdir(nested);
    const entry = join(root, "entry.js");
    const helper = join(nested, "helper.js");
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    await writeFile(entry, 'export { version } from "./nested/helper.js";');
    await writeFile(helper, 'export const version = "one";');
    const firstRevision = await modules.revision(root);
    const first = await modules.import(entry, root, String(firstRevision));
    assert.ok(first && typeof first === "object" && "version" in first);
    assert.equal(first.version, "one");
    const replacement = join(nested, ".helper-next.js");
    await writeFile(replacement, 'export const version = "two";');
    await rename(replacement, helper);
    const deadline = Date.now() + 5_000;
    let revision = await modules.revision(root);
    while (revision === firstRevision && Date.now() < deadline) {
      await delay(10);
      revision = await modules.revision(root);
    }
    assert.ok(
      revision > firstRevision,
      "the native watcher must observe the replacement",
    );
    const second = await modules.import(entry, root, String(revision));
    assert.ok(second && typeof second === "object" && "version" in second);
    assert.equal(second.version, "two");
  },
);
