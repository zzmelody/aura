import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import type { AuraRuntimeOptions, RuntimeConfig } from "./types.ts";

const defaultRoot = fileURLToPath(new URL("../../../../", import.meta.url));

// Port 0 asks the OS for an ephemeral port; the bound port is reported by the listener.
function resolvePort(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 65_535)
    throw new Error(`Aura runtime port is invalid: ${value}`);
  return value;
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
  const root = resolve(
    options.root ?? (process.env.AURA_ROOT?.trim() || defaultRoot),
  );
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
    pluginConfigPath: resolve(
      options.pluginConfigPath ?? join(root, ".aura", "plugins.json"),
    ),
    defaultPluginsDirectory: resolve(
      options.defaultPluginsDirectory ?? join(root, "plugins"),
    ),
    // Scratch files only; the whole directory may be deleted between runs.
    tempDir: resolve(
      options.tempDir ??
        (process.env.AURA_TEMP_DIR?.trim() || join(root, "local", "runtime")),
    ),
    // User conversations must survive cleaning the Aura root, so keep them outside it.
    defaultWorkspace: resolve(
      options.defaultWorkspace ??
        (process.env.AURA_DEFAULT_WORKSPACE?.trim() ||
          join(homedir(), "Documents", "Aura")),
    ),
  };
}
