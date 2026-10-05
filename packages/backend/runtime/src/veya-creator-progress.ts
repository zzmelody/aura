import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { FlowRun, FlowStep } from "@aura/protocol/types";

export type CreationStage = "queued" | "requirements" | "clarification" | "design" | "assets" |
  "reference_images" | "model" | "preparation" | "authoring" | "assembly" | "verification" | "export" | "delivery" | "attention";
export type CreationProgress = {
  schemaVersion: 1; stage: CreationStage; detail: "working" | "geometry" | "interaction" | "visual" | "performance" | "save_resume";
  elapsedSeconds: number; totalSeconds: number; completedStages: CreationStage[];
  repairRound?: number; imagesReady?: number; imagesTotal?: number;
};
const object = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const active = (step: FlowStep) => ["running", "queued", "waiting_input", "paused", "needs_attention"].includes(step.status);
const seconds = (now: number, start: unknown) => typeof start === "number" && Number.isFinite(start)
  ? Math.min(604800, Math.max(0, Math.floor((now - start) / 1000))) : 0;

function stageFor(run: FlowRun, step?: FlowStep): CreationStage {
  const flow = run.flow?.id ?? "", id = step?.id ?? "";
  if (run.status === "waiting_input" || step?.kind === "checkpoint") return "clarification";
  if (["failed", "cancelled", "interrupted", "needs_attention", "paused"].includes(run.status)) return "attention";
  if (/export/u.test(id)) return "export";
  if (/verify/u.test(flow)) return "verification";
  if (flow === "veya/veya-model-generator") return "model";
  if (/assets|effects|atmosphere/u.test(flow)) return "assets";
  if (/prepare/u.test(flow)) return "preparation";
  if (/gameplay-design|world-plan/u.test(flow) || /design|plan/u.test(id)) return "design";
  if (/world-build/u.test(flow) || id === "build" || /^build-/u.test(id)) return "assembly";
  if (/prop-agent|npc-agent|avatar-agent/u.test(flow)) return step?.kind === "agent" ? "authoring" : "preparation";
  if (flow === "veya/veya-wish") return run.status === "queued" ? "queued" : "requirements";
  if (/verify/u.test(id)) return "verification";
  if (/prop-/u.test(id)) return "authoring";
  return "preparation";
}

/** Read-only bounded projection. No provider polling, Flow mutation, or raw diagnostics. */
export async function creatorProgress(root: FlowRun, getRun: (id: string) => Promise<FlowRun>,
  projectRoot: string, creationId = root.requestId, now = Date.now()): Promise<CreationProgress> {
  let current = root, step: FlowStep | undefined;
  const seen = new Set([root.id]), completed = new Set<CreationStage>();
  let repairRound = 0;
  for (let depth = 0; depth < 8; depth++) {
    if (object(object(current.input)?.brief)?.schemaVersion === 1) completed.add("requirements");
    const round = object(current.input)?.repairRound;
    if (typeof round === "number" && Number.isInteger(round) && round >= 0 && round <= 3) repairRound = Math.max(repairRound, round);
    for (const done of current.steps ?? []) {
      if (done.status !== "completed") continue;
      if (done.kind !== "flow" || object(done.output)?.status !== "ready") continue;
      if (/gameplay-design|world-plan/u.test(done.flowId ?? "")) completed.add("design");
      if (/world-assets/u.test(done.flowId ?? "")) completed.add("assets");
      if (/prop-prepare/u.test(done.flowId ?? "")) completed.add("preparation");
      if (/prop-agent/u.test(done.flowId ?? "")) completed.add("authoring");
      if (/world-build/u.test(done.flowId ?? "")) completed.add("assembly");
    }
    if (!["running", "queued", "waiting_input"].includes(current.status)) { step = undefined; break; }
    step = current.steps?.find(active);
    if (step?.kind !== "flow" || !step.childRunId || seen.has(step.childRunId)) break;
    try {
      const child = await getRun(step.childRunId);
      if (child.id !== step.childRunId || child.parent?.runId !== current.id) break;
      seen.add(child.id); current = child;
    } catch { break; } // An unavailable child must not hide existing task status.
  }
  const stage = stageFor(current, step);
  const id = (current.flow?.id ?? "") + " " + (step?.id ?? "");
  const detail: CreationProgress["detail"] = stage !== "verification" ? "working" :
    /save|resume/u.test(id) ? "save_resume" : /performance/u.test(id) ? "performance" :
    /vision|visual/u.test(id) ? "visual" : /geometry/u.test(id) ? "geometry" : /interaction|stage-/u.test(id) ? "interaction" : "working";
  const ordered: CreationStage[] = ["requirements", "design", "assets", "preparation", "authoring", "assembly"];
  const result: CreationProgress = { schemaVersion: 1, stage, detail,
    elapsedSeconds: seconds(now, step?.startedAt ?? current.createdAt), totalSeconds: seconds(now, root.createdAt),
    completedStages: ordered.filter(item => completed.has(item)), ...(repairRound ? { repairRound } : {}) };
  if (current.flow?.id !== "veya/veya-model-generator" || !step || !active(step)) return result;
  try {
    const path = join(projectRoot, ".aura", "world-agent-paid.json");
    if ((await stat(path)).size > 4 * 1024 * 1024) return result;
    const ledger = object(JSON.parse(await readFile(path, "utf8")));
    const requests = object(ledger?.requests);
    const key = object(step.kind === "action" ? step.input : undefined)?.generationKey;
    if (ledger?.schemaVersion !== 1 || !requests || typeof key !== "string" || !/^[a-f0-9]{64}$/u.test(key)) return result;
    const request = object(requests[`${creationId}:${key}`]);
    if (request?.creationId !== creationId) return result;
    const stages = object(request.stages);
    const views = ["front", "left", "back", "right"];
    const ready = views.filter(view => object(stages?.[view])?.status === "completed").length;
    const model = object(stages?.model);
    result.stage = model ? "model" : "reference_images";
    result.imagesReady = ready; result.imagesTotal = 4;
  } catch { /* Missing/in-flight ledger is not a failed creation. */ }
  return result;
}
