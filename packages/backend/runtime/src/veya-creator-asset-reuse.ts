import { createHash } from "node:crypto";
import type { FlowRun, JsonValue } from "@aura/protocol/types";
import { readAssetReuseGrant, verifyAssetReuseCatalog, type AssetReuseGrant, type AssetReuseItem } from "@aura/orchestration";

const object = (v: unknown): Record<string, any> | undefined => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : undefined;
const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : object(v)
  ? Object.fromEntries(Object.keys(object(v)!).sort().map(k => [k, canonical(object(v)![k])])) : v;
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v), "utf8").digest("hex");
const reads = new Set(["veya/creator-context", "veya/system-context", "veya/world-list", "veya/world-status", "veya/world-read", "veya/asset-list", "veya/cooker-capabilities"]);
const actions = new Set([...reads, "veya/world-copy", "veya/travel-enter", "veya/draft-create", "veya/draft-read", "veya/operation-status", "veya/cooker-submit", "veya/cooker-status"]);
const flows = new Set(["veya/veya-wish", "veya/veya-world-agent", "veya/veya-world-plan", "veya/veya-world-gameplay-design",
  "veya/veya-world-build", "veya/veya-world-assets", "veya/veya-procedural-asset", "veya/veya-prop-agent", "veya/veya-prop-prepare"]);

/** Reuse only completed common static work, never a rejected world or a Run continuation. */
export async function retainedCommonAssets(root: FlowRun, sourceRequestId: string, get: (id: string) => Promise<FlowRun>): Promise<AssetReuseGrant> {
  function refuse(): never { throw new Error("asset_reuse_unavailable"); }
  if (root.flow.id !== "veya/veya-wish" || root.requestId !== sourceRequestId || root.status !== "completed" ||
      object(root.input)?.operation !== "create_world" || object(root.output)?.status !== "blocked" ||
      ["previousRequestId", "previousArtifactId", "reuseAssetsFromRequestId"].some(k => object(root.input)?.[k] !== undefined)) refuse();
  const runs: FlowRun[] = [];
  async function visit(run: FlowRun, depth: number) {
    if (depth > 8 || runs.length >= 64 || runs.some(r => r.id === run.id) || run.status !== "completed" || !flows.has(run.flow.id)) refuse();
    runs.push(run);
    const checkCosts = (v: JsonValue | undefined): void => {
      if (Array.isArray(v)) { for (const child of v) checkCosts(child); }
      else if (object(v)) {
        if (object(v)?.costs?.status === "unknown") refuse();
        for (const child of Object.values(object(v)!)) checkCosts(child as JsonValue);
      }
    };
    checkCosts(run.output);
    for (const step of run.steps) {
      if (step.status !== "completed") refuse();
      if (step.kind === "agent") {
        if (!Array.isArray(step.actions) || step.actions.some(a => !reads.has(a.id) || !/^[a-f0-9]{64}$/u.test(a.sourceHash))) refuse();
      } else if (step.kind === "action") {
        if (!actions.has(step.actionId)) refuse();
        const out = object(step.output);
        if (out?.operation_id && ["queued", "running"].includes(out.status)) {
          const ended = run.steps.filter(s => s.kind === "action" && ["veya/cooker-status", "veya/operation-status"].includes(s.actionId) &&
            object(s.input)?.operationId === out.operation_id && object(s.output)?.operation_id === out.operation_id && object(s.output)?.status === "succeeded");
          if (ended.length !== 1) refuse();
        }
        if (["veya/cooker-status", "veya/operation-status"].includes(step.actionId) && out?.status !== "succeeded") refuse();
      } else if (step.kind === "flow") {
        if (!step.childRunId) refuse();
        const child = await get(step.childRunId);
        if (child.id !== step.childRunId || child.parent?.runId !== run.id || child.parent.stepKey !== step.stepKey) refuse();
        await visit(child, depth + 1);
      } else refuse();
    }
  }
  await visit(root, 0);
  const one = (values: FlowRun[]) => { if (values.length !== 1) refuse(); return values[0]!; };
  const world = one(runs.filter(r => r.flow.id === "veya/veya-world-agent" && r.parent?.runId === root.id));
  const build = one(runs.filter(r => r.flow.id === "veya/veya-world-build" && r.parent?.runId === world.id));
  const assets = one(runs.filter(r => r.flow.id === "veya/veya-world-assets" && r.parent?.runId === build.id &&
    build.steps.some(s => s.kind === "flow" && s.id === "world-assets" && s.childRunId === r.id)));
  const input = object(assets.input), result = object(assets.output), buildInput = object(build.input), buildOutput = object(build.output);
  if (!input || !result || result.status !== "ready" || result.schemaVersion !== 2 || input.previous || input.defects?.length ||
      !Array.isArray(input.requirements) || !Array.isArray(result.bindings) || result.costs?.status !== "not_incurred" ||
      result.costs.credits !== 0 || result.costs.records?.length || result.issues?.length || result.retainedArtifacts?.length ||
      !same(buildOutput?.assets, result) || buildInput?.repairRound !== 0) refuse();
  const items: AssetReuseItem[] = [];
  for (const requirement of input.requirements) {
    if (requirement.kind !== "procedural") continue;
    if (buildInput?.gameplaySpec?.props?.some((p: any) => p.assets?.some((r: any) => r.id === requirement.id))) refuse();
    for (const list of [buildInput?.plan?.assets, buildInput?.gameplaySpec?.assets]) {
      const matches = list?.filter((r: any) => r.id === requirement.id);
      if (!Array.isArray(matches) || matches.length !== 1 || !same(matches[0], requirement)) refuse();
    }
    const producer = one(runs.filter(r => r.flow.id === "veya/veya-procedural-asset" && r.parent?.runId === assets.id &&
      object(r.input)?.requirementId === requirement.id));
    const produced = object(producer.output), pi = object(producer.input);
    if (!produced || !pi || produced.status !== "ready" || produced.schemaVersion !== 1 || pi.description !== requirement.description || pi.revisionHint !== "") refuse();
    const submits = producer.steps.filter(s => s.kind === "action" && s.actionId === "veya/cooker-submit");
    const waits = producer.steps.filter(s => s.kind === "action" && s.actionId === "veya/cooker-status");
    if (submits.length !== 1 || waits.length !== 1) refuse();
    const submit = submits[0]!, wait = waits[0]!;
    if (submit.kind !== "action" || wait.kind !== "action") refuse();
    const submitted = object(submit.output), submission = object(submit.input), completed = object(wait.output);
    if (!submitted || submitted.operation_id !== produced.operationId || completed?.operation_id !== produced.operationId ||
        object(wait.input)?.operationId !== produced.operationId || completed?.status !== "succeeded" || completed.cooker?.ok !== true ||
        !Array.isArray(completed.cooker.steps) || completed.cooker.steps.length !== 10 || completed.cooker.steps.some((s: any) => s.ok !== true || s.error !== 0) ||
        !Array.isArray(submission?.sources) || submission.sources.length !== 2 || !Array.isArray(completed.assets)) refuse();
    const mesh = submission.sources.find((s: any) => s.path === "content/scripts/cooker/agent_generated/mesh.luau")?.source;
    const scene = submission.sources.find((s: any) => s.path === "content/scripts/cooker/agent_generated/scene.luau")?.source;
    if (typeof mesh !== "string" || typeof scene !== "string" ||
        digest([digest([requirement.id, requirement.description, "", "procedural-v1"]), mesh, scene]) !== produced.sourceHash) refuse();
    const binding = { requirementId: requirement.id, assetId: produced.visual?.assetId, version: produced.visual?.version,
      collisionAssetId: produced.collision?.assetId, collisionVersion: produced.collision?.version,
      navigationAssetId: produced.navigation?.assetId, navigationVersion: produced.navigation?.version, source: "procedural" as const };
    const held = result.bindings.filter((b: any) => b.requirementId === requirement.id);
    if (held.length !== 1 || !same(held[0], binding)) refuse();
    const item = { requirement, binding, producer: { runId: producer.id, operationId: produced.operationId, sourceHash: produced.sourceHash } };
    const grant = readAssetReuseGrant({ schemaVersion: 1, sourceRequestId, sourceRunId: root.id, items: [item] });
    verifyAssetReuseCatalog(grant, Object.fromEntries(completed.assets.map((a: any) => [a.id, a])));
    items.push(grant.items[0]!);
  }
  return readAssetReuseGrant({ schemaVersion: 1, sourceRequestId, sourceRunId: root.id, items });
}

