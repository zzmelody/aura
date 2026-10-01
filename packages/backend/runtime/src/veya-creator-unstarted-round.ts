import type { FlowRun, JsonValue } from "@aura/protocol/types";
import { productionDigest, type ProductionGrant } from "@aura/orchestration";

const object = (v: unknown): Record<string, any> | undefined => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : undefined;
const exact = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
// Known released code which routed an author rejection to visual Lookdev
// before starting any repair. A later version cannot borrow this exception.
export const UNSTARTED_BUILD_HASH = "721687b4a524cc9890b88bd2aa91576d1bb9771d54989f95271284b735dae0a2";
export const UNSTARTED_ENV_HASH = "fb51cd3fdc362fd438b232aa9227ec101d0ee3223d0a59df7719e106abe8962a";
const missingCandidate = "Candidate-bound visual evidence is required for lighting repair.";

/** Reconstruct only the proven boundary after build-2. The terminal resume and
 * all Run records remain unchanged. This is not a general round rollback. */
export function recoverUnstartedFinalRound(root: FlowRun, world: FlowRun, runs: FlowRun[], prior?: ProductionGrant):
  { resume: Record<string, any>; completedBuild: FlowRun; boundary: NonNullable<ProductionGrant["proof"]["pendingRound"]> } | undefined {
  const terminal = object(object(world.output)?.resume);
  if (terminal?.round !== 3) return undefined;
  function refuse(): never { throw new Error("world_production_recovery_unavailable"); }
  const clean = (r: FlowRun) => r.status === "completed" && !r.commands?.length && !r.recoveryEvents?.length;
  const steps = (r: FlowRun, expected: [string, string][]) => clean(r) && r.steps.length === expected.length && r.steps.every((s, i) =>
    s.status === "completed" && s.kind === "action" && s.id === expected[i]![0] &&
    s.stepKey === "plugin/main/" + s.id && s.actionId === expected[i]![1]);
  const builds = runs.filter(r => r.parent?.runId === world.id && r.flow.id === "veya/veya-world-build");
  if (!prior || prior.proof.pendingRound || prior.recovery.nextRound !== 2 || builds.length !== 2 ||
      !clean(root) || !clean(world) || root.steps.length !== 2 || world.steps.length !== 6) refuse();
  const [completed, blocked] = builds as [FlowRun, FlowRun];
  if (root.steps[0]?.kind !== "action" || root.steps[0].actionId !== "veya/creator-context" ||
      root.steps[1]?.kind !== "flow" || root.steps[1].childRunId !== world.id ||
      !steps({ ...world, steps: world.steps.slice(0, 4) }, [["creator-context", "veya/creator-context"], ["worlds", "veya/world-list"],
        ["enter", "veya/travel-enter"], ["enter-wait-0", "veya/operation-status"]]) ||
      world.steps[4]?.kind !== "flow" || world.steps[4].childRunId !== completed.id ||
      world.steps[5]?.kind !== "flow" || world.steps[5].childRunId !== blocked.id) refuse();
  const ci = object(completed.input)!, co = object(completed.output)!, bi = object(blocked.input)!;
  if (completed.parent?.stepKey !== "plugin/main/build-2" || blocked.parent?.stepKey !== "plugin/main/build-3" ||
      completed.flow.sourceHash !== UNSTARTED_BUILD_HASH || blocked.flow.sourceHash !== UNSTARTED_BUILD_HASH ||
      !clean(completed) || !clean(blocked) || ci.repairRound !== 2 || bi.repairRound !== 3 || co.status !== "blocked" || co.candidate ||
      !exact(bi.previous, co) || !exact(terminal.build, blocked.output) ||
      !exact(ci.gameplaySpec, terminal.gameplay?.spec) || !exact(bi.gameplaySpec, terminal.gameplay?.spec) ||
      ci.gameplaySpecHash !== terminal.gameplay?.specHash || bi.gameplaySpecHash !== terminal.gameplay?.specHash ||
      !exact(terminal.verification, bi.verification) || !exact(bi.verification, { defects: co.defects }) ||
      !exact(bi.defects, co.defects)) refuse();
  // All immutable inputs are carried across the transition; only the previous
  // result, observed defects and existing round counter may differ.
  for (const key of new Set([...Object.keys(ci), ...Object.keys(bi)]))
    if (!["previous", "verification", "defects", "repairRound"].includes(key) && !exact(ci[key], bi[key])) refuse();
  const ref = co.environment?.module;
  if (co.environment?.status !== "ready" || !ref || ref.kind !== "environment" ||
      !co.modules?.some((m: any) => m.namespace === "environment" && exact(m.module, ref))) refuse();
  const diagnostic = { code: "creation_validation_failed", stage: "author", namespace: "environment", module_id: ref.module_id };
  const compose = completed.steps.filter(s => s.kind === "action" && s.actionId === "veya/draft-compose");
  if (compose.length !== 1 || compose[0]!.id !== "compose" || compose[0]!.status !== "failed" ||
      compose[0]!.error !== `Veya creation_validation_failed (HTTP 422). diagnostics=${JSON.stringify([diagnostic])}` ||
      !exact(co.defects, [{ id: "compose-0", severity: "error", owner: "environment",
        description: "Native candidate validation: " + JSON.stringify({ code: diagnostic.code, stage: diagnostic.stage,
          module_id: diagnostic.module_id, namespace: diagnostic.namespace }) }])) refuse();
  const readSteps: [string, string][] = [["appearance-source", "veya/world-read"], ["appearance-catalog", "veya/asset-list"],
    ["draft-budget", "veya/draft-read"], ["asset-budget-catalog", "veya/asset-list"],
    ["layout-exports", "veya/creation-module-read"], ["retained-environment-exports", "veya/creation-module-read"]];
  const last = blocked.steps.at(-1);
  if (!steps({ ...blocked, steps: blocked.steps.slice(0, -1) }, readSteps) || last?.kind !== "flow" ||
      last.id !== "environment" || last.stepKey !== "plugin/main/environment" || last.status !== "completed") refuse();
  const children = runs.filter(r => r.parent?.runId === blocked.id), env = children[0];
  if (children.length !== 1 || !env || env.id !== last.childRunId || env.flow.id !== "veya/veya-environment-lighting" ||
      env.flow.sourceHash !== UNSTARTED_ENV_HASH || env.parent?.stepKey !== last.stepKey ||
      runs.some(r => r.parent?.runId === env.id) || !steps(env, [["layout-source", "veya/creation-module-read"],
        ["layout-catalog", "veya/asset-list"], ["implementation-sources", "veya/cooker-capabilities"]])) refuse();
  const ei = object(env.input)!, eo = object(env.output)!, bo = object(blocked.output)!;
  if (ei.repairRound !== 3 || !exact(ei.previous, co.environment) || !exact(ei.verification, bi.verification) ||
      ei.generationScope !== terminal.generationScope || eo.status !== "blocked" ||
      !exact(eo.issues, [{ code: "lookdev_blocked", detail: missingCandidate }]) || !exact(eo.questions, []) ||
      !exact(eo.retained, [ref]) || Object.keys(eo).some(k => !["status", "issues", "questions", "retained", "costs",
        "environmentResource", "oldResource", "implementationUpgrade"].includes(k)) ||
      ["costs", "environmentResource", "oldResource", "implementationUpgrade"].some(k => !exact(eo[k], co.environment[k])) ||
      bo.status !== "blocked" || !exact(bo.environment, eo) || !exact(bo.issues, [missingCandidate]) ||
      !exact(bo.questions, []) || !exact(bo.defects, []) || bo.candidate ||
      !exact(bo.modules, co.modules.filter((m: any) => m.namespace === "scene" || m.module?.kind === "prop")) ||
      ["assets", "props", "effects", "allowedChanges", "entityBindings"].some(k => !exact(bo[k], co[k]))) refuse();
  const resume = { ...terminal, build: co, round: 2 };
  return { resume, completedBuild: completed, boundary: { schemaVersion: 1, round: 3, worldRunId: world.id,
    completedBuildRunId: completed.id, blockedBuildRunId: blocked.id, environmentRunId: env.id,
    finalResumeHash: productionDigest(terminal as JsonValue), completedOutputHash: productionDigest(co),
    blockedInputHash: productionDigest(bi), resolvedSpecHash: productionDigest(co.gameplaySpec) } };
}
