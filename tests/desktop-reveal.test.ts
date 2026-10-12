import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { revealTarget } from "../apps/desktop/src/reveal-target.ts";

test("only existing files inside the project can be revealed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aura-reveal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "a.ts"), "x");
  await writeFile(join(tmpdir(), "aura-reveal-outside.txt"), "x");
  t.after(() => rm(join(tmpdir(), "aura-reveal-outside.txt"), { force: true }));

  assert.deepEqual(await revealTarget(root, "src/a.ts"), {
    path: join(root, "src", "a.ts"),
  });
  assert.deepEqual(await revealTarget(root, join(root, "src", "a.ts")), {
    path: join(root, "src", "a.ts"),
  });
  // Escapes, the root itself, directories and missing files are refused.
  for (const path of [
    "../aura-reveal-outside.txt",
    join(tmpdir(), "aura-reveal-outside.txt"),
    ".",
    "src",
    "missing.ts",
    "",
  ])
    assert.ok("error" in (await revealTarget(root, path)), path);
  assert.ok("error" in (await revealTarget("relative/root", "a.ts")));
  assert.ok("error" in (await revealTarget(root, 42)));
});
