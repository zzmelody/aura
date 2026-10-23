import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  access,
  copyFile,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import {
  announcedSiteUrls,
  availableSitePort,
  belongsToSite,
  localSiteUrl,
  portAvailable,
  siteOwnsPort,
} from "../backend/site-network.ts";
import {
  describeProject,
  siteDirectCommand,
  sitePortFlags,
  siteScriptArgs,
} from "../backend/site-project.ts";
import { SiteRunner, type SiteStatus } from "../backend/site-runner.ts";

async function server(t: TestContext, hostname = "127.0.0.1", port = 0) {
  const app = new Hono().get("*", (c) => c.text("foreign service"));
  const http = serve({ fetch: app.fetch, hostname, port });
  if (!http.listening)
    await new Promise<void>((resolve, reject) => {
      http.once("listening", resolve);
      http.once("error", reject);
    });
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const info = http.address();
  assert.ok(info && typeof info !== "string");
  return { port: info.port, url: `http://127.0.0.1:${info.port}/` };
}

async function fixture(t: TestContext, script: string) {
  // Place fixtures under this package so Node resolves the package's pnpm
  // links from their original location. A junction to node_modules from an
  // OS temp directory breaks pnpm's relative package links on Windows.
  const directory = await mkdtemp(
    join(import.meta.dirname, "../.aura-site-test-"),
  );
  const workspace = JSON.parse(
    await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
  ) as { packageManager: string };
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      type: "module",
      packageManager: workspace.packageManager,
      scripts: { dev: script },
    }),
  );
  await copyFile(
    new URL("./fixtures/site-server.ts", import.meta.url),
    join(directory, "server.ts"),
  );
  return describeProject(directory);
}

async function until(check: () => boolean | Promise<boolean>, timeout = 40000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(50);
  }
  assert.fail("Timed out waiting for site state");
}

function runner(t: TestContext, readinessTimeoutMs = 30000) {
  const opened: string[] = [];
  const statuses: SiteStatus[] = [];
  const runner = new SiteRunner({
    onStatus: (status) => statuses.push(status),
    openPreview: async (url) => {
      opened.push(url);
    },
    readinessTimeoutMs,
  });
  t.after(() => runner.stop());
  return { runner, opened, statuses };
}

test("only direct supported scripts get port flags, and npm uses a separator", () => {
  assert.deepEqual(sitePortFlags("vite --port 3000", 5174), [
    "--host",
    "127.0.0.1",
    "--port",
    "5174",
    "--strictPort",
  ]);
  assert.deepEqual(sitePortFlags("next dev", 3001)?.slice(-2), [
    "--port",
    "3001",
  ]);
  assert.deepEqual(sitePortFlags("vite --host 0.0.0.0 --port 5173", 5173), [
    "--host",
    "127.0.0.1",
    "--port",
    "5173",
    "--strictPort",
  ]);
  assert.deepEqual(
    siteDirectCommand("vite --host 0.0.0.0 --port 5173", [
      "--host",
      "127.0.0.1",
      "--port",
      "5174",
      "--strictPort",
    ]),
    {
      command: "vite",
      args: ["--host", "127.0.0.1", "--port", "5174", "--strictPort"],
    },
  );
  for (const command of [
    "node server.ts",
    "vite && echo ok",
    "pnpm dev",
    "PORT=3000 vite",
    "vite --port $PORT",
    "vite --open 'http://x'",
    "vite -- --port 3000",
    "vite build",
  ])
    assert.equal(sitePortFlags(command, 3001), null);
  const project = { packageManager: "npm", script: "dev" } as Parameters<
    typeof siteScriptArgs
  >[0];
  assert.deepEqual(siteScriptArgs(project, ["--port", "3001"]), [
    "run",
    "dev",
    "--",
    "--port",
    "3001",
  ]);
  assert.deepEqual(
    siteScriptArgs({ ...project, packageManager: "pnpm" }, ["--port", "3001"]),
    ["run", "dev", "--port", "3001"],
  );
});

test("local addresses, ANSI announcements and process tree ownership are constrained", () => {
  assert.equal(
    localSiteUrl("http://0.0.0.0:5000/base?q=1").hostname,
    "127.0.0.1",
  );
  assert.equal(localSiteUrl("http://[::]:5000").hostname, "[::1]");
  for (const url of [
    "https://example.com",
    "file:///tmp/a",
    "http://user:pass@localhost:3000",
  ])
    assert.throws(() => localSiteUrl(url));
  assert.deepEqual(
    announcedSiteUrls(
      "docs: https://vite.dev\nnode --url http://localhost:8888\n\u001b[32mLocal: http://localhost:5001/\u001b[0m\n",
    ),
    ["http://localhost:5001/"],
  );
  const rows = [
    { pid: 10, parent: 1, group: 10 },
    { pid: 11, parent: 10 },
    { pid: 12, parent: 11 },
    { pid: 13, parent: 1, group: 10 },
    { pid: 20, parent: 1 },
  ];
  assert.equal(belongsToSite([12, 13], rows, 10), true);
  assert.equal(belongsToSite([12, 20], rows, 10), false);
  assert.equal(belongsToSite([], rows, 10), false);
  assert.equal(
    belongsToSite(
      [12],
      rows.filter((row) => row.pid !== 10),
      10,
    ),
    false,
  );
});

