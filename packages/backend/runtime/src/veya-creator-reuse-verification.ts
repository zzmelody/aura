import type { FlowRun } from "@aura/protocol/types";

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Admit only a finished isolated verification subtree of the retained module.
 * This grants no worker access and does not mark failed content as verified. */
export function reusedVerificationRuns(runs: FlowRun[], module: Record<string, unknown>): Set<string> {
  const admitted = new Set<string>();
  function refuse(): never { throw new Error("previous_request_unavailable"); }
  const flows = new Set(["veya/veya-world-verify", "veya/veya-verify-baseline", "veya/veya-verify-interaction", "veya/veya-verify-visual"]);
  const reads = new Set(["veya/world-status", "veya/runtime-observe", "veya/runtime-inspect", "veya/character-inspect"]);
  const actions = new Set([...reads, "veya/world-validate", "veya/world-read", "veya/operation-status", "veya/playtest-begin",
    "veya/playtest-end", "veya/playtest-save-resume", "veya/world-preview", "veya/world-performance", "veya/action-perform", "veya/dialogue-choose"]);
  const agents = new Set([...reads, "veya/character-navigate"]);
  for (const verify of runs.filter(run => run.flow.id === "veya/veya-world-verify")) {
    const input = object(verify.input), candidate = object(input?.candidate);
    if (!candidate || typeof candidate.contentHash !== "string" || !/^[a-f0-9]{64}$/u.test(candidate.contentHash) ||
        object(verify.output)?.contentHash !== candidate.contentHash) refuse();
    const build = runs.find(run => run.flow.id === "veya/veya-world-build" && run.status === "completed" &&
      run.parent?.runId === verify.parent?.runId && equal(object(run.output)?.candidate, candidate));
    const composed = build?.steps.filter(step => step.kind === "action").find(step => step.actionId === "veya/draft-compose" && step.status === "completed" &&
      object(step.output)?.content_hash === candidate.contentHash && object(step.output)?.draft_id === candidate.draftId &&
      object(step.output)?.draft_revision === candidate.draftRevision && object(step.output)?.world_id === candidate.worldId);
    const refs = object(composed?.input)?.modules;
    if (!build || !composed || !Array.isArray(refs) || refs.length !== 1 || object(refs[0])?.module_id !== module.module_id ||
        object(refs[0])?.content_hash !== module.content_hash || !equal(object(build.output)?.gameplaySpec, input?.gameplaySpec)) refuse();
    const subtree = (run: FlowRun): FlowRun[] => [run, ...runs.filter(child => child.parent?.runId === run.id).flatMap(subtree)];
    const descendants = subtree(verify), baselines = descendants.filter(run => run.flow.id === "veya/veya-verify-baseline");
    if (!baselines.length) refuse();
    const testIds = new Set<string>();
    const terminal = (run: FlowRun, id: string): Record<string, unknown> | undefined => {
      const step = run.steps.find(step => step.kind === "action" && step.id === id && step.status === "completed");
      const value = object(step?.output);
      if (typeof value?.operation_id !== "string") return value;
      const wait = run.steps.find(next => next.kind === "action" && next.actionId === "veya/operation-status" && next.status === "completed" &&
        object(next.input)?.operationId === value.operation_id && object(next.output)?.operation_id === value.operation_id &&
        object(next.output)?.status === "succeeded");
      const result = object(object(wait?.output)?.result);
      return result?.ok === true ? object(result.data) : undefined;
    };
    for (const baseline of baselines) {
      if (!equal(object(baseline.input)?.candidate, candidate)) refuse();
      const begin = baseline.steps.filter(step => step.kind === "action").find(step => step.id === "begin" && step.actionId === "veya/playtest-begin");
      const started = terminal(baseline, "begin"), end = baseline.steps.filter(step => step.kind === "action").find(step => step.id === "end" && step.actionId === "veya/playtest-end");
      if (object(begin?.input)?.draftId !== candidate.draftId || object(begin?.input)?.candidateHash !== candidate.contentHash ||
          started?.candidate_hash !== candidate.contentHash || typeof started.playtest_id !== "string" ||
          !started.playtest_id.startsWith("test_") || started.world_id !== started.playtest_id ||
          object(end?.input)?.playtestId !== started.playtest_id || terminal(baseline, "end")?.playtest !== false) refuse();
      testIds.add(started.playtest_id as string);
    }
    for (const run of descendants) {
      if (!flows.has(run.flow.id) || run.status !== "completed") refuse();
      for (const step of run.steps) {
        if (step.status !== "completed") refuse();
        if (step.kind === "flow") { if (!step.childRunId || !descendants.some(child => child.id === step.childRunId)) refuse(); continue; }
        if (step.kind === "agent") {
          if (!Array.isArray(step.actions) || step.actions.some(action => !agents.has(action.id))) refuse();
          continue;
        }
        if (step.kind !== "action" || !actions.has(step.actionId)) refuse();
        const args = object(step.input), value = object(step.output);
        if (args?.candidateHash !== undefined && args.candidateHash !== candidate.contentHash) refuse();
        if (args?.candidateId !== undefined && args.candidateId !== candidate.draftId) refuse();
        if (args?.draftId !== undefined && args.draftId !== candidate.draftId) refuse();
        if (args?.playtestId !== undefined && !testIds.has(String(args.playtestId))) refuse();
        if (args?.worldId !== undefined && !(testIds.has(String(args.worldId)) ||
            run.id === verify.id && ["veya/world-read", "veya/world-validate"].includes(step.actionId) && args.worldId === candidate.worldId)) refuse();
        if (typeof value?.operation_id === "string" && !["succeeded", "failed", "cancelled"].includes(String(value.status)) &&
            !descendants.some(child => child.steps.some(done => done.kind === "action" && done.actionId === "veya/operation-status" &&
              done.status === "completed" && object(done.input)?.operationId === value.operation_id && object(done.output)?.operation_id === value.operation_id &&
              ["succeeded", "failed", "cancelled"].includes(String(object(done.output)?.status))))) refuse();
      }
      admitted.add(run.id);
    }
  }
  return admitted;
}
