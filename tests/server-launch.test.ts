import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { buildServerLauncher } from "../scripts/build-server-launch.ts";

const execute = promisify(execFile);

test("distributed launcher loads TypeScript inside node_modules and forwards child loader configuration", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "aura-launcher-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const application = join(directory, "node_modules/aura-server");
  await mkdir(application, { recursive: true });
  await writeFile(join(application, "package.json"), '{"type":"module"}');
  await symlink(
    resolve("node_modules"),
    join(application, "node_modules"),
    "junction",
  );
  await writeFile(
    join(application, "server.ts"),
    `
    const marker: string = "typed-server";
    console.log(JSON.stringify({marker, root:process.env.AURA_ROOT, host:process.env.HOST, port:process.env.PORT, loader:process.env.NODE_OPTIONS}));
  `,
  );
  const launcher = await buildServerLauncher(
    join(application, "dist/launch.js"),
  );
  const { PORT: _port, ...launcherEnvironment } = process.env;
  const { stdout } = await execute(
    process.execPath,
    [launcher, `--root=${directory}`],
    {
      env: { ...launcherEnvironment, NODE_OPTIONS: "" },
    },
  );
  const state = JSON.parse(stdout) as Record<string, unknown>;
  assert.equal(state.marker, "typed-server");
  assert.equal(state.root, directory);
  assert.equal(state.host, "127.0.0.1");
  assert.equal(state.port, "0");
  assert.match(String(state.loader), /--import=.*tsx.*esm/u);
  await assert.rejects(
    execute(process.execPath, [launcher]),
    (error: unknown) => {
      assert.ok(error instanceof Error && "code" in error && "stderr" in error);
      assert.equal(error.code, 2);
      assert.match(String(error.stderr), /requires --root/u);
      return true;
    },
  );
});
