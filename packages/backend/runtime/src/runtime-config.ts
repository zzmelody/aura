import { copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import type { AuraRuntimeOptions, RuntimeConfig } from "./types.ts";

const defaultRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const require = createRequire(import.meta.url);

function resolvePort(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535)
    throw new Error(`Aura runtime port is invalid: ${value}`);
  return value;
}

function resolveTripoRegion(value: string | undefined): "global" | "china" {
  const region = value?.trim().toLowerCase() || "global";
  if (region !== "global" && region !== "china")
    throw new Error(`Aura Tripo region is invalid: ${region}`);
  return region;
}

/** Resolves environment overrides once at the composition boundary. */
export function resolveRuntimeConfig(
  options: AuraRuntimeOptions = {},
): RuntimeConfig {
  const root = resolve(options.root ?? defaultRoot);
  const host = (options.host ?? process.env.HOST ?? "127.0.0.1").trim();
  if (!host) throw new Error("Aura runtime host cannot be empty.");
  const port = resolvePort(options.port ?? Number(process.env.PORT ?? 4311));
  const dshPackage = require.resolve("@deepseek-ai/dsh/package.json");

  return {
    root,
    host,
    port,
    dshHome: join(root, ".aura", "dsh"),
    credentialPath: join(root, ".aura", "dsh", ".credentials.yaml"),
    dshExecutable: join(dirname(dshPackage), "lib", "bin.js"),
    codexModel: process.env.AURA_CODEX_MODEL ?? "gpt-5.6-terra",
    tripoCredentialPath: join(root, ".aura", "tripo", "api-key"),
    tripoRegion: resolveTripoRegion(process.env.AURA_TRIPO_REGION),
  };
}

/** Installs only Aura-owned profile files into the ignored DSH home. */
export async function prepareDshProfile(config: RuntimeConfig): Promise<void> {
  const profileDirectory = join(config.dshHome, "profiles", "aura-sdk");
  await mkdir(profileDirectory, { recursive: true });
  await Promise.all(
    ["package.json", "cordis.patch.yml"].map((name) =>
      copyFile(
        new URL(`../profile/${name}`, import.meta.url),
        join(profileDirectory, name),
      ),
    ),
  );
}
