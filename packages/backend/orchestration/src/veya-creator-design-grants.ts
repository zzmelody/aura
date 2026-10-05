import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { JsonValue } from "@aura/protocol/types";
import type { ProductionGrantRef } from "./veya-creator-production-grants.ts";

type RecordValue = Record<string, any>;
type BindingDocument = { version: 1; bindings: Record<string, RecordValue> };
type GrantKind = "world-design-recovery" | "prop-production-recovery";
type DesignGrant = { version: 1; kind: GrantKind;
  identity: { requestId: string; playerId: string; homeWorldId: string; creationSessionId: string;
    sourceRequestId: string; sourceRunId: string; textHash: string; sessionPathHash: string };
  recoveryHash: string; recovery: JsonValue };
const limit = 256 * 1024, grantLimit = 240 * 1024;
const sha = /^[a-f0-9]{64}$/u, uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const id = /^[A-Za-z0-9_-]{1,96}$/u;
const object = (v: unknown): RecordValue | undefined => v !== null && typeof v === "object" && !Array.isArray(v) ? v as RecordValue : undefined;
const digest = (v: string | Buffer): string => createHash("sha256").update(v).digest("hex");
function refuse(): never { throw new Error("creator_design_grant_invalid"); }
function exact(v: unknown, keys: string[]): RecordValue {
  const r = object(v); if (!r || Object.keys(r).length !== keys.length || keys.some(k => !Object.hasOwn(r, k))) refuse();
  return r;
}
function document(value: unknown): BindingDocument {
  const v = exact(value, ["version", "bindings"]);
  if (v.version !== 1 || !object(v.bindings) || Object.entries(v.bindings).some(([key, b]) => !uuid.test(key) || !object(b))) refuse();
  return v as BindingDocument;
}
function recovery(value: unknown, kind: GrantKind = "world-design-recovery"): JsonValue {
  if (kind === "prop-production-recovery") {
    const v = object(value);
    if (!v || v.schemaVersion !== 1 || v.noNewPaidWork !== true || !uuid.test(v.sourceRequestId) || !uuid.test(v.sourceRunId) ||
        object(v.brief)?.operation !== "create_prop" || !object(v.propSpec) || !object(v.assets) || !object(v.plan) ||
        typeof v.generationScope !== "string" || !v.generationScope.length || v.generationScope.length > 96 ||
        !Number.isInteger(v.repairRound) || v.repairRound < 0 || v.repairRound > 3 ||
        (v.assetWorldId !== undefined && !/^[a-f0-9]{32}$/u.test(v.assetWorldId)) ||
        Buffer.byteLength(JSON.stringify(v)) > grantLimit) refuse();
    return value as JsonValue;
  }
  const v = object(value), required = ["schemaVersion", "sourceRequestId", "sourceRunId", "brief", "plan", "designInput", "draftText", "draftHash", "formatCorrectionUsed"];
  if (!v || required.some(k => !Object.hasOwn(v, k)) || Object.keys(v).some(k => ![...required, "retainedSpec", "specHash", "semanticRevisionUsed", "reviewRetryUsed"].includes(k)) ||
      v.schemaVersion !== 1 || !uuid.test(v.sourceRequestId) || !uuid.test(v.sourceRunId) ||
      object(v.brief)?.operation !== "create_world" || !object(v.plan) || !object(v.designInput) ||
      typeof v.draftText !== "string" || !sha.test(v.draftHash) || digest(v.draftText) !== v.draftHash ||
      typeof v.formatCorrectionUsed !== "boolean" || Buffer.byteLength(JSON.stringify(v)) > grantLimit) refuse();
  const retained = ["retainedSpec", "specHash", "semanticRevisionUsed", "reviewRetryUsed"];
  if (retained.some(k => Object.hasOwn(v, k)) && (!object(v.retainedSpec) || !sha.test(v.specHash) ||
      digest(JSON.stringify(v.retainedSpec)) !== v.specHash || v.semanticRevisionUsed !== true || v.reviewRetryUsed !== true || !v.formatCorrectionUsed)) refuse();
  return value as JsonValue; // Preserve field order and every original value.
}
function identity(requestId: string, binding: RecordValue, source: RecordValue | undefined, value: JsonValue, kind: GrantKind = "world-design-recovery"): DesignGrant["identity"] {
  const r = object(value)!, input = object(binding.input), prior = object(source?.input);
  const operation = kind === "world-design-recovery" ? "create_world" : "create_prop";
  if (!uuid.test(requestId) || !source || !input || !prior || input.operation !== operation || prior.operation !== operation ||
      input.previousRequestId !== r.sourceRequestId || source.runId !== r.sourceRunId || typeof input.text !== "string" || input.text !== prior.text ||
      ["playerId", "homeWorldId"].some(k => typeof binding[k] !== "string" || !id.test(binding[k])) ||
      !/^[a-f0-9]{32}$/u.test(binding.creationSessionId) || typeof binding.sessionPath !== "string" || !isAbsolute(binding.sessionPath) ||
      ["playerId", "homeWorldId", "creationSessionId", "sessionPath"].some(k => binding[k] !== source[k]) ||
      binding.textHash !== digest(input.text) || source.textHash !== binding.textHash ||
      (kind === "world-design-recovery" ? binding.recovery : binding.worldDesignRecovery || binding.worldDesignRecoveryRef) ||
      binding.worldProductionRecoveryRef || binding.productionMaterialsRef || binding.previousArtifact ||
      input.previousArtifactId || input.reuseProductionFromRequestId || input.reuseAssetsFromRequestId) refuse();
  return { requestId, playerId: binding.playerId, homeWorldId: binding.homeWorldId, creationSessionId: binding.creationSessionId,
    sourceRequestId: r.sourceRequestId, sourceRunId: r.sourceRunId, textHash: binding.textHash, sessionPathHash: digest(binding.sessionPath) };
}
function validateGrant(value: unknown, requestId: string, binding: RecordValue, source: RecordValue | undefined, kind: GrantKind): DesignGrant {
  const v = exact(value, ["version", "kind", "identity", "recoveryHash", "recovery"]);
  const r = recovery(v.recovery, kind), expected = identity(requestId, binding, source, r, kind);
  const actual = exact(v.identity, Object.keys(expected));
  if (v.version !== 1 || v.kind !== kind || !sha.test(v.recoveryHash) ||
      digest(JSON.stringify(r)) !== v.recoveryHash || Object.entries(expected).some(([k, val]) => actual[k] !== val)) refuse();
  return v as DesignGrant;
}
async function stageImmutable(path: string, bytes: string | Buffer): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(bytes); await file.sync(); }
  finally { await file.close(); }
}
/** Internal filesystem seam; never a Flow or HTTP capability. Publish only a
 * closed, complete file. Atomic link preserves an existing immutable target. */
