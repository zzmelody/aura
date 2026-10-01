import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { FlowRun } from "@aura/protocol/types";
import { completedAtmosphereCache } from "../src/veya-creator-atmosphere-cache.ts";

const actual = JSON.parse(await readFile(new URL("./fixtures/atmosphere-cache-0c0.json", import.meta.url), "utf8"));
function fixture() {
  const run = structuredClone(actual), step = run.steps.find((s: any) => s.actionId === "veya/atmosphere-build");
  const asset = step.output.assets[0], before = run.steps[0].output, after = run.steps.at(-1).output;
  return { run, step, asset, before, after, caps: run.steps[1].output, held: run.output.environmentResource,
    admit: () => completedAtmosphereCache(run as FlowRun, step) };
}
test("actual native cache receipt is completed without invented Cooker execution", () => {
  const f = fixture(), before = JSON.stringify(f.run);
  assert.equal(f.admit(), true);
  assert.equal("cooker" in f.step.output, false);
  assert.equal(f.asset.content_hash, "999902be30ae03861db744f64318e51532afad291e4fb14b4b96fabdab2a4e8f");
  assert.equal(JSON.stringify(f.run), before);
});
test("cache proof requires exact native source identity and an already registered identical variant", () => {
  const changes: Record<string, (f: ReturnType<typeof fixture>) => void> = {
    "missing pre-catalog": f => { f.before[f.asset.id] = undefined; },
    "missing post-catalog": f => { f.after[f.asset.id] = undefined; },
    "changed before hash": f => { f.before[f.asset.id].content_hash = "a".repeat(64); },
    "changed after path": f => { f.after[f.asset.id].path += "/different"; },
    "catalog type": f => { f.before[f.asset.id].type = "model"; },
    "shader mismatch": f => { f.asset.atmosphere.shader_sha256 = "a".repeat(64); },
    "recipe mismatch": f => { f.caps.atmosphere_sources.recipe_sha256 = "a".repeat(64); },
    "template mismatch": f => { f.caps.atmosphere_sources.template_sha256 = "a".repeat(64); },
    "missing capabilities": f => { delete f.caps.atmosphere_sources; },
    "unknown capability source field": f => { f.caps.atmosphere_sources.invented = true; },
    "missing request source guard": f => { delete f.step.input.expectedSources; },
    "invalid native source": f => { f.asset.local_generated = false; },
    "outside variant path": f => { f.asset.path = "res://assets/environment.res"; },
  };
  for (const [name, mutate] of Object.entries(changes)) { const f = fixture(); mutate(f); assert.equal(f.admit(), false, name); }
});
test("cache proof rejects changed effective controls, missing params, cloud work and model-only claims", () => {
  const changes: Record<string, (f: ReturnType<typeof fixture>) => void> = {
    "changed controls": f => { f.step.input.cloudAmount = .5; },
    "omitted control differs from explicit": f => { delete f.step.input.cloudAmount; },
    "unknown input": f => { f.step.input.pipelineSource = "return {}"; },
    "seed mismatch": f => { f.held.atmosphere.seed++; },
    "locked request mismatch": f => { f.held.request.seed++; },
    "request not native bounded": f => { f.step.input.cloudScale = 100; },
    "effective identity change": f => { f.held.effectiveRequest = { ...f.step.input, seed: 2 }; delete f.held.effectiveRequest.expectedSources; },
    "cloud generation": f => { f.step.input.source = "ai_cloud"; },
    "resource fabricated": f => { f.held.atmosphere.contentHash = "b".repeat(64); },
    "sun fabricated": f => { f.held.atmosphere.sun.energy = 2; },
    "no completed environment metadata": f => { delete f.run.output.environmentResource; },
  };
  for (const [name, mutate] of Object.entries(changes)) { const f = fixture(); mutate(f); assert.equal(f.admit(), false, name); }
  const f = fixture(); f.held.effectiveRequest = structuredClone(f.held.request);
  assert.equal(f.admit(), true, "identical explicit effective request retains exact parameter presence");
});
test("only the immediate terminal receipt qualifies, never queued/unknown/waited or fabricated steps", () => {
  for (const status of ["queued", "running", "unknown", "failed", "cancelled"]) {
    const f = fixture(); f.step.output.status = status; assert.equal(f.admit(), false, status);
  }
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.step.output.cooker = { ok: true, steps: [{ ok: true, error: 0 }] }; },
    (f: ReturnType<typeof fixture>) => { f.step.output.steps = [{ ok: true, error: 0 }]; },
    (f: ReturnType<typeof fixture>) => { f.step.output.assets.push(structuredClone(f.asset)); },
    (f: ReturnType<typeof fixture>) => { delete f.step.output.operation_id; },
    (f: ReturnType<typeof fixture>) => { f.run.steps.push({ kind: "action", actionId: "veya/cooker-status", input: { operationId: f.step.output.operation_id } }); },
    (f: ReturnType<typeof fixture>) => { f.run.flow.id = "veya/veya-prop-prepare"; },
    (f: ReturnType<typeof fixture>) => { f.step.status = "failed"; },
  ]) { const f = fixture(); mutate(f); assert.equal(f.admit(), false); }
});
