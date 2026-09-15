import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { Context } from "@deepseek-ai/cordis";
import LocalSubprocessRuntime from "@deepseek-ai/dsh-subprocess-local";
import { acquireGpuLease } from "../../src/local-ai/ownership.ts";
import { launchOwned } from "../../src/local-ai/process.ts";
import { Hono } from "hono";
import { serve } from "@hono/node-server";

const [role, path] = process.argv.slice(2);
const leaseName =
  "Local\\Aura.LocalAI.Test." + createHash("sha256").update(path).digest("hex");
if (role === "owner") {
  const ctx = new Context();
  const sub = new LocalSubprocessRuntime(ctx);
  acquireGpuLease(leaseName); // Intentionally no graceful cleanup: the test kills this owner.
  launchOwned(sub, {
    argv: [process.execPath, import.meta.filename, "child", path],
    cwd: process.cwd(),
    env: {},
  });
} else if (role === "child") {
  const grandchild = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { windowsHide: true, stdio: "ignore" },
  );
  const server = serve({
    fetch: new Hono().fetch,
    hostname: "127.0.0.1",
    port: 0,
  });
  if (!server.listening)
    await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No fixture listener");
  await writeFile(
    path,
    JSON.stringify({
      child: process.pid,
      grandchild: grandchild.pid,
      port: address.port,
    }),
  );
} else if (role === "lease") {
  const release = acquireGpuLease(leaseName);
  release();
  process.exit(0);
} else throw new Error("Unknown fixture role");
setInterval(() => {}, 1000);
