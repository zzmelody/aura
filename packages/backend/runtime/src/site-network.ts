import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stripVTControlCharacters } from "node:util";

const exec = promisify(execFile);
const processQueryOptions = {
  timeout: 2500,
  maxBuffer: 4 * 1024 * 1024,
  windowsHide: true,
};

export function localSiteUrl(input: string): URL {
  const url = new URL(input.trim());
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    !["localhost", "127.0.0.1", "[::1]", "0.0.0.0", "[::]"].includes(
      url.hostname,
    )
  )
    throw new Error("预览地址必须是本机 HTTP(S) 地址，且不能包含账号或密码。");
  if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1";
  if (url.hostname === "[::]") url.hostname = "[::1]";
  return url;
}

export function sitePort(url: URL): number {
  return Number(url.port || (url.protocol === "https:" ? 443 : 80));
}

/** Listener-table preflight for scripts whose port cannot be injected safely. */
export async function portAvailable(port: number): Promise<boolean> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  const listeners = await listeningPids(port);
  return listeners !== null && listeners.length === 0;
}

async function listeningPids(port: number): Promise<number[] | null> {
  if (process.platform === "win32") {
    try {
      const { stdout } = await exec(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$ErrorActionPreference='Stop'; $owners=@(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess); $owners | ConvertTo-Json -Compress`,
        ],
        processQueryOptions,
      );
      if (!stdout.trim()) return [];
      const data = JSON.parse(stdout) as number | number[] | null;
      if (Array.isArray(data)) return data;
      return typeof data === "number" ? [data] : [];
    } catch {
      return null;
    }
  }
  try {
    const result = await exec(
      "lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"],
      processQueryOptions,
    );
    return [...result.stdout.matchAll(/^p(\d+)$/gm)].map((match) =>
      Number(match[1]),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (process.platform !== "linux") return null;
      try {
        const result = await exec(
          "ss",
          ["-ltnp", `sport = :${port}`],
          processQueryOptions,
        );
        const lines = result.stdout.trim().split("\n").slice(1);
        if (!lines.length) return [];
        if (lines.some((line) => !/pid=\d+/.test(line))) return null;
        return [...result.stdout.matchAll(/pid=(\d+)/g)].map((match) =>
          Number(match[1]),
        );
      } catch {
        return null;
      }
    }
    const stdout =
      typeof error === "object" && error !== null && "stdout" in error
        ? String((error as { stdout?: unknown }).stdout ?? "")
        : "";
    // lsof exits 1 when there are no matching sockets. Preserve that useful
    // answer instead of treating a normal "no listeners" result as failure.
    if (!stdout.trim()) return [];
    return [...stdout.matchAll(/^p(\d+)$/gm)].map((match) => Number(match[1]));
  }
}

export async function availableSitePort(preferred: number): Promise<number> {
  for (let i = 0; i < 100; i++) {
    const port = preferred + i;
    if (port > 65535) break;
    if (await portAvailable(port)) return port;
  }
  throw new Error(
    `从端口 ${preferred} 开始未找到空闲端口，请修改预览地址后重试。`,
  );
}

type ProcessRow = { pid: number; parent: number; group?: number };
type Listener = { pid: number; names: string[] };

export function belongsToSite(
  owners: number[],
  rows: ProcessRow[],
  root: number,
): boolean {
  if (!owners.length || !rows.some((row) => row.pid === root)) return false;
  const allowed = new Set([root]);
  for (const row of rows) if (row.group === root) allowed.add(row.pid);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows)
      if (allowed.has(row.parent) && !allowed.has(row.pid)) {
        allowed.add(row.pid);
        changed = true;
      }
  }
  return owners.every((pid) => allowed.has(pid));
}

function parseLsofListeners(output: string): Listener[] {
  const listeners: Listener[] = [];
  let current: Listener | undefined;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("p")) {
      if (current) listeners.push(current);
      const pid = Number(line.slice(1));
      current = Number.isInteger(pid) ? { pid, names: [] } : undefined;
    } else if (current && line.startsWith("n")) {
      current.names.push(line.slice(1));
    }
  }
  if (current) listeners.push(current);
  return listeners;
}

function listenerMatches(
  name: string,
  hostname: string,
  port: number,
): { exact: boolean; wildcard: boolean } {
  const suffix = `:${port}`;
  if (!name.endsWith(suffix)) return { exact: false, wildcard: false };
  const address = name.slice(0, -suffix.length);
  const exactHosts =
    hostname === "localhost"
      ? new Set(["127.0.0.1", "[::1]"])
      : new Set([hostname === "::1" ? "[::1]" : hostname]);
  return {
    exact: exactHosts.has(address),
    wildcard: address === "*" || address === "[::]",
  };
}

function listenerOwnersForHost(
  listeners: Listener[],
  hostname: string,
  port: number,
): number[] {
  const exact: number[] = [];
  const wildcard: number[] = [];
  for (const listener of listeners) {
    const matches = listener.names.reduce(
      (result, name) => {
        const match = listenerMatches(name, hostname, port);
        return {
          exact: result.exact || match.exact,
          wildcard: result.wildcard || match.wildcard,
        };
      },
      { exact: false, wildcard: false },
    );
    if (matches.exact) exact.push(listener.pid);
    else if (matches.wildcard) wildcard.push(listener.pid);
  }
  // A specific listener wins over a wildcard listener for the requested URL.
  // This matters on macOS, where SO_REUSEADDR can leave both visible in lsof.
  return [...new Set(exact.length ? exact : wildcard)];
}

/** Fail closed if ownership cannot be inspected. Never adopt another local server. */
export async function siteOwnsPort(
  root: number,
  port: number,
  hostname = "127.0.0.1",
): Promise<boolean> {
  if (
    !Number.isInteger(root) ||
    root <= 0 ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    return false;
  try {
    if (process.platform === "win32") {
      const { stdout } = await exec(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$ErrorActionPreference='Stop'; $owners=@(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess); $rows=@(Get-CimInstance Win32_Process | Select-Object @{n='pid';e={$_.ProcessId}},@{n='parent';e={$_.ParentProcessId}}); @{owners=$owners;rows=$rows} | ConvertTo-Json -Depth 4 -Compress`,
        ],
        processQueryOptions,
      );
      const data = JSON.parse(stdout) as {
        owners: number[];
        rows: ProcessRow[];
      };
      return belongsToSite(data.owners, data.rows, root);
    }
    const { stdout } = await exec(
      "ps",
      ["-axo", "pid=,ppid=,pgid="],
      processQueryOptions,
    );
    const rows = stdout
      .trim()
      .split("\n")
      .map((line) => {
        const [pid, parent, group] = line.trim().split(/\s+/).map(Number);
        return { pid, parent, group };
      });
    let owners: number[];
    try {
      const result = await exec(
        "lsof",
        ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpcn"],
        processQueryOptions,
      );
      owners = listenerOwnersForHost(
        parseLsofListeners(result.stdout),
        hostname,
        port,
      );
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" ||
        process.platform !== "linux"
      )
        return false;
      const result = await exec(
        "ss",
        ["-ltnp", `sport = :${port}`],
        processQueryOptions,
      );
      const lines = result.stdout.trim().split("\n").slice(1);
      if (!lines.length || lines.some((line) => !/pid=\d+/.test(line)))
        return false;
      owners = [...result.stdout.matchAll(/pid=(\d+)/g)].map((match) =>
        Number(match[1]),
      );
    }
    if (!owners.length) return false;
    return belongsToSite(owners, rows, root);
  } catch {
    return false;
  }
}

/** Only server's Local/listening announcements, never docs links or arbitrary output URLs. */
export function announcedSiteUrls(output: string): string[] {
  const result: string[] = [];
  for (const line of stripVTControlCharacters(output).split(/[\r\n]/)) {
    if (!/\b(local\s*:|listening\b|server\s+(?:running|started)\b)/i.test(line))
      continue;
    for (const match of line.matchAll(/https?:\/\/[^\s<>"']+/g)) {
      try {
        result.push(localSiteUrl(match[0].replace(/[),;]+$/, "")).toString());
      } catch {
        /* Not a local preview. */
      }
    }
  }
  return [...new Set(result)].slice(-8);
}

export async function siteResponds(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(700),
    });
    await response.body?.cancel();
    return response.status >= 200 && response.status < 400;
  } catch {
    return false;
  }
}
