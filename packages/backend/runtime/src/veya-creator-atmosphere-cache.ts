import type { FlowRun } from "@aura/protocol/types";
import { expectedAtmosphereSources, materialIdentity } from "@aura/orchestration";

const object = (v: unknown): Record<string, any> | undefined => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : undefined;
const same = (a: unknown, b: unknown) => a !== undefined && b !== undefined && materialIdentity(a) === materialIdentity(b);
const sha = /^[a-f0-9]{64}$/u;
const controls: Record<string, [number, number]> = { cloudAmount: [0, 1], cloudScale: [.25, 8], haze: [0, 1], warmth: [-1, 1], brightness: [-1, 1] };
const presets = new Set(["fantasy_clear", "tropical_bright", "autumn_journey", "desert_haze", "pastel_storybook", "ink_mist", "epic_sunset", "blue_hour", "mystic_fog", "storm_front", "silver_moon", "alien_aurora"]);
function validRequest(v: unknown): v is Record<string, any> {
  const r = object(v);
  return !!r && presets.has(r.presetId) && Number.isInteger(r.seed) && r.seed >= 0 && r.seed <= 10000 && r.source === "procedural" &&
    Object.keys(r).every(k => ["presetId", "seed", "source"].includes(k) || controls[k] &&
      typeof r[k] === "number" && Number.isFinite(r[k]) && r[k] >= controls[k][0] && r[k] <= controls[k][1]);
}

/** A native catalog hit has no Cooker steps: its terminal receipt proves reuse,
 * not a newly executed pipeline. Admit only the guarded, immediately completed
 * Environment operation with the same pre/post native catalog record. The
 * trusted native host owns the variant key; this code never recreates recipes
 * or Godot's float serialization to guess that key. */
export function completedAtmosphereCache(run: FlowRun, step: FlowRun["steps"][number]): boolean {
  if (run.flow.id !== "veya/veya-environment-lighting" || step.kind !== "action" ||
      step.actionId !== "veya/atmosphere-build" || step.status !== "completed") return false;
  const input = object(step.input), done = object(step.output), result = object(run.output);
  if (!input || !done || !result || done.status !== "succeeded" || Object.keys(done).length !== 4 ||
      !["assets", "operation_id", "request_id", "status"].every(k => Object.hasOwn(done, k)) ||
      typeof done.operation_id !== "string" || !/^cook_[a-f0-9]{32}$/u.test(done.operation_id) ||
      typeof done.request_id !== "string" || !/^[A-Za-z0-9_-]{1,96}$/u.test(done.request_id) ||
      !Array.isArray(done.assets) || done.assets.length !== 1) return false;
  const expected = expectedAtmosphereSources(input);
  if (!expected || !Object.hasOwn(input, "expectedSources")) return false;
  const { expectedSources: _guard, ...request } = input;
  const held = object(result.environmentResource), locked = object(object(run.input)?.plan)?.atmosphere;
  const effective = held?.effectiveRequest ?? held?.request;
  if (!validRequest(request) || !held || !validRequest(held.request) || !validRequest(effective) ||
      !same(held.request, locked) || !same(request, effective) ||
      ["presetId", "seed", "source"].some(k => held.request[k] !== effective[k]) ||
      !same(held.atmosphere, result.atmosphere)) return false;
  const asset = object(done.assets[0]), atmosphere = object(asset?.atmosphere), projected = object(held.atmosphere);
  const sun = object(atmosphere?.sun), vec = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every(n => typeof n === "number" && Number.isFinite(n));
  if (!asset || !atmosphere || !projected || asset.type !== "environment" || asset.local_generated !== true ||
      typeof asset.id !== "string" || !/^[A-Za-z0-9_.:-]{1,192}$/u.test(asset.id) || !sha.test(asset.content_hash) ||
      typeof asset.path !== "string" || !/^res:\/\/assets\/generated\/atmosphere\/variants\/[a-f0-9]{32}\/environment\.res$/u.test(asset.path) ||
      atmosphere.preset_id !== request.presetId || atmosphere.shader_sha256 !== expected.shader_sha256 ||
      projected.assetId !== asset.id || projected.path !== asset.path || projected.contentHash !== asset.content_hash ||
      projected.shaderHash !== expected.shader_sha256 || projected.presetId !== request.presetId ||
      projected.seed !== request.seed || projected.cloudSource !== request.source || projected.artifactId !== undefined ||
      !sun || !vec(sun.direction) || !vec(sun.color) || typeof sun.energy !== "number" || !Number.isFinite(sun.energy) || sun.energy < 0 ||
      !same(projected.sun, sun)) return false;
  const index = run.steps.indexOf(step);
  if (index < 0 || run.steps.some(s => s.kind === "action" && ["veya/cooker-status", "veya/operation-status"].includes(s.actionId) &&
      (object(s.input)?.operationId === done.operation_id || object(s.output)?.operation_id === done.operation_id))) return false;
  const before = run.steps.slice(0, index), after = run.steps.slice(index + 1);
  const lastRead = (steps: FlowRun["steps"], actionId: string) => steps.filter(s => s.kind === "action" && s.actionId === actionId).at(-1);
  const priorCatalog = lastRead(before, "veya/asset-list"), caps = lastRead(before, "veya/cooker-capabilities");
  const nextCatalog = after.find(s => s.kind === "action" && s.actionId === "veya/asset-list");
  if (!priorCatalog || priorCatalog.status !== "completed" || !nextCatalog || nextCatalog.status !== "completed" ||
      !caps || caps.status !== "completed" || object(caps.output)?.available !== true ||
      !same(object(caps.output)?.atmosphere_sources, expected)) return false;
  return same(object(priorCatalog.output)?.[asset.id], asset) && same(object(nextCatalog.output)?.[asset.id], asset);
}
