import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Hono } from "hono";
import { startRendererServer } from "../apps/desktop/src/renderer-server.ts";

const app = new Hono().get("/", (context) => context.text("Fixture renderer"));
const close = (
  server: Awaited<ReturnType<typeof startRendererServer>>["server"],
) =>
  new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );

test("restarting the desktop renderer keeps its local-storage origin", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "aura-renderer-origin-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const portFile = join(temporary, "renderer-port");
  const first = await startRendererServer(app.fetch, portFile);
  t.after(async () => {
    if (first.server.listening) await close(first.server);
  });
  assert.equal(await (await fetch(first.url)).text(), "Fixture renderer");
  await close(first.server);
  const second = await startRendererServer(app.fetch, portFile);
  t.after(() => close(second.server));
  assert.equal(second.url, first.url);
});

test("an occupied cached renderer port falls back without disturbing its existing listener", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "aura-renderer-busy-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const portFile = join(temporary, "renderer-port");
  const first = await startRendererServer(app.fetch, portFile);
  t.after(() => close(first.server));
  const second = await startRendererServer(app.fetch, portFile);
  t.after(() => close(second.server));
  assert.notEqual(second.url, first.url);
  assert.equal(await (await fetch(first.url)).text(), "Fixture renderer");
});

test("an invalid or unwritable renderer port cache does not prevent serving the application", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "aura-renderer-cache-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const portFile = join(temporary, "renderer-port");
  await writeFile(portFile, "not-a-port");
  const first = await startRendererServer(app.fetch, portFile);
  t.after(() => close(first.server));
  const second = await startRendererServer(app.fetch, join(portFile, "child"));
  t.after(() => close(second.server));
  assert.equal(await (await fetch(first.url)).text(), "Fixture renderer");
  assert.equal(await (await fetch(second.url)).text(), "Fixture renderer");
});
