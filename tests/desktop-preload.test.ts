import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { buildDesktopPreload } from "../scripts/build-desktop-preload.ts";

test("built desktop preload runs with sandbox CommonJS and exposes working Site IPC", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "aura-preload-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = await buildDesktopPreload(join(directory, "preload.cjs"));
  const events = new EventEmitter();
  const requests: unknown[][] = [];
  let host: any;
  const project = { directory: "/tmp/site" };
  const ipcRenderer = {
    on: events.on.bind(events),
    removeListener: events.removeListener.bind(events),
    invoke: async (...args: unknown[]) => {
      requests.push(args);
      if (args[0] === "aura:site:choose-directory") return project;
      if (args[0] === "aura:site:status")
        events.emit("aura:site:status", { sender: "private" }, { state: "idle" });
    },
  };
  // Like a sandboxed preload: no import/Node loader, only Electron's limited require.
  runInNewContext(await readFile(output, "utf8"), {
    exports: {},
    require: (name: string) => {
      assert.equal(
        name,
        "electron",
        "frontend or Node modules must not enter preload",
      );
      return {
        contextBridge: {
          exposeInMainWorld: (key: string, api: unknown) => {
            assert.equal(key, "auraHost");
            host = api;
          },
        },
        ipcRenderer,
      };
    },
  });
  assert.equal(host.platform, "desktop");
  assert.equal(await host.site.chooseDirectory(), project);
  const received: unknown[] = [];
  const unsubscribe = host.site.onStatus((...args: unknown[]) =>
    received.push(args),
  );
  assert.deepEqual(received, [[{ state: "idle" }]]);
  unsubscribe();
  events.emit("aura:site:status", {}, { state: "running" });
  assert.equal(received.length, 1);
  await host.site.start(project);
  await host.site.stop("/tmp/site");
  await host.site.open(project);
  assert.deepEqual(requests, [
    ["aura:site:choose-directory"],
    ["aura:site:status"],
    ["aura:site:start", project],
    ["aura:site:stop", "/tmp/site"],
    ["aura:site:open", project],
  ]);
});
