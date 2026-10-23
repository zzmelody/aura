import { valid, validRange } from "semver";
import { z } from "zod";
const pluginIdPattern = /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/u;
export const localIdPattern = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/u;

const configEntrySchema = z
  .object({
    path: z.string().trim().min(1).max(4_096),
    enabled: z.boolean(),
    trust: z.literal("local"),
    settings: z
      .json()
      .refine((value) => JSON.stringify(value).length <= 64 * 1_024)
      .optional(),
  })
  .strict();

export const configSchema = z
  .object({
    version: z.literal(1),
    plugins: z.array(configEntrySchema).max(64),
  })
  .strict();

export const settingsUpdateSchema = z
  .object({
    plugins: z
      .array(
        z
          .object({
            path: z.string().trim().min(1).max(4_096),
            enabled: z.boolean(),
          })
          .strict(),
      )
      .max(64),
  })
  .strict();

const revisionSchema = z
  .object({
    from: z.array(z.string().regex(/^[a-f0-9]{64}$/u)).min(1),
    to: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
const legacyIds = z.record(z.string().regex(localIdPattern), revisionSchema);
export const compatibilitySchema = z
  .object({
    flows: legacyIds.optional(),
    actions: legacyIds.optional(),
    presets: z.array(z.string()).optional(),
    storageDomains: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/u)).optional(),
    directories: z.array(z.string().regex(/^[a-z][a-z0-9_-]*$/u)).optional(),
    rpcPrefixes: z.array(z.string().regex(/^[a-z][a-z0-9-]*\/$/u)).optional(),
  })
  .strict();
export const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(pluginIdPattern),
    name: z.string().trim().min(1).max(80),
    version: z.string().refine((value) => Boolean(valid(value))),
    description: z.string().max(500).optional(),
    homepage: z.string().optional(),
    license: z.string().optional(),
    engines: z
      .object({
        aura: z.string().refine((value) => Boolean(validRange(value))),
        pluginSdk: z.string().refine((value) => Boolean(validRange(value))),
      })
      .strict(),
    contributes: z
      .object({
        actions: z.string().trim().min(1).optional(),
        flows: z.string().trim().min(1).optional(),
        capabilities: z.string().trim().min(1).optional(),
        /** Built browser bundle entry (lazy-CJS), e.g. ./client/dist/client.js. */
        pages: z.string().trim().min(1).optional(),
        presets: z.string().trim().min(1).optional(),
        http: z
          .object({
            entry: z.string().min(1),
            mounts: z
              .array(z.string().regex(/^\/flows\/[a-z][a-z0-9-]*$/u))
              .min(1),
          })
          .strict()
          .optional(),
      })
      .strict()
      .refine((value) =>
        Boolean(
          value.actions || value.flows || value.capabilities || value.pages,
        ),
      ),
    compatibility: compatibilitySchema.optional(),
    capabilities: z.array(z.string().trim().min(1)).default([]),
  })
  .strict();
