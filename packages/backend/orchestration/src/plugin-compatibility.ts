import { z } from "zod";
import type { AuraPluginIdentity } from "@aura/protocol/types";

const revision = z
  .object({
    from: z.array(z.string().regex(/^[a-f0-9]{64}$/u)).min(1),
    to: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
export const compatibilitySchema = z
  .object({
    flows: z.record(z.string(), revision).optional(),
    actions: z.record(z.string(), revision).optional(),
    presets: z.array(z.string()).optional(),
    storageDomains: z.array(z.string()).optional(),
    directories: z.array(z.string()).optional(),
    rpcPrefixes: z.array(z.string()).optional(),
  })
  .strict();
export const httpContributionSchema = z
  .object({
    entry: z.string().min(1),
    mounts: z.array(z.string().regex(/^\/flows\/[a-z][a-z0-9-]*$/u)).min(1),
  })
  .strict();

/** A reviewed one-time relocation, bound to exact old and new content hashes. */
export function compatibleRevision<
  T extends {
    sourceHash: string;
    plugin?: AuraPluginIdentity;
    ownerPlugin?: AuraPluginIdentity;
    legacySourceHashes?: readonly string[];
  },
>(loaded: T, saved: { sourceHash: string; plugin?: AuraPluginIdentity }): T {
  if (
    !saved.plugin &&
    loaded.plugin &&
    loaded.legacySourceHashes?.includes(saved.sourceHash)
  ) {
    return {
      ...loaded,
      sourceHash: saved.sourceHash,
      ownerPlugin: loaded.plugin,
      plugin: undefined,
    };
  }
  return loaded;
}
