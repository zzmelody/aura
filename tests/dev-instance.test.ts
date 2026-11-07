import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createServer } from "vite";
import {
  ancestorChain,
  createDevToken,
  devInstanceFile,
  devShutdown,
  reclaimDevPort,
  removeDevInstance,
  SHUTDOWN_PATH,
  writeDevInstance,
} from "../scripts/dev-instance.ts";

async function withDirectory(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "aura-dev-instance-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("ancestor chain follows launcher wrappers only", () => {
  const table = new Map([
    [100, { parent: 90, created: 30, name: "node.exe" }],
    [90, { parent: 80, created: 20, name: "cmd.exe" }],
    [80, { parent: 70, created: 10, name: "pnpm.exe" }],
    [70, { parent: 60, created: 5, name: "powershell.exe" }],
    [60, { parent: 4, created: 1, name: "Code.exe" }],
  ]);
  assert.deepEqual(ancestorChain(100, table), [100, 90, 80]);
  assert.deepEqual(ancestorChain(999, table), []);
});

test("ancestor chain stops at a parent with a reused PID", () => {
  const table = new Map([
    [100, { parent: 90, created: 30, name: "node.exe" }],
    [90, { parent: 80, created: 20, name: "pnpm.exe" }],
    // Started after 90, so it cannot be 90's real parent.
    [80, { parent: 4, created: 50, name: "pnpm.exe" }],
  ]);
  assert.deepEqual(ancestorChain(100, table), [100, 90]);
});

test("a stale dev renderer is stopped only with its own token", async () => {
  await withDirectory(async (directory) => {
    const token = createDevToken();
    let stopped = 0;
    const server = await createServer({
      root: directory,
      configFile: false,
      logLevel: "silent",
      server: { host: "127.0.0.1", port: 0 },
      plugins: [
        devShutdown(token, () => {
          stopped += 1;
          void server.close();
        }),
      ],
    });
    await server.listen();
    const port = (server.httpServer?.address() as AddressInfo).port;
    const file = devInstanceFile("desktop", port, directory);

    const rejected = await fetch(`http://127.0.0.1:${port}${SHUTDOWN_PATH}`, {
      method: "POST",
      headers: { "x-aura-dev-token": createDevToken() },
    });
    assert.equal(rejected.status, 403);
    assert.equal(stopped, 0);

    await writeDevInstance(file, { pid: process.pid, token });
    assert.equal(await reclaimDevPort(port, file), true);
    assert.equal(stopped, 1);

    await removeDevInstance(file, createDevToken());
    assert.ok(await readFile(file, "utf8"));
    await removeDevInstance(file, token);
    await assert.rejects(readFile(file, "utf8"));
  });
});

test("a port held by an unrelated process is not reclaimed", async () => {
  await withDirectory(async (directory) => {
    const other = createHttpServer((_request, response) => {
      response.statusCode = 404;
      response.end();
    });
    await new Promise<void>((done) => other.listen(0, "127.0.0.1", done));
    try {
      const port = (other.address() as AddressInfo).port;
      const file = devInstanceFile("desktop", port, directory);
      assert.equal(await reclaimDevPort(port, file), false);
      await writeDevInstance(file, { pid: 1, token: createDevToken() });
      assert.equal(await reclaimDevPort(port, file), false);
      assert.equal(other.listening, true);
    } finally {
      await new Promise((done) => other.close(done));
    }
  });
});
