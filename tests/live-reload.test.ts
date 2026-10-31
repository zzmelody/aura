import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createServer } from "vite";
import { liveReloadFallback } from "../scripts/vite-live-reload.ts";

const client = ts
  .transpileModule(
    await readFile(
      new URL("../scripts/vite-live-reload-client.ts", import.meta.url),
      "utf8",
    ),
    {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
    },
  )
  .outputText.replaceAll("import.meta.hot", "hot")
  .replace("export {};", "");
const flush = () => new Promise<void>((done) => setImmediate(done));

async function browser() {
  const events = new Map<string, () => void>();
  const timers = new Map<number, { run: () => unknown; delay: number }>();
  const state = {
    next: { session: "server-one", revision: 0 },
    reloads: 0,
    requests: 0,
    offline: false,
    disposed: () => {},
  };
  let timerId = 0;
  const document = {
    hidden: false,
    querySelector: () => ({
      content: JSON.stringify({ session: "server-one", revision: 0 }),
    }),
    addEventListener: (name: string, listener: () => void) =>
      events.set(name, listener),
    removeEventListener: (name: string) => events.delete(name),
  };
  runInNewContext(client, {
    document,
    window: document,
    location: { reload: () => state.reloads++ },
    hot: {
      on: (name: string, listener: () => void) => events.set(name, listener),
      dispose: (listener: () => void) => {
        state.disposed = listener;
      },
    },
    AbortController,
    setTimeout: (run: () => unknown, delay: number) => {
      timers.set(++timerId, { run, delay });
      return timerId;
    },
    clearTimeout: (id: number) => timers.delete(id),
    fetch: async () => {
      state.requests++;
      if (state.offline) throw new Error("Development server unavailable");
      return { ok: true, json: async () => ({ ...state.next }) };
    },
  });
  await flush();
  async function tick() {
    const pending = [...timers].filter(([, timer]) => timer.delay === 1000);
    for (const [id, timer] of pending) {
      timers.delete(id);
      await timer.run();
    }
    await flush();
  }
  return { state, document, events, timers, tick };
}

test("working HMR keeps component state instead of forcing a page reload", async () => {
  const page = await browser();
  page.events.get("vite:beforeUpdate")!();
  page.state.next.revision++;
  await page.tick();
  assert.equal(page.state.reloads, 0);
  page.events.get("vite:ws:disconnect")!();
  await page.tick();
  assert.equal(
    page.state.reloads,
    0,
    "already applied changes do not reload after disconnect",
  );
  page.state.next.revision++;
  await page.tick();
  assert.equal(page.state.reloads, 1);
});

test("a failed initial WebSocket connection reloads once on source changes", async () => {
  const page = await browser();
  await page.tick();
  assert.equal(page.state.reloads, 0);
  page.state.next.revision++;
  await page.tick();
  await page.tick();
  assert.equal(page.state.reloads, 1);
  assert.equal(page.timers.size, 0, "no reload loop after detecting an update");
});

test("a restarted server recovers even if a socket reconnects first", async () => {
  const page = await browser();
  page.events.get("vite:ws:connect")!();
  page.state.offline = true;
  await page.tick();
  assert.equal(page.state.reloads, 0);
  page.state.offline = false;
  page.state.next.session = "server-two";
  await page.tick();
  assert.equal(page.state.reloads, 1);
});

test("hidden tabs pause polling and check missed changes when visible", async () => {
  const page = await browser();
  page.document.hidden = true;
  await page.tick();
  const requests = page.state.requests;
  page.state.next.revision++;
  await page.tick();
  assert.equal(page.state.requests, requests);
  page.document.hidden = false;
  page.events.get("visibilitychange")!();
  await flush();
  assert.equal(page.state.reloads, 1);
});

test("client disposal removes polling and page listeners", async () => {
  const page = await browser();
  page.state.disposed();
  assert.equal(page.timers.size, 0);
  assert.equal(page.events.has("visibilitychange"), false);
  assert.equal(page.events.has("pagehide"), false);
});

test("Vite revision endpoint watches renderer sources and isolates unrelated files", async (t) => {
  const root = resolve("apps/web");
  const server = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [liveReloadFallback()],
    server: { host: "127.0.0.1", port: 0, watch: null },
  });
  t.after(() => server.close());
  await server.listen();
  const url = new URL("/@aura/dev-version", server.resolvedUrls!.local[0]);
  const response = await fetch(url);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const initial = await response.json();
  for (const path of [
    "packages/backend/runtime/src/index.ts",
    "packages/frontend/workbench/dist/index.js",
    "local/probe.ts",
    "apps/web/node_modules/dep/index.ts",
  ])
    server.watcher.emit("all", "change", resolve(path));
  assert.deepEqual(await (await fetch(url)).json(), initial);
  server.watcher.emit(
    "all",
    "change",
    resolve("packages/frontend/workbench/src/styles.css"),
  );
  server.watcher.emit(
    "all",
    "unlink",
    resolve("packages/shared/core/src/types.ts"),
  );
  const next = await (await fetch(url)).json();
  assert.equal(next.revision, initial.revision + 2);
  assert.equal(next.session, initial.session);
  const html = await server.transformIndexHtml(
    "/",
    "<html><head></head><body></body></html>",
  );
  assert.match(html, /aura-dev-version/);
  assert.match(html, /@aura\/dev-reload.ts/);
  const clientResponse = await fetch(new URL("/@aura/dev-reload.ts", url));
  assert.equal(clientResponse.status, 200);
  const clientCode = await clientResponse.text();
  assert.doesNotMatch(clientCode, /type Version|: Version|HTMLMetaElement/);
  assert.match(clientCode, /vite:ws:disconnect/);
  await server.restart();
  assert.notEqual((await (await fetch(url)).json()).session, initial.session);
});
