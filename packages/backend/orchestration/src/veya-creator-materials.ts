import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JsonValue } from "@aura/protocol/types";
import { cookerSubmissionFingerprint, productionDigest, type ProductionGrant, type ProductionGrantRef } from "./veya-creator-production-grants.ts";
import { expectedAtmosphereSources, environmentShaderPins, matchesEnvironmentShader } from "./veya-atmosphere-provenance.ts";

export type ProductionMaterials = { schemaVersion: 1; sourceRequestId: string; sourceRunId: string;
  sourceBrief: JsonValue; sourcePlan: JsonValue; sourceGameplaySpec: JsonValue; sourceExhaustedRound: number;
  validation: "unverified"; noNewPaidWork: true; common: JsonValue; props: JsonValue[];
  environmentResource?: { request: JsonValue; effectiveRequest?: JsonValue; lookDescription: string; atmosphere: JsonValue } };
export type MaterialsGrant = { version: 1; identity: ProductionGrant["identity"] & { requestTextHash: string }; materials: ProductionMaterials;
  proof: { assets: ProductionGrant["proof"]["assets"]; modules: ProductionGrant["proof"]["modules"];
    completedOperations: { operation: "veya.cooker.submit" | "veya.atmosphere.build"; operationId: string; fingerprint: string }[] } };
const object = (v: unknown): Record<string, any> | undefined => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : undefined;
const sha = /^[a-f0-9]{64}$/u;
const materialKeys = new Set(["schemaVersion", "sourceRequestId", "sourceRunId", "sourceBrief", "sourcePlan", "sourceGameplaySpec",
  "sourceExhaustedRound", "validation", "noNewPaidWork", "common", "props", "environmentResource"]);
function environmentResourceValid(value: unknown): boolean {
  const held = object(value), request = object(held?.request), effective = object(held?.effectiveRequest ?? held?.request), a = object(held?.atmosphere);
  const controls: Record<string, [number, number]> = { cloudAmount: [0, 1], cloudScale: [.25, 8], haze: [0, 1], warmth: [-1, 1], brightness: [-1, 1] };
  const validRequest = (r: Record<string, any> | undefined): boolean => Boolean(r &&
    ["fantasy_clear", "tropical_bright", "autumn_journey", "desert_haze", "pastel_storybook", "ink_mist", "epic_sunset", "blue_hour", "mystic_fog", "storm_front", "silver_moon", "alien_aurora"].includes(r.presetId) &&
    Number.isInteger(r.seed) && r.seed >= 0 && r.seed <= 10000 && ["procedural", "ai_cloud"].includes(r.source) &&
    Object.keys(r).every(k => ["presetId", "seed", "source"].includes(k) || controls[k] && Number.isFinite(r[k]) && r[k] >= controls[k][0] && r[k] <= controls[k][1]));
  const vec = (v: unknown): boolean => Array.isArray(v) && v.length === 3 && v.every(n => typeof n === "number" && Number.isFinite(n));
  return Boolean(held && Object.keys(held).every(k => ["request", "effectiveRequest", "lookDescription", "atmosphere"].includes(k)) &&
    validRequest(request) && validRequest(effective) && ["presetId", "seed", "source"].every(k => request![k] === effective![k]) &&
    typeof held.lookDescription === "string" && held.lookDescription.length <= 4000 && a &&
    Object.keys(a).every(k => ["assetId", "path", "contentHash", "presetId", "seed", "sun", "cloudSource", "artifactId", "shaderHash"].includes(k)) &&
    (a.shaderHash === undefined || typeof a.shaderHash === "string" && sha.test(a.shaderHash)) &&
    typeof a.assetId === "string" && /^[A-Za-z0-9_.:-]{1,192}$/u.test(a.assetId) && sha.test(a.contentHash) &&
    typeof a.path === "string" && a.path.length <= 1024 && /^res:\/\/(?!.*(?:\\|\.\.))[^\u0000-\u001f]+$/u.test(a.path) &&
    a.presetId === request!.presetId && a.seed === request!.seed && a.cloudSource === request!.source &&
    (a.cloudSource === "ai_cloud" ? sha.test(a.artifactId) : a.artifactId === undefined) &&
    object(a.sun) && Object.keys(a.sun).every(k => ["direction", "color", "energy"].includes(k)) && vec(a.sun.direction) && vec(a.sun.color) && Number.isFinite(a.sun.energy) && a.sun.energy >= 0);
}
export const materialCanonical = (v: unknown): unknown => Array.isArray(v) ? v.map(materialCanonical) : object(v)
  ? Object.fromEntries(Object.keys(object(v)!).sort().map(k => [k, materialCanonical(object(v)![k])])) : v;