test("custom command with an occupied port is refused before spawn; foreign service stays alive", async (t) => {
  const occupied = await server(t);
  const project = await fixture(t, `node server.ts ${occupied.port}`);
  const { runner: site, opened } = runner(t);
  const result = await site.start({ ...project, url: occupied.url });
  assert.equal(result.state, "error");
  assert.match(result.message!, /已被占用/);
  assert.equal(result.pid, undefined);
  assert.equal(result.project?.directory, project.directory);
  await assert.rejects(access(join(project.directory, "started.txt")));
  await assert.rejects(site.open(occupied.url));
  assert.deepEqual(opened, []);
  assert.equal(await (await fetch(occupied.url)).text(), "foreign service");
  assert.equal(await portAvailable(occupied.port), false);
});

test("a wildcard listener is treated as occupied before a loopback project starts", async (t) => {
  const occupied = await server(t, "0.0.0.0");
  assert.equal(await portAvailable(occupied.port), false);
  const project = await fixture(t, `node server.ts ${occupied.port}`);
  const { runner: site, opened } = runner(t);
  const result = await site.start({ ...project, url: occupied.url });
  assert.equal(result.state, "error");
  assert.match(result.message!, /已被占用/);
  assert.deepEqual(opened, []);
  assert.equal(await (await fetch(occupied.url)).text(), "foreign service");
});

test("custom server announcing an alternate port synchronizes URL and is owned by the child tree", async (t) => {
  const project = await fixture(t, "node server.ts 0");
  const { runner: site, opened } = runner(t);
  const preferred = await availableSitePort(44000);
  await site.start({ ...project, url: `http://127.0.0.1:${preferred}/` });
  await until(() => opened.length === 1 || site.getStatus().state === "error");
  const status = site.getStatus();
  assert.equal(status.state, "running", JSON.stringify(status));
  assert.equal(status.previewReady, true);
  assert.equal(
    status.project!.url,
    await readFile(join(project.directory, "listening.txt"), "utf8"),
  );
  assert.equal(
    await siteOwnsPort(status.pid!, Number(new URL(status.project!.url).port)),
    true,
  );
  assert.match(status.portMessage!, /实际地址/);
  await site.open(status.project!.url);
  await site.stop();
  assert.equal(
    await portAvailable(Number(new URL(status.project!.url).port)),
    true,
  );
  await assert.rejects(site.open(status.project!.url));
  assert.equal(opened.length, 2);
});

test("a foreign listener announced by the child is never adopted; timeout retains a stop handle", async (t) => {
  const foreign = await server(t);
  const project = await fixture(t, "node server.ts 0 idle");
  await writeFile(
    join(project.directory, "server.ts"),
    `console.log('Local: ${foreign.url}'); setInterval(() => {}, 1000);`,
  );
  const { runner: site, opened } = runner(t, 1400);
  const preferred = await availableSitePort(44000);
  await site.start({ ...project, url: `http://127.0.0.1:${preferred}/` });
  await until(() => site.getStatus().state === "error");
  assert.ok(site.getStatus().pid);
  assert.equal(site.getStatus().previewReady, false);
  assert.deepEqual(opened, []);
  await site.stop();
  assert.equal(site.getStatus().pid, undefined);
  assert.equal(await (await fetch(foreign.url)).text(), "foreign service");
});

test("a child that exits during startup reports an error promptly", async (t) => {
  const project = await fixture(t, "node server.ts 0");
  await writeFile(join(project.directory, "server.ts"), "process.exit(7);");
  const { runner: site, opened } = runner(t);
  const preferred = await availableSitePort(44000);
  await site.start({ ...project, url: `http://127.0.0.1:${preferred}/` });
  await until(() => site.getStatus().state === "error", 15000);
  const status = site.getStatus();
  assert.match(status.message!, /代码 7/);
  assert.equal(status.pid, undefined);
  assert.equal(status.previewReady, false);
  assert.deepEqual(opened, []);
});

