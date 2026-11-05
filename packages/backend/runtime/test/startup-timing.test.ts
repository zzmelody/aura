import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import { OrchestrationHost } from "../src/dsh/host.ts";
import { HostDiagnosticReader } from "../src/dsh/host-diagnostics.ts";
import {
  STARTUP_TIMING_PREFIX,
  StartupTimer,
  type StartupTiming,
} from "../src/dsh/startup-timing.ts";

test("startup timings preserve results and failures without logging error contents", async () => {
  const rows: StartupTiming[] = [];
  const startupId = randomUUID();
  const timer = new StartupTimer(startupId, (row) => rows.push(row));
  assert.equal(await timer.measure("profile", async () => 42), 42);
  const error = new Error("secret-provider-token");
  await assert.rejects(
    timer.measure("discovery", async () => {
      throw error;
    }),
    (reason) => reason === error,
  );
  assert.deepEqual(
    rows.map(({ stage, status }) => [stage, status]),
    [
      ["profile", "started"],
      ["profile", "completed"],
      ["discovery", "started"],
      ["discovery", "failed"],
    ],
  );
  assert.ok(
    rows.every(
      (row) =>
        row.startupId === startupId &&
        row.durationMs >= 0 &&
        row.elapsedMs >= 0,
    ),
  );
  assert.doesNotMatch(JSON.stringify(rows), /secret-provider-token/);
});

test("child timing records discard extra fields and reject unknown stages and invalid durations", () => {
  const rows: StartupTiming[] = [];
  const reader = new HostDiagnosticReader(
    () => {},
    () => {},
    (row) => rows.push(row),
  );
  const timing = {
    startupId: randomUUID(),
    stage: "discovery",
    status: "completed",
    elapsedMs: 15,
    durationMs: 5,
  };
  const line =
    STARTUP_TIMING_PREFIX +
    JSON.stringify({ ...timing, token: "secret-token" }) +
    "\n";
  reader.push(line.slice(0, 18));
  reader.push(line.slice(18));
  for (const invalid of [
    { ...timing, stage: "secret-token" },
    { ...timing, startupId: "secret-token" },
    { ...timing, durationMs: -1 },
    { ...timing, elapsedMs: null },
    { ...timing, status: "secret-token" },
  ])
    reader.push(STARTUP_TIMING_PREFIX + JSON.stringify(invalid) + "\n");
  assert.deepEqual(rows, [timing]);
  assert.doesNotMatch(JSON.stringify(rows), /secret-token/);
});

test(
  "DSH watches plugin sources but skips dependency and hidden trees on Windows and POSIX",
  { timeout: 30000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "aura-startup-watch-"));
    const pluginRoot = join(root, "plugin");
    const flowRoot = join(pluginRoot, "flows");
    const directory = join(flowRoot, "watch-probe");
    const snapshot = join(root, "watched.json");
    const host = new OrchestrationHost({
      root,
      dshHome: join(root, ".aura/dsh"),
      modelURL: "http://127.0.0.1:1/v1",
      flowRoots: [{ root: flowRoot, pluginRoot }],
      actionRoots: [{ root: join(pluginRoot, "actions"), pluginRoot }],
    });
    t.after(async () => {
      await host.close();
      await rm(root, { recursive: true, force: true });
    });
    for (const dir of [
      directory,
      join(pluginRoot, "actions"),
      join(pluginRoot, "helpers"),
      join(pluginRoot, "node_modules", "dependency"),
      join(pluginRoot, ".git", "objects"),
    ]) {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "helper.js"), "export const version = 1;\n");
    }
    await writeFile(
      join(directory, "watch-probe.flow.js"),
      `
export const name = "startup-watch-probe";
export const inject = ["hmr"];
export async function apply(ctx) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(${JSON.stringify(snapshot)}, JSON.stringify({ base: ctx.hmr.baseDir, watched: ctx.hmr.watcher.getWatched() }));
}
`,
    );
    await host.open();
    const { base, watched } = JSON.parse(await readFile(snapshot, "utf8")) as {
      base: string;
      watched: Record<string, string[]>;
    };
    const source = Object.entries(watched).find(
      ([path]) => relative(pluginRoot, resolve(base, path)) === "helpers",
    );
    assert.ok(
      source?.[1].includes("helper.js"),
      "helper sources remain watched",
    );
    for (const [path, files] of Object.entries(watched)) {
      assert.doesNotMatch(
        relative(pluginRoot, resolve(base, path)),
        /(?:^|[/\\])(?:node_modules|\.git)(?:[/\\]|$)/u,
      );
      if (relative(pluginRoot, resolve(base, path)) === "") {
        assert.ok(!files.includes("node_modules"));
        assert.ok(!files.includes(".git"));
      }
    }
    await host.close();
    const logs = (
      await readFile(join(root, ".aura/dsh/logs/aura-host.log"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as StartupTiming & { event: string });
    const timings = logs.filter((row) => row.event === "startup");
    assert.equal(new Set(timings.map((row) => row.startupId)).size, 1);
    for (const stage of [
      "profile",
      "dsh-load",
      "orchestration-setup",
      "discovery",
      "flow-recovery",
      "total",
    ]) {
      assert.ok(
        timings.some(
          (row) => row.stage === stage && row.status === "completed",
        ),
        stage,
      );
    }
  },
);
