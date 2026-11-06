import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { buildDesktopPreload } from "../scripts/build-desktop-preload.ts";

interface PreloadHost {
  platform: "desktop";
  os: string;
  directories: { choose(): Promise<string | null> };
  previews: { open(url: string, id: string, title: string): Promise<void> };
  files: { reveal(root: string, path: string): Promise<unknown> };
}

test("built desktop preload exposes native dialogs/previews without owning site processes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "aura-preload-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = await buildDesktopPreload(join(directory, "preload.cjs"));
  const requests: unknown[][] = [];
  let revealError: string | null = null;
  let disconnected = false;
  let host: PreloadHost | undefined;
  const ipcRenderer = {
    invoke: async (...args: unknown[]) => {
      requests.push(args);
      if (args[0] === "aura:directories:choose") return "/tmp/site";
      if (args[0] === "aura:files:reveal") {
        if (disconnected)
          throw new Error(
            "Error invoking remote method 'aura:files:reveal': internal details",
          );
        return revealError
          ? { type: "aura.native.failure", code: revealError }
          : undefined;
      }
    },
  };
  // Like a sandboxed preload: no import/Node loader, only Electron's limited require.
  runInNewContext(await readFile(output, "utf8"), {
    exports: {},
    process: { platform: process.platform },
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
            assert.ok(api !== null && typeof api === "object");
            host = api as PreloadHost;
          },
        },
        ipcRenderer,
      };
    },
  });
  assert.ok(host);
  assert.equal(host.platform, "desktop");
  assert.equal(host.os, process.platform);
  assert.equal(await host.directories.choose(), "/tmp/site");
  assert.equal("site" in host, false);
  await host.previews.open("http://127.0.0.1:5000/", "/tmp/site", "Site");
  // Coding deliverables are revealed through their own channel, with the
  // project root so the main process can resolve relative paths.
  await host.files.reveal("/tmp/project", "src/a.ts");
  assert.deepEqual(requests, [
    ["aura:directories:choose"],
    ["aura:previews:open", "http://127.0.0.1:5000/", "/tmp/site", "Site"],
    ["aura:files:reveal", "/tmp/project", "src/a.ts"],
  ]);
  revealError = "fileNotFound";
  assert.equal(
    JSON.stringify(await host.files.reveal("/tmp/project", "/outside.txt")),
    JSON.stringify({ type: "aura.native.failure", code: revealError }),
  );
  disconnected = true;
  assert.equal(
    JSON.stringify(await host.files.reveal("/tmp/project", "src/a.ts")),
    JSON.stringify({ type: "aura.native.failure", code: "fileRevealFailed" }),
  );
});