test("stop during startup cancels preview; concurrent starts leave only the newest child", async (t) => {
  const project = await fixture(t, "node server.ts 0 normal 1500");
  const { runner: site, opened } = runner(t);
  const preferred = await availableSitePort(44000);
  const requested = { ...project, url: `http://127.0.0.1:${preferred}/` };
  await site.start(requested);
  await site.stop();
  await delay(1700);
  assert.deepEqual(opened, []);
  await assert.rejects(access(join(project.directory, "started.txt")));
  await Promise.all([site.start(requested), site.start(requested)]);
  await until(() => opened.length === 1 || site.getStatus().state === "error");
  assert.equal(
    site.getStatus().state,
    "running",
    JSON.stringify(site.getStatus()),
  );
  const actual = site.getStatus().project!.url;
  await site.stop();
  assert.equal(await portAvailable(Number(new URL(actual).port)), true);
});

test("port taken after preflight is not mistaken for the newly spawned project", async (t) => {
  const port = await availableSitePort(44000);
  const project = await fixture(t, "node server.ts 0 idle");
  const opened: string[] = [];
  let foreign: ReturnType<typeof serve> | undefined;
  const app = new Hono().get("*", (c) => c.text("late foreign service"));
  const site = new SiteRunner({
    onStatus(status) {
      if (status.state === "starting" && status.pid && !foreign)
        foreign = serve({ fetch: app.fetch, hostname: "127.0.0.1", port });
    },
    openPreview: async (url) => {
      opened.push(url);
    },
    readinessTimeoutMs: 1300,
  });
  t.after(async () => {
    await site.stop();
    if (foreign)
      await new Promise<void>((resolve) => foreign!.close(() => resolve()));
  });
  const url = `http://127.0.0.1:${port}/`;
  assert.equal((await site.start({ ...project, url })).state, "starting");
  await until(() => site.getStatus().state === "error");
  assert.deepEqual(opened, []);
  await assert.rejects(site.open(url));
  await site.stop();
  assert.equal(await (await fetch(url)).text(), "late foreign service");
});

test("direct dev server scripts get a selected free port and keep existing services alone", async (t) => {
  // Avoid Windows' dynamic client-port range while testing port selection.
  const occupied = await server(t, "127.0.0.1", await availableSitePort(44000));
  const project = await fixture(
    t,
    `vite --host 0.0.0.0 --port ${occupied.port}`,
  );
  await writeFile(
    join(project.directory, "index.html"),
    "<!doctype html><title>Aura direct Vite</title><p>owned direct site</p>",
  );
  const { runner: site, opened } = runner(t);
  const starting = await site.start({ ...project, url: occupied.url });
  assert.equal(starting.state, "starting", JSON.stringify(starting));
  assert.match(starting.portMessage!, /自动选择可用端口/);
  await until(() => opened.length === 1 || site.getStatus().state === "error");
  const status = site.getStatus();
  assert.equal(status.state, "running", JSON.stringify(status));
  assert.equal(status.previewReady, true);
  assert.notEqual(Number(new URL(status.project!.url).port), occupied.port);
  assert.match(
    await (await fetch(status.project!.url)).text(),
    /owned direct site/,
  );
  assert.equal(await (await fetch(occupied.url)).text(), "foreign service");
  await site.stop();
});

test("multiple projects run concurrently with separate status and ports", async (t) => {
  const first = await fixture(t, "node server.ts 0");
  const second = await fixture(t, "node server.ts 0");
  const opened: string[] = [];
  const site = new SiteRunner({
    onStatus() {},
    openPreview: async (url) => {
      opened.push(url);
    },
    readinessTimeoutMs: 30000,
  });
  t.after(() => site.stop());
  const preferred = await availableSitePort(44000);
  const url = `http://127.0.0.1:${preferred}/`;
  await Promise.all([
    site.start({ ...first, url }),
    site.start({ ...second, url }),
  ]);
  await until(
    () =>
      opened.length === 2 ||
      site.getStatus(first.id).state === "error" ||
      site.getStatus(second.id).state === "error",
  );
  const firstStatus = site.getStatus(first.id);
  const secondStatus = site.getStatus(second.id);
  // Either project can end the wait; retain both outcomes rather than losing
  // the triggering failure behind the other project's still-starting state.
  const concurrentStatus = JSON.stringify({
    first: firstStatus,
    second: secondStatus,
    opened,
  });
  assert.equal(firstStatus.state, "running", concurrentStatus);
  assert.equal(secondStatus.state, "running", concurrentStatus);
  assert.notEqual(firstStatus.project!.url, secondStatus.project!.url);
  await site.stop(first.id);
  assert.equal(site.getStatus(first.id).state, "stopped");
  assert.equal(site.getStatus(second.id).state, "running");
  assert.match(
    await (await fetch(secondStatus.project!.url)).text(),
    /owned site/,
  );
  await site.stop(second.id);
});
