import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import {
  SiteRunner,
  describeProject,
} from "../plugins/site-launcher/backend/site-runner.ts";

test(
  "real Vite overrides an occupied explicit port and stops without touching the foreign service",
  // Windows process ownership checks use PowerShell and can outlast Vite startup.
  { timeout: process.platform === "win32" ? 120000 : 25000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "aura-vite-test-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const app = new Hono().get("*", (c) => c.text("foreign service"));
    const http = serve({ fetch: app.fetch, hostname: "0.0.0.0", port: 0 });
    await new Promise<void>((resolve, reject) => {
      http.once("listening", resolve);
      http.once("error", reject);
    });
    t.after(() => new Promise<void>((resolve) => http.close(() => resolve())));
    const address = http.address();
    assert.ok(address && typeof address !== "string");
    const foreignUrl = `http://127.0.0.1:${address.port}`;
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({
        type: "module",
        packageManager: "pnpm@10.17.1",
        scripts: { dev: `vite --port ${address.port}` },
      }),
    );
    await writeFile(
      join(directory, "index.html"),
      "<!doctype html><title>Aura port regression</title><p>owned Vite site</p>",
    );
    await symlink(
      resolve(import.meta.dirname, "../node_modules"),
      join(directory, "node_modules"),
      "junction",
    );
    const opened: string[] = [];
    const runner = new SiteRunner({
      onStatus() {},
      openPreview: async (url) => {
        opened.push(url);
      },
      readinessTimeoutMs: 15000,
    });
    t.after(() => runner.stop());
    const project = await describeProject(directory);
    assert.equal(Number(new URL(project.url).port), address.port);
    const starting = await runner.start(project);
    assert.equal(starting.state, "starting", JSON.stringify(starting));
    assert.match(starting.portMessage!, /自动选择可用端口/);
    const deadline = Date.now() + 18000;
    while (
      Date.now() < deadline &&
      !opened.length &&
      runner.getStatus().state !== "error"
    )
      await delay(100);
    assert.equal(
      runner.getStatus().state,
      "running",
      JSON.stringify(runner.getStatus()),
    );
    assert.equal(opened.length, 1);
    assert.notEqual(Number(new URL(opened[0]).port), address.port);
    assert.match(await (await fetch(opened[0])).text(), /owned Vite site/);
    await runner.stop();
    assert.equal(await (await fetch(foreignUrl)).text(), "foreign service");
  },
);
