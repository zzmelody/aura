import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { revealTarget } from "../apps/desktop/src/reveal-target.ts";

test("existing files in any directory can be revealed with absolute or project-relative paths", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "aura-reveal-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "project");
  await mkdir(root);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "a.ts"), "x");
  await writeFile(join(directory, "outside.txt"), "x");

  assert.deepEqual(await revealTarget(root, "src/a.ts"), {
    path: join(root, "src", "a.ts"),
  });
  assert.deepEqual(await revealTarget(root, join(root, "src", "a.ts")), {
    path: join(root, "src", "a.ts"),
  });
  const outside = join(directory, "outside.txt");
  assert.deepEqual(await revealTarget(root, "../outside.txt"), {
    path: outside,
  });
  assert.deepEqual(await revealTarget(root, outside), { path: outside });
  assert.deepEqual(await revealTarget(undefined, outside), { path: outside });
  // Directories, missing files and invalid paths are still refused.
  for (const path of [".", "src", "missing.ts", ""])
    assert.ok("error" in (await revealTarget(root, path)), path);
  assert.ok("error" in (await revealTarget("relative/root", "a.ts")));
  assert.ok("error" in (await revealTarget(root, 42)));
});

test("file symlinks can be revealed while directory links and dangling links are refused", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "aura-reveal-links-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = join(directory, "project");
  await mkdir(project);
  const file = join(directory, "image.png");
  await writeFile(file, "image");
  const link = join(project, "image-link.png");
  await symlink(file, link);
  await symlink(directory, join(project, "folder-link"), "dir");
  await symlink(
    join(directory, "missing.png"),
    join(project, "dangling-link.png"),
  );
  assert.deepEqual(await revealTarget(project, "image-link.png"), {
    path: link,
  });
  for (const path of ["folder-link", "dangling-link.png"])
    assert.ok("error" in (await revealTarget(project, path)), path);
});
