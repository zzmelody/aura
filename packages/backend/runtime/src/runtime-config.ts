import { copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, URL } from "node:url";
import type { AuraRuntimeOptions, RuntimeConfig } from "./types.ts";

const defaultRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const require = createRequire(import.meta.url);

// Port 0 asks the OS for an ephemeral port; the bound port is reported by the listener.
function resolvePort(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 65_535)
    throw new Error(`Aura runtime port is invalid: ${value}`);
  return value;
}

function resolveTripoRegion(value: string | undefined): "global" | "china" {
  const region = value?.trim().toLowerCase() || "global";
  if (region !== "global" && region !== "china")
    throw new Error(`Aura Tripo region is invalid: ${region}`);
  return region;
}

function defaultWorldAgentSessionPath(): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (!appData)
      throw new Error("APPDATA is required to discover the Veya World Agent.");
    return join(
      appData,
      "Godot",
      "app_userdata",
      "Veya",
      "world-agent-session.json",
    );
  }
  if (process.platform === "darwin")
    return join(
      homedir(),
      "Library",
      "Application Support",
      "Godot",
      "app_userdata",
      "Veya",
      "world-agent-session.json",
    );
  return join(
    process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
    "godot",
    "app_userdata",
    "Veya",
    "world-agent-session.json",
  );
}

/** Trusted plugin code may be configured only when the runtime is not LAN-bound. */
export function isLoopbackRuntimeHost(host: string): boolean {
  return new Set(["localhost", "127.0.0.1", "::1"]).has(
    host
      .trim()
      .toLowerCase()
      .replace(/^\[(.*)\]$/u, "$1"),
  );
}

/** Resolves environment overrides once at the composition boundary. */
export function resolveRuntimeConfig(
  options: AuraRuntimeOptions = {},
): RuntimeConfig {
  const root = resolve(options.root ?? (process.env.AURA_ROOT?.trim() || defaultRoot));
  const host = (options.host ?? process.env.HOST ?? "127.0.0.1").trim();
  if (!host) throw new Error("Aura runtime host cannot be empty.");
  const port = resolvePort(options.port ?? Number(process.env.PORT ?? 4311));

  return {
    root,
    host,
    port,
    dshHome: join(root, ".aura", "dsh"),
    credentialPath: join(root, ".aura", "dsh", ".credentials.yaml"),
    codexModel: process.env.AURA_CODEX_MODEL ?? "gpt-6.1-sol",
    tripoCredentialPath: join(root, ".aura", "tripo", "api-key"),
    tripoRegion: resolveTripoRegion(process.env.AURA_TRIPO_REGION),
    pluginConfigPath: resolve(
      options.pluginConfigPath ?? join(root, ".aura", "plugins.json"),
    ),
    worldAgentSessionPath: resolve(
      options.worldAgentSessionPath ??
        process.env.AURA_VEYA_WORLD_AGENT_SESSION ??
        defaultWorldAgentSessionPath(),
    ),
  };
}