/** The syntax-recovery admission has already proved this complete read-only tree.
 * Reconcile its two trusted context receipts and locked Plan with the producer
 * proof re-read by the service; no model output can add a grant. */
export async function inheritedDesignAssets(root: FlowRun, plan: unknown, value: unknown, get: (id: string) => Promise<FlowRun>, firstOnly = false): Promise<AssetReuseGrant> {
  const grant = readAssetReuseGrant(value);
  const refuse = (): never => { throw new Error("asset_reuse_unavailable"); };
  const rootContext = root.steps.find(s => s.kind === "action" && s.actionId === "veya/creator-context");
  const prior = object(object(rootContext?.output)?.worldDesignRecovery);
  if (prior) {
    if (firstOnly || prior.formatCorrectionUsed !== false || prior.retainedSpec || prior.semanticRevisionUsed || prior.reviewRetryUsed ||
        object(root.input)?.reuseAssetsFromRequestId || object(root.input)?.previousRequestId !== prior.sourceRequestId ||
        !same(prior.plan, plan) || typeof prior.sourceRunId !== "string") refuse();
    const original = await get(prior.sourceRunId as string);
    if (original.requestId !== prior.sourceRequestId) refuse();
    await inheritedDesignAssets(original, plan, grant, get, true);
  } else if (object(root.input)?.reuseAssetsFromRequestId !== grant.sourceRequestId || object(root.input)?.previousRequestId) refuse();
  const child = root.steps.find(s => s.kind === "flow" && s.id === "world");
  const childId = child?.kind === "flow" ? child.childRunId : undefined;
  if (!childId) throw new Error("asset_reuse_unavailable");
  const world = await get(childId);
  const worldContext = world.steps.find(s => s.kind === "action" && s.actionId === "veya/creator-context");
  for (const context of [rootContext, worldContext]) if (!context ||
      !same(object(context.output)?.assetReuse, grant) || !same(object(context.output)?.worldDesignRecovery, prior) || object(context.output)?.recovery) refuse();
  const requirements = object(plan)?.assets;
  if (!Array.isArray(requirements)) refuse();
  for (const item of grant.items) {
    const matched = requirements.filter((r: unknown) => object(r)?.id === item.requirement.id);
    if (matched.length !== 1 || !same(matched[0], item.requirement)) refuse();
  }
  return grant;
}
