import type { FlowRun } from "@aura/protocol/types";

export type PerformanceNotice = { kind: "baseline_entered" | "performance_running" | "performance_missed";
  rootRunId: string; runId: string; candidateHash: string; baseline: string;
  stepKey?: string; startedAt?: number; finishedAt?: number };

/** Poll only active durable branches. This never invokes Veya or a Flow Action. */
export async function activePerformance(root: FlowRun, get: (id: string) => Promise<FlowRun>): Promise<PerformanceNotice[]> {
  const notices: PerformanceNotice[] = [], visited = new Set<string>();
  const visit = async (run: FlowRun, depth: number): Promise<void> => {
    if (depth > 8 || visited.size >= 64 || visited.has(run.id)) throw new Error("Invalid active Run tree");
    visited.add(run.id);
    if (run.flow.id === "veya/veya-verify-baseline") {
      const input = run.input as any, candidateHash = input?.candidate?.contentHash;
      if (!/^[a-f0-9]{64}$/u.test(candidateHash) || !["authored", "saved"].includes(input.baseline)) throw new Error("Invalid baseline identity");
      const common = { rootRunId: root.id, runId: run.id, candidateHash, baseline: input.baseline };
      notices.push({ kind: "baseline_entered", ...common });
      const steps = run.steps.filter(step => step.kind === "action" && step.actionId === "veya/world-performance");
      if (steps.length > 1) throw new Error("Ambiguous performance step");
      for (const step of steps) if (step.kind === "action" && ["running", "completed"].includes(step.status)) {
        if ((step.input as any)?.candidateHash !== candidateHash || !Number.isFinite(step.startedAt) || !step.stepKey)
          throw new Error("Performance step differs from its baseline");
        notices.push({ kind: step.status === "running" ? "performance_running" : "performance_missed", ...common,
          stepKey: step.stepKey, startedAt: step.startedAt, ...(step.finishedAt === undefined ? {} : { finishedAt: step.finishedAt }) });
      }
    }
    for (const step of run.steps) if (step.kind === "flow" && step.status === "running" && step.childRunId) {
      const child = await get(step.childRunId);
      if (child.id !== step.childRunId || child.parent?.runId !== run.id || child.parent.stepKey !== step.stepKey)
        throw new Error("Broken active Run ancestry");
      await visit(child, depth + 1);
    }
  };
  await visit(root, 0);
  return notices;
}