export const materialIdentity = (v: unknown): string => productionDigest(materialCanonical(v));
export function materialSubmissionFingerprint(operation: string, value: unknown): string {
  if (operation === "veya.cooker.submit") return cookerSubmissionFingerprint(value);
  const input = object(value);
  if (operation !== "veya.atmosphere.build" || !input) throw new Error("production_materials_invalid");
  // Action camelCase and native snake_case are the same bounded declaration.
  const legacy = [input.presetId ?? input.preset_id, input.seed, input.source,
    input.cloudAmount ?? input.cloud_amount, input.cloudScale ?? input.cloud_scale, input.haze, input.warmth, input.brightness,
    input.cloudAssetId ?? input.cloud_asset_id ?? null];
  const expected = expectedAtmosphereSources(input);
  // Keep historical fingerprints byte-identical. The new bounded identity is
  // checked by the bound native worker before any Cooker operation can start.
  return materialIdentity(expected ? [...legacy, { expected_sources: expected }] : legacy);
}
export function validateMaterialsGrant(value: unknown): MaterialsGrant {
  const g = object(value), m = object(g?.materials), p = object(g?.proof), i = object(g?.identity);
  if (!g || g.version !== 1 || !m || !p || !i || m.schemaVersion !== 1 || m.validation !== "unverified" || m.noNewPaidWork !== true ||
      !/^[a-f0-9-]{36}$/u.test(m.sourceRequestId) || !/^[a-f0-9-]{36}$/u.test(m.sourceRunId) ||
      !Number.isInteger(m.sourceExhaustedRound) || m.sourceExhaustedRound < 0 || m.sourceExhaustedRound > 3 ||
      object(m.sourceBrief)?.operation !== "create_world" || !object(m.sourcePlan) || !object(m.sourceGameplaySpec) ||
      object(m.common)?.status !== "ready" || !Array.isArray(m.props) || !m.props.length || m.props.length > 30 ||
      m.props.some((prop: any) => prop?.status !== "ready" || prop.module?.kind !== "prop" || !sha.test(prop.module?.module_id) ||
        prop.module.content_hash !== prop.module.module_id || !sha.test(prop.specHash) || productionDigest(prop.spec) !== prop.specHash ||
        !sha.test(prop.preparation?.receiptHash)) ||
      Object.keys(m).some(k => !materialKeys.has(k)) ||
      (m.environmentResource !== undefined && !environmentResourceValid(m.environmentResource)) ||
      !sha.test(i.textHash) || !sha.test(i.requestTextHash) || !/^[a-f0-9]{32}$/u.test(i.creationSessionId) ||
      [i.playerId, i.homeWorldId].some(id => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,96}$/u.test(id)) ||
      !Array.isArray(p.assets) || p.assets.length > 256 || p.assets.some((a: any) => typeof a.assetId !== "string" || !/^[A-Za-z0-9_.:-]{1,192}$/u.test(a.assetId) || !sha.test(a.contentHash)) ||
      new Set(p.assets.map((a: any) => a.assetId)).size !== p.assets.length ||
      !Array.isArray(p.modules) || p.modules.length !== m.props.length || p.modules.some((x: any) =>
        !m.props.some((prop: any) => prop.module.module_id === x.moduleId && prop.module.content_hash === x.contentHash)) ||
      !Array.isArray(p.completedOperations) || p.completedOperations.length > 128 || p.completedOperations.some((x: any) =>
        !["veya.cooker.submit", "veya.atmosphere.build"].includes(x.operation) || !/^[A-Za-z0-9_-]{1,96}$/u.test(x.operationId) || !sha.test(x.fingerprint)) ||
      Buffer.byteLength(JSON.stringify(g)) > 256 * 1024 || Buffer.byteLength(JSON.stringify(m)) > 128 * 1024)
    throw new Error("production_materials_invalid");
  return value as MaterialsGrant;
}
export async function writeMaterialsGrant(root: string, grant: MaterialsGrant): Promise<ProductionGrantRef> {
  validateMaterialsGrant(grant); const bytes = JSON.stringify(grant), hash = createHash("sha256").update(bytes).digest("hex");
  const directory = join(root, ".aura", "veya-creator", "materials"); await mkdir(directory, { recursive: true });
  const path = join(directory, hash + ".json");
  try { await writeFile(path, bytes, { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await readFile(path, "utf8") !== bytes) throw error; }
  return { grantId: hash, contentHash: hash };
}
export async function readMaterialsGrant(root: string, ref: ProductionGrantRef): Promise<MaterialsGrant> {
  if (!ref || !sha.test(ref.grantId) || ref.contentHash !== ref.grantId || Object.keys(ref).length !== 2) throw new Error("production_materials_invalid");
  const bytes = await readFile(join(root, ".aura", "veya-creator", "materials", ref.grantId + ".json"));
  if (bytes.length > 256 * 1024 || createHash("sha256").update(bytes).digest("hex") !== ref.contentHash) throw new Error("production_materials_invalid");
  return validateMaterialsGrant(JSON.parse(bytes.toString("utf8")));
}
export function validateMaterialsBinding(grant: MaterialsGrant, binding: any, source: any): void {
  const m = grant.materials;
  if (!source || source.runId !== m.sourceRunId || binding.input?.operation !== "create_world" || source.input?.operation !== "create_world" ||
      binding.input.reuseProductionFromRequestId !== m.sourceRequestId || binding.input.previousRequestId || binding.input.previousArtifactId ||
      binding.input.reuseAssetsFromRequestId || binding.input.target || binding.input.references ||
      binding.recovery || binding.worldDesignRecovery || binding.worldProductionRecoveryRef || binding.assetReuse || binding.previousArtifact ||
      source.productionMaterialsRef || typeof binding.input.text !== "string" ||
      createHash("sha256").update(source.input.text).digest("hex") !== grant.identity.textHash ||
      createHash("sha256").update(binding.input.text).digest("hex") !== grant.identity.requestTextHash ||
      ["playerId", "homeWorldId", "creationSessionId"].some(k => binding[k] !== (grant.identity as any)[k] || source[k] !== binding[k]) ||
      binding.sessionPath !== source.sessionPath || binding.recoveryBudgetCreationId !== (source.recoveryBudgetCreationId ?? m.sourceRequestId))
    throw new Error("production_materials_binding_mismatch");
}
export async function verifyMaterialsWorker(grant: MaterialsGrant, call: (op: string, input: JsonValue) => Promise<JsonValue>): Promise<void> {
  validateMaterialsGrant(grant);
  const reject = (): never => { throw new Error("production_materials_state_changed"); };
  const status = object(await call("veya.world.status", {}));
  if (status?.playtest_id || status?.profile?.home_world_id !== grant.identity.homeWorldId) reject();
  const catalog = object(await call("veya.assets.list", {}));
  for (const p of grant.proof.assets) if (catalog?.[p.assetId]?.content_hash !== p.contentHash) reject();
  for (const p of environmentShaderPins(grant.materials.environmentResource)) if (!matchesEnvironmentShader(p, catalog?.[p.assetId])) reject();
  for (const p of grant.proof.modules) {
    const actual = object(await call("veya.creation.module.read", { module_id: p.moduleId, content_hash: p.contentHash }));
    if (actual?.module_id !== p.moduleId || actual.content_hash !== p.contentHash || actual.kind !== "prop") reject();
    for (const a of actual!.assets ?? []) if (!grant.proof.assets.some(x => x.assetId === a.asset_id && x.contentHash === a.content_hash)) reject();
  }
}
