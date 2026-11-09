import assert from "node:assert/strict";
import fs, { type FSWatcher } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { PluginModules } from "../src/plugin-modules.ts";

test("access metadata and identical bytes do not invalidate imported modules or raw resources", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aura-plugin-content-events-"));
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
  const files = new Map([
    ["package.json", '{"type":"module"}'],
    ["entry.js", 'export const version = "one";'],
    ["evidence.json", '{"value":1}'],
    ["startup.yaml", "value: one"],
    ["plugin.json", '{"version":"1"}'],
  ]);
  for (const [name, contents] of files)
    await writeFile(join(root, name), contents);
  await modules.revision(root);
  await modules.import(join(root, "entry.js"), root);
  const before = await modules.revision(root);
  assert.ok(watcher);
  for (const [name, contents] of files) {
    const path = join(root, name);
    const previous = await stat(path);
    await utimes(path, new Date(previous.atimeMs + 60_000), previous.mtime);
    watcher.emit("change", "change", name);
    assert.equal(
      await modules.revision(root),
      before,
      `${name}: access time only`,
    );
    await writeFile(path, contents);
    watcher.emit("change", "change", name);
    assert.equal(
      await modules.revision(root),
      before,
      `${name}: identical rewrite`,
    );
  }
  for (const name of [
    "entry.js",
    "evidence.json",
    "startup.yaml",
    "plugin.json",
    "package.json",
  ]) {
    const path = join(root, name);
    const previous = await stat(path);
    const value = files.get(name)!;
    const next = value.replace(/one|1|module/u, (match) =>
      match === "one" ? "two" : match === "1" ? "2" : "common",
    );
    assert.equal(next.length, value.length);
    const revision = await modules.revision(root);
    await writeFile(path, next);
    await utimes(path, previous.atime, previous.mtime);
    watcher.emit("change", "change", name);
    const changed = await modules.revision(root);
    assert.ok(
      changed > revision,
      `${name}: same-size edit with restored mtime`,
    );
    watcher.emit("change", "change", name);
    assert.equal(await modules.revision(root), changed, `${name}: duplicate`);
  }
});

test("resource creation, deletion and restoration invalidate once while ignored paths stay ignored", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aura-plugin-resource-events-"));
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
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await writeFile(join(root, "entry.js"), "export const value = 1;");
  await modules.revision(root);
  await modules.import(join(root, "entry.js"), root);
  assert.ok(watcher);
  let previous = await modules.revision(root);
  for (const change of [
    () => writeFile(join(root, "new.json"), "{}"),
    () => rm(join(root, "new.json")),
    () => writeFile(join(root, "new.json"), "{}"),
  ]) {
    await change();
    watcher.emit("change", "rename", "new.json");
    const changed = await modules.revision(root);
    assert.ok(changed > previous);
    watcher.emit("change", "rename", "new.json");
    assert.equal(await modules.revision(root), changed);
    previous = changed;
  }
  for (const name of [
    "node_modules/helper.js",
    ".cache/state.json",
    "notes.md",
    "already-removed.json",
  ]) {
    watcher.emit("change", "change", name);
    assert.equal(await modules.revision(root), previous);
  }
});

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
