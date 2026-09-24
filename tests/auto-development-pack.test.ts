import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packer = fileURLToPath(
  new URL("../scripts/ci/auto-develop.ts", import.meta.url),
);

test("the trusted packer exports a Git patch and request metadata", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aura-auto-dev-pack-"));
  const checkout = path.join(root, "checkout");
  const runnerTemp = path.join(root, "runner-temp");
  const output = path.join(runnerTemp, "auto-development");
  try {
    await mkdir(checkout);
    await mkdir(output, { recursive: true });
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: checkout, stdio: "pipe" });
    git("init", "-q");
    await writeFile(path.join(checkout, "feature.txt"), "before\n");
    git("add", "feature.txt");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "base",
    );
    await writeFile(path.join(checkout, "feature.txt"), "after\n");
    await writeFile(
      path.join(output, "request.json"),
      JSON.stringify({
        kind: "issue",
        title: "Change feature",
        source: "issue",
      }),
    );
    await writeFile(
      path.join(output, "codex-final.md"),
      "Implemented the feature.",
    );

    execFileSync(process.execPath, [packer, "pack"], {
      cwd: checkout,
      env: {
        ...process.env,
        GITHUB_WORKSPACE: checkout,
        RUNNER_TEMP: runnerTemp,
      },
      stdio: "pipe",
    });
    assert.match(
      await readFile(path.join(output, "change.patch"), "utf8"),
      /\+after/,
    );
    const metadata = JSON.parse(
      await readFile(path.join(output, "metadata.json"), "utf8"),
    );
    assert.equal(metadata.summary, "Implemented the feature.");
  } finally {
    const resolved = path.resolve(root);
    const tempRoot = path.resolve(tmpdir());
    assert.ok(
      resolved.startsWith(tempRoot + path.sep) &&
        path.basename(resolved).startsWith("aura-auto-dev-pack-"),
    );
    await rm(resolved, { recursive: true, force: true });
  }
});
