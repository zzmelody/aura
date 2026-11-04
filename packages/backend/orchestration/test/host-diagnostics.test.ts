import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  HostDiagnosticReader,
  HostLogger,
  hostErrorDiagnostic,
  hostErrorDiagnostics,
  HOST_DIAGNOSTIC_PREFIX,
  type HostErrorDiagnostic,
} from "../src/host-diagnostics.ts";
import { dshHostEntry, provisionProfile } from "../src/profile.ts";

test("diagnostics preserve compiler location and discard raw secrets, snippets and forged fields", () => {
  const error = Object.assign(
    new SyntaxError("Expression expected; access_token=secret-oauth"),
    { code: "ERR_INVALID_TYPESCRIPT_SYNTAX" },
  );
  error.stack =
    "file:///tmp/coding/history.ts:281\napiKey=secret-api-key\nSyntaxError: Expression expected";
  const diagnostic = hostErrorDiagnostic(error);
  assert.deepEqual(diagnostic, {
    name: "SyntaxError",
    reason: "Expression expected",
    code: "ERR_INVALID_TYPESCRIPT_SYNTAX",
    location: "file:///tmp/coding/history.ts:281",
  });
  const records: HostErrorDiagnostic[] = [];
  let failed = false;
  const reader = new HostDiagnosticReader(
    (error) => records.push(error),
    () => {
      failed = true;
    },
  );
  const line =
    HOST_DIAGNOSTIC_PREFIX +
    JSON.stringify({
      ...diagnostic,
      authorization: "Bearer secret-token",
      message: "secret-oauth",
    }) +
    "\n";
  reader.push("raw stderr secret-api-key\n");
  reader.push(line.slice(0, 17));
  reader.push(line.slice(17));
  reader.push(
    HOST_DIAGNOSTIC_PREFIX +
      '{"name":"secret-name","reason":"secret-reason","location":"https://example.com?apiKey=secret"}\n',
  );
  reader.push("aura-orchestration (file:///tmp/plugin.ts): failed to import\n");
  assert.equal(failed, true);
  assert.deepEqual(records[0], diagnostic);
  assert.doesNotMatch(JSON.stringify(records), /secret-/);
  const wrapped = new Error("secret-wrapper", {
    cause: Object.assign(new Error("secret-path"), { code: "ENOTDIR" }),
  });
  assert.ok(
    hostErrorDiagnostics(wrapped).some((error) => error.code === "ENOTDIR"),
  );
  reader.push(
    "aura-orchestration (file:///tmp/plugin.ts): pending (waiting for services: llm, workspaceRegistry)\n",
  );
  assert.deepEqual(records.at(-1)?.services, ["llm", "workspaceRegistry"]);
  assert.doesNotMatch(JSON.stringify(hostErrorDiagnostics(wrapped)), /secret-/);
});

test("sanitized host logs are private, flushed and rotated", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aura-log-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logger = new HostLogger(root);
  logger.write(
    "startup-failed",
    hostErrorDiagnostic(new Error("Bearer secret-oauth")),
  );
  await logger.flush();
  const path = join(root, "logs", "aura-host.log");
  assert.doesNotMatch(await readFile(path, "utf8"), /secret-oauth/);
  if (process.platform !== "win32")
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  await writeFile(path, "x".repeat(1_048_576));
  logger.write("restarted");
  await logger.flush();
  assert.equal((await stat(path + ".1")).size, 1_048_576);
  assert.match(await readFile(path, "utf8"), /restarted/);
});

test(
  "real DSH import failure reaches Aura diagnostics with its source line",
  { timeout: 20000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "aura-import-failure-"));
    const home = join(root, ".aura", "dsh");
    let stop = async () => {};
    t.after(async () => {
      // Windows cannot remove a live DSH process's watched files. One hook
      // ensures a failed removal never prevents the child from being stopped.
      await stop();
      await rm(root, { recursive: true, force: true });
    });
    await provisionProfile(home, undefined, undefined, root);
    const broken = join(root, "broken.ts");
    await writeFile(
      broken,
      "export const broken = ; // secret-provider-token\n",
    );
    const patch = join(home, "profiles", "aura-flow", "cordis.patch.yml");
    const source = await readFile(patch, "utf8");
    await writeFile(
      patch,
      source.replace(
        new URL("../src/plugin.ts", import.meta.url).href,
        pathToFileURL(broken).href,
      ),
    );
    const child = spawn(
      process.execPath,
      ["--expose-internals", dshHostEntry],
      {
        cwd: root,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          DSH_HOME: home,
          DSH_TELEMETRY_DISABLED: "1",
        },
      },
    );
    const exited = new Promise<void>((resolve) =>
      child.once("close", () => resolve()),
    );
    stop = async () => {
      child.kill("SIGKILL");
      await exited;
    };
    child.stdout.resume();
    const records: HostErrorDiagnostic[] = [];
    const logger = new HostLogger(home);
    let rejectFailure: (error: Error) => void = () => {};
    const failed = new Promise<void>((resolve, reject) => {
      rejectFailure = reject;
      const reader = new HostDiagnosticReader((error) => {
        records.push(error);
        logger.write("plugin-error", error);
      }, resolve);
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => reader.push(chunk));
      child.once("error", reject);
    });
    const timeout = setTimeout(
      () => rejectFailure(new Error("DSH did not report the failed import")),
      15000,
    );
    try {
      await failed;
    } finally {
      clearTimeout(timeout);
    }
    assert.ok(
      records.some(
        (error) =>
          error.name === "SyntaxError" &&
          error.location?.includes("broken.ts:1"),
      ),
      JSON.stringify(records),
    );
    assert.doesNotMatch(JSON.stringify(records), /secret-provider-token/);
    await logger.flush();
    const log = await readFile(join(home, "logs", "aura-host.log"), "utf8");
    assert.match(log, /broken.ts:1/);
    assert.match(log, /SyntaxError/);
    assert.doesNotMatch(log, /secret-provider-token/);
    const logs = await readdir(join(home, "logs"));
    assert.ok(logs.every((name) => !name.startsWith("startup-")));
  },
);