export async function writeImmutableDesignFile(path: string, bytes: string | Buffer,
  stage: (path: string, bytes: string | Buffer) => Promise<void> = stageImmutable): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await stage(temporary, bytes);
    try { await link(temporary, path); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST" || !(await readFile(path)).equals(Buffer.from(bytes))) throw e;
    }
  } finally { await rm(temporary, { force: true }); }
}

/** Decode only host-owned hash references. Legacy inline data stays readable;
 * the durable extraction and inherited-grant checks still run at their callers. */
export async function readCreatorBindingDocument(root: string, bytes: Buffer): Promise<BindingDocument> {
  if (bytes.length > limit) refuse();
  const stored = document(JSON.parse(bytes.toString("utf8"))), bindings = { ...stored.bindings };
  for (const [requestId, binding] of Object.entries(stored.bindings)) {
    if (binding.worldDesignRecoveryRef && binding.propRecoveryRef) refuse();
    const prop = Object.hasOwn(binding, "propRecoveryRef"), refKey = prop ? "propRecoveryRef" : "worldDesignRecoveryRef",
      dataKey = prop ? "recovery" : "worldDesignRecovery", kind: GrantKind = prop ? "prop-production-recovery" : "world-design-recovery";
    if (!Object.hasOwn(binding, refKey)) continue;
    if (Object.hasOwn(binding, dataKey)) refuse();
    const ref = exact(binding[refKey], ["grantId", "contentHash"]);
    if (!sha.test(ref.grantId) || ref.contentHash !== ref.grantId) refuse();
    let content: Buffer;
    try { content = await readFile(join(root, ".aura", "veya-creator", "grants", `${ref.grantId}.json`)); }
    catch { refuse(); } // Missing referenced content is corruption, not a new empty project.
    if (content.length > limit || digest(content) !== ref.contentHash) refuse();
    const grant = validateGrant(JSON.parse(content.toString("utf8")), requestId, binding, stored.bindings[binding.input?.previousRequestId], kind);
    const expanded = { ...binding }; delete expanded[refKey];
    expanded[dataKey] = grant.recovery; bindings[requestId] = expanded;
  }
  return { version: 1, bindings };
}

