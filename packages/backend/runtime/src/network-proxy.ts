import { execFile } from "node:child_process";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

const WINDOWS_INTERNET_SETTINGS =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
// Brackets keep undici from interpreting the final IPv6 segment as a port.
const LOCAL_BYPASS = ["127.0.0.1", "localhost", "[::1]"];

export interface NetworkProxySettings {
  httpProxy?: string;
  httpsProxy?: string;
  noProxy: string;
}

interface ConfigureNetworkOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  readWindowsProxy?: () => Promise<NetworkProxySettings | undefined>;
  installDispatcher?: (settings: NetworkProxySettings) => void;
}

function environmentValue(
  env: NodeJS.ProcessEnv,
  names: string[],
): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function normalizeProxyUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(
      /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`,
    );
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

/** Parses the two Windows manual-proxy formats without exposing registry data. */
export function parseWindowsProxyServer(
  value: string,
): Pick<NetworkProxySettings, "httpProxy" | "httpsProxy"> | undefined {
  const entries = value
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!entries.length) return undefined;

  if (!entries.some((entry) => entry.includes("="))) {
    const proxy = normalizeProxyUrl(entries[0]);
    return proxy ? { httpProxy: proxy, httpsProxy: proxy } : undefined;
  }

  const byProtocol = new Map<string, string>();
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator < 1) continue;
    byProtocol.set(
      entry.slice(0, separator).trim().toLowerCase(),
      entry.slice(separator + 1).trim(),
    );
  }
  const httpProxy = normalizeProxyUrl(byProtocol.get("http"));
  const httpsProxy = normalizeProxyUrl(byProtocol.get("https"));
  return httpProxy || httpsProxy ? { httpProxy, httpsProxy } : undefined;
}

/** Produces one no-proxy list while always keeping Aura's loopback services local. */
export function mergeNoProxy(...values: Array<string | undefined>): string {
  const entries = values
    .flatMap((value) => value?.split(/[;,\s]+/) ?? [])
    .map((entry) => entry.trim())
    .filter((entry) => entry && entry.toLowerCase() !== "<local>");
  const unique = new Map<string, string>();
  for (const entry of [...entries, ...LOCAL_BYPASS])
    unique.set(entry.toLowerCase(), entry);
  return [...unique.values()].join(",");
}

function registryValue(output: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return output.match(
    new RegExp(`^\\s*${escaped}\\s+REG_\\w+\\s+(.+?)\\s*$`, "im"),
  )?.[1];
}

function queryRegistry(name: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "reg.exe",
      ["query", WINDOWS_INTERNET_SETTINGS, "/v", name],
      { encoding: "utf8", windowsHide: true },
      (error, stdout) =>
        resolve(error ? undefined : registryValue(stdout, name)),
    );
  });
}

async function readWindowsSystemProxy(): Promise<
  NetworkProxySettings | undefined
> {
  const enabled = await queryRegistry("ProxyEnable");
  if (enabled === undefined || Number(enabled) !== 1) return undefined;
  const [server, override] = await Promise.all([
    queryRegistry("ProxyServer"),
    queryRegistry("ProxyOverride"),
  ]);
  const parsed = server ? parseWindowsProxyServer(server) : undefined;
  if (!parsed) return undefined;
  return { ...parsed, noProxy: mergeNoProxy(override) };
}

function installProxyDispatcher(settings: NetworkProxySettings): void {
  setGlobalDispatcher(new EnvHttpProxyAgent(settings));
}

let installedSignature: string | undefined;

/**
 * Makes backend fetches and subsequently spawned Node processes use one proxy.
 * Explicit environment configuration wins; Windows manual proxy settings are
 * used only when the process has no proxy configuration of its own.
 */
export async function configureRuntimeNetwork(
  options: ConfigureNetworkOptions = {},
): Promise<NetworkProxySettings | undefined> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const allProxy = environmentValue(env, ["all_proxy", "ALL_PROXY"]);
  let httpProxy = normalizeProxyUrl(
    environmentValue(env, ["http_proxy", "HTTP_PROXY"]) ?? allProxy,
  );
  let httpsProxy = normalizeProxyUrl(
    environmentValue(env, ["https_proxy", "HTTPS_PROXY"]) ?? allProxy,
  );
  let systemNoProxy: string | undefined;

  if (!httpProxy && !httpsProxy && platform === "win32") {
    const system = await (options.readWindowsProxy ?? readWindowsSystemProxy)();
    httpProxy = system?.httpProxy;
    httpsProxy = system?.httpsProxy;
    systemNoProxy = system?.noProxy;
  }
  if (!httpProxy && !httpsProxy) return undefined;

  httpsProxy ??= httpProxy;
  const noProxy = mergeNoProxy(
    environmentValue(env, ["no_proxy", "NO_PROXY"]),
    systemNoProxy,
  );
  if (httpProxy) env.HTTP_PROXY = httpProxy;
  if (httpsProxy) env.HTTPS_PROXY = httpsProxy;
  env.NO_PROXY = noProxy;
  env.NODE_USE_ENV_PROXY = "1";

  const settings = { httpProxy, httpsProxy, noProxy };
  const signature = JSON.stringify(settings);
  if (signature !== installedSignature) {
    (options.installDispatcher ?? installProxyDispatcher)(settings);
    installedSignature = signature;
  }
  return settings;
}
