import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Plugin } from "vite";

// A dev renderer whose launcher died without tearing it down keeps the fixed
// dev port. Each instance records a token so the next one can ask it to exit,
// and watches its whole ancestor chain so it notices the launcher going away.

export const SHUTDOWN_PATH = "/__aura/dev-shutdown";
const TOKEN_HEADER = "x-aura-dev-token";

export type DevInstance = { pid: number; token: string };

export function createDevToken(): string {
  return randomBytes(32).toString("hex");
}

export function devInstanceFile(
  target: string,
  port: number,
  directory = tmpdir(),
): string {
  return resolve(directory, `aura-dev-renderer-${target}-${port}.json`);
}

async function readInstance(file: string): Promise<DevInstance | null> {
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (
      typeof value === "object" &&
      value !== null &&
      "pid" in value &&
      "token" in value &&
      typeof value.pid === "number" &&
      typeof value.token === "string"
    )
      return { pid: value.pid, token: value.token };
  } catch {
    // Missing or unreadable records mean there is nothing to reclaim.
  }
  return null;
}

export async function writeDevInstance(
  file: string,
  instance: DevInstance,
): Promise<void> {
  await writeFile(file, JSON.stringify(instance), { mode: 0o600 });
}

export async function removeDevInstance(
  file: string,
  token: string,
): Promise<void> {
  // A newer instance may already own the record.
  if ((await readInstance(file))?.token === token)
    await rm(file, { force: true });
}

function isLoopback(address: string | undefined): boolean {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

export function devShutdown(token: string, onShutdown: () => void): Plugin {
  const expected = Buffer.from(token);
  return {
    name: "aura-dev-shutdown",
    configureServer(server) {
      server.middlewares.use(SHUTDOWN_PATH, (request, response) => {
        const header = request.headers[TOKEN_HEADER];
        const supplied = Buffer.from(typeof header === "string" ? header : "");
        const authorized =
          request.method === "POST" &&
          isLoopback(request.socket.remoteAddress) &&
          supplied.length === expected.length &&
          timingSafeEqual(supplied, expected);
        response.statusCode = authorized ? 202 : 403;
        response.end();
        if (authorized) onShutdown();
      });
    },
  };
}

function portInUse(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("error", () => done(false));
  });
}

/** Asks a previous Aura dev renderer on `port` to exit; true once the port is free. */
export async function reclaimDevPort(
  port: number,
  file: string,
  timeoutMs = 10_000,
): Promise<boolean> {
  if (!(await portInUse(port))) return true;
  const previous = await readInstance(file);
  if (!previous) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${port}${SHUTDOWN_PATH}`, {
      method: "POST",
      headers: { [TOKEN_HEADER]: previous.token },
      signal: AbortSignal.timeout(2_000),
    });
    if (response.status !== 202) return false;
  } catch {
    return false;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await portInUse(port))) return true;
    await new Promise((done) => setTimeout(done, 100));
  }
  return false;
}

export type ProcessEntry = { parent: number; created: number; name: string };

// The package-manager wrappers between the user's shell and the renderer. The
// shell, terminal and editor above them have their own lifetimes.
const WRAPPERS = new Set(["node.exe", "pnpm.exe", "cmd.exe"]);

/** Walks wrapper parents from `start`, stopping at links broken by PID reuse. */
export function ancestorChain(
  start: number,
  table: ReadonlyMap<number, ProcessEntry>,
): number[] {
  const chain: number[] = [];
  let current = start;
  while (current > 4 && !chain.includes(current)) {
    const entry = table.get(current);
    if (!entry || !WRAPPERS.has(entry.name.toLowerCase())) break;
    chain.push(current);
    const parent = table.get(entry.parent);
    // A parent started after its child is an unrelated process with a reused PID.
    if (!parent || parent.created > entry.created) break;
    current = entry.parent;
  }
  return chain;
}

function windowsProcessTable(): Promise<Map<number, ProcessEntry>> {
  const command =
    "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2} {3}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToFileTimeUtc(), $_.Name }";
  return new Promise((done) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      { windowsHide: true, timeout: 15_000 },
      (error, stdout) => {
        const table = new Map<number, ProcessEntry>();
        if (!error)
          for (const line of stdout.split(/\r?\n/)) {
            const [pid, parent, created, ...name] = line.trim().split(" ");
            if (
              Number.isInteger(Number(pid)) &&
              Number.isInteger(Number(parent))
            )
              table.set(Number(pid), {
                parent: Number(parent),
                created: Number(created) || 0,
                name: name.join(" "),
              });
          }
        done(table);
      },
    );
  });
}

/** Processes whose exit should stop the dev renderer. */
export async function launcherProcesses(): Promise<number[]> {
  const launcher = Number(process.env.AURA_LAUNCHER_PID);
  if (Number.isInteger(launcher) && launcher > 0) return [launcher];
  // Windows keeps intermediate pnpm/cmd processes alive when an outer one is
  // killed, so the direct parent alone never notices the launcher is gone.
  if (process.platform !== "win32") return [process.ppid];
  const chain = ancestorChain(process.ppid, await windowsProcessTable());
  return chain.length ? chain : [process.ppid];
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