/** Prepare immutable grants and a byte-exact legacy backup before atomically
 * replacing the bounded index. A failed write leaves the previous index intact.
 * replaceIndex is the filesystem seam for deterministic rename-failure tests. */
export async function commitCreatorBindingDocument(root: string, value: unknown,
  replaceIndex: (source: string, target: string) => Promise<void> = rename): Promise<void> {
  const next = document(value), bindings = { ...next.bindings }, prepared: { ref: ProductionGrantRef; bytes: string }[] = [];
  for (const [requestId, binding] of Object.entries(next.bindings)) {
    if (Object.hasOwn(binding, "worldDesignRecoveryRef") || Object.hasOwn(binding, "propRecoveryRef")) refuse(); // Hydrated state only.
    if (binding.worldDesignRecovery && binding.recovery) refuse();
    const prop = Object.hasOwn(binding, "recovery"), dataKey = prop ? "recovery" : "worldDesignRecovery",
      refKey = prop ? "propRecoveryRef" : "worldDesignRecoveryRef", kind: GrantKind = prop ? "prop-production-recovery" : "world-design-recovery";
    if (!Object.hasOwn(binding, dataKey)) continue;
    const r = recovery(binding[dataKey], kind), grant: DesignGrant = { version: 1, kind,
      identity: identity(requestId, binding, next.bindings[binding.input?.previousRequestId], r, kind),
      recoveryHash: digest(JSON.stringify(r)), recovery: r };
    const bytes = JSON.stringify(grant); if (Buffer.byteLength(bytes) > limit) refuse();
    const hash = digest(bytes), record = { ...binding }; delete record[dataKey];
    record[refKey] = { grantId: hash, contentHash: hash }; bindings[requestId] = record;
    prepared.push({ ref: record[refKey], bytes });
  }
  const index = JSON.stringify({ version: 1, bindings });
  if (Buffer.byteLength(index) > limit) throw new Error("creator_capacity_exceeded");
  const directory = join(root, ".aura", "veya-creator"), target = join(directory, "bindings.json");
  await mkdir(directory, { recursive: true });
  let previous: Buffer | undefined;
  try { previous = await readFile(target); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  if (previous) {
    if (previous.length > limit) refuse();
    const old = document(JSON.parse(previous.toString("utf8")));
    if (Object.values(old.bindings).some(b => Object.hasOwn(b, "worldDesignRecovery") || Object.hasOwn(b, "recovery"))) {
      const backups = join(directory, "backups"); await mkdir(backups, { recursive: true });
      await writeImmutableDesignFile(join(backups, `bindings-${digest(previous)}.json`), previous);
    }
  }
  if (prepared.length) await mkdir(join(directory, "grants"), { recursive: true });
  for (const item of prepared) await writeImmutableDesignFile(join(directory, "grants", `${item.ref.grantId}.json`), item.bytes);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, index, { mode: 0o600, flag: "wx" }); await replaceIndex(temporary, target); }
  catch (e) { await rm(temporary, { force: true }).catch(() => undefined); throw e; }
}
