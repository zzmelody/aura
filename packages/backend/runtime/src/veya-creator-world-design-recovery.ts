import { createHash } from "node:crypto";
import type { FlowRun, JsonValue } from "@aura/protocol/types";
import { verifyDesignFormatProof } from "./veya-creator-format-proof.ts";

export type WorldDesignRecovery = { schemaVersion: 1; sourceRequestId: string; sourceRunId: string;
  brief: JsonValue; plan: JsonValue; designInput: JsonValue; draftText: string; draftHash: string; formatCorrectionUsed: boolean;
  retainedSpec?: JsonValue; specHash?: string; semanticRevisionUsed?: true; reviewRetryUsed?: true };
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : undefined;
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(object(value)!).sort().map(key => [key, canonical(object(value)![key])])) : value;
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const reads = new Set(["veya/creator-context", "veya/system-context", "veya/world-list", "veya/world-status",
  "veya/world-read", "veya/asset-list", "veya/cooker-capabilities"]);

/** Narrow pre-production syntax recovery. The only continuation of a used model
 * correction retains its unchanged bytes and used budget, never a rejected edit. */
export async function retainedWorldDesign(root: FlowRun, sourceRequestId: string,
  get: (id: string) => Promise<FlowRun>, trustedPrior?: WorldDesignRecovery, ancestorDepth = 0): Promise<WorldDesignRecovery> {
  function refuse(): never { throw new Error("previous_request_unavailable"); }
  if (ancestorDepth > 2) refuse();
  if (root.flow.id !== "veya/veya-wish" || root.requestId !== sourceRequestId || root.status !== "completed" ||
      object(root.output)?.status !== "blocked" || object(root.input)?.operation !== "create_world" ||
      object(root.input)?.previousArtifactId) refuse();
  if (trustedPrior ? trustedPrior.reviewRetryUsed || trustedPrior.semanticRevisionUsed || trustedPrior.retainedSpec ||
    typeof trustedPrior.formatCorrectionUsed !== "boolean" || object(root.input)?.previousRequestId !== trustedPrior.sourceRequestId
    : object(root.input)?.previousRequestId) refuse();
  const runs: FlowRun[] = [];
  async function visit(run: FlowRun, depth: number) {
    if (depth > 2 || runs.length >= 4 || runs.some(item => item.id === run.id) || run.status !== "completed") refuse();
    runs.push(run);
    for (const step of run.steps) {
      if (step.status !== "completed") refuse();
      if (step.kind === "action") { if (!reads.has(step.actionId)) refuse(); }
      else if (step.kind === "agent") {
        if (!Array.isArray(step.actions) || step.actions.some(action => !reads.has(action.id) || !/^[a-f0-9]{64}$/u.test(action.sourceHash))) refuse();
      } else if (step.kind === "flow") {
        if (!step.childRunId) refuse();
        const child = await get(step.childRunId);
        if (child.id !== step.childRunId || child.parent?.runId !== run.id || child.parent.stepKey !== step.stepKey) refuse();
        await visit(child, depth + 1);
      } else refuse();
    }
  }
  await visit(root, 0);
  const find = (id: string) => { const matches = runs.filter(run => run.flow.id === id); if (matches.length !== 1) refuse(); return matches[0]!; };
  const world = find("veya/veya-world-agent"), design = find("veya/veya-world-gameplay-design");
  // New world designs read exact native asset types before checking coverage.
  // Older durable trees omit this step; no other extra work is admitted.
  const catalogReads = design.steps.filter(step => step.id === "asset-catalog");
  if (catalogReads.length > 1 || catalogReads.some(step => step.kind !== "action" ||
      step.actionId !== "veya/asset-list" || !same(step.input, {}))) refuse();
  const identityReads = design.steps.filter(step => step.id === "source-entities");
  if (identityReads.length > 1 || identityReads.some(step => {
    const source = object(step.output), ids = source?.authored_entities;
    return step.kind !== "action" || step.actionId !== "veya/world-read" ||
      !same(step.input, { worldId: "creation-template", includeAuthoredEntities: true }) ||
      object(source?.manifest)?.world_id !== "creation-template" || !Number.isSafeInteger(source?.revision) || (source!.revision as number) < 1 ||
      typeof source?.content_hash !== "string" || !/^[a-f0-9]{64}$/u.test(source.content_hash) ||
      !Array.isArray(ids) || !ids.length || ids.length > 512 ||
      ids.some(item => { const entry = object(item); return !entry || Object.keys(entry).length !== 1 ||
        typeof entry.id !== "string" || !/^[A-Za-z0-9_.:-]{1,192}$/u.test(entry.id); }) ||
      new Set(ids.map(item => object(item)!.id)).size !== ids.length;
  })) refuse();
  const designStages = design.steps.filter(step => !["asset-catalog", "source-entities"].includes(step.id));
  if (trustedPrior) {
    const normalizedReview = !trustedPrior.formatCorrectionUsed && designStages.length === 3 &&
      designStages.some(step => step.kind === "agent" && step.id === "revise") &&
      designStages.some(step => step.kind === "agent" && step.id === "review-revision");
    // The prior grant is loaded from the owned binding, never request JSON. Re-read
    // its complete original tree rather than trusting a model-supplied provenance.
    const ancestor = await get(trustedPrior.sourceRunId);
    const ancestorContext = ancestor.steps.find(step => step.kind === "action" && step.actionId === "veya/creator-context");
    const ancestorPrior = object(ancestorContext?.output)?.worldDesignRecovery as WorldDesignRecovery | undefined;
    const original = await retainedWorldDesign(ancestor, trustedPrior.sourceRequestId, get, ancestorPrior, ancestorDepth + 1);
    const rootInput = object(root.input), ancestorInput = object(ancestor.input), worldInput = object(world.input), designInput = object(design.input);
    if (!same(original, trustedPrior) || runs.length !== 3 || root.steps.length !== 2 || world.steps.length !== 2 ||
        designStages.length !== (trustedPrior.formatCorrectionUsed || normalizedReview ? 3 : 2) ||
        world.parent?.runId !== root.id || design.parent?.runId !== world.id || object(world.output)?.status !== "needs_attention" ||
        object(design.output)?.status !== "blocked" || rootInput?.text !== ancestorInput?.text || rootInput?.homeWorldId !== ancestorInput?.homeWorldId ||
        !root.steps.some(step => step.kind === "action" && step.id === "context" && step.actionId === "veya/creator-context") ||
        !root.steps.some(step => step.kind === "flow" && step.id === "world" && step.childRunId === world.id) ||
        !world.steps.some(step => step.kind === "action" && step.id === "creator-context" && step.actionId === "veya/creator-context") ||
        !world.steps.some(step => step.kind === "flow" && step.id === "gameplay-design" && step.childRunId === design.id) ||
        !design.steps.some(step => step.kind === "action" && step.id === "capabilities" && step.actionId === "veya/system-context") ||
        worldInput?.outputMode !== "artifact" || worldInput.prior || worldInput.resume ||
        !same(worldInput.designRecovery, original) || !same(worldInput.brief, original.brief) ||
        worldInput.task !== object(original.designInput)?.task ||
        !same(designInput, { ...object(original.designInput), formatDraft: { text: original.draftText, hash: original.draftHash } })) refuse();
    const contexts = runs.flatMap(run => run.steps.filter(step => step.kind === "action" && step.actionId === "veya/creator-context"));
    if (contexts.length !== 2 || contexts.some(step => { const context = object(step.output); return context?.creationId !== sourceRequestId ||
      context.operation !== "create_world" || context.recovery || !same(context.worldDesignRecovery, original); })) refuse();
    const issues = object(design.output)?.issues;
    if (trustedPrior.formatCorrectionUsed || normalizedReview) {
      const revised = design.steps.find(step => step.kind === "agent" && step.id === "revise"),
        review = design.steps.find(step => step.kind === "agent" && step.id === "review-revision");
      if (!Array.isArray(issues) || !issues.length || issues.some(issue => object(issue)?.code !== "playability_review") ||
          !revised || revised.kind !== "agent" || typeof revised.output !== "string" ||
          !review || review.kind !== "agent" || typeof review.output !== "string" ||
          !Array.isArray(revised.actions) || revised.actions.length || !Array.isArray(review.actions) || review.actions.length) refuse();
      let retained: unknown, reviewResult: unknown;
      try { retained = JSON.parse(revised.output); reviewResult = JSON.parse(review.output); } catch { refuse(); }
      const critical = object(reviewResult)?.criticalIssues;
      if (!object(retained) || !Array.isArray(critical) || !critical.every(item => typeof item === "string") ||
          !same(issues, critical.map(detail => ({ code: "playability_review", detail })))) refuse();
      if (normalizedReview) verifyDesignFormatProof(original.draftText, original.draftHash, retained, object(design.output)?.designRevision);
      const result: WorldDesignRecovery = { ...original, sourceRequestId, sourceRunId: root.id,
        formatCorrectionUsed: true,
        retainedSpec: retained as JsonValue, specHash: createHash("sha256").update(JSON.stringify(retained), "utf8").digest("hex"),
        semanticRevisionUsed: true, reviewRetryUsed: true };
      if (Buffer.byteLength(JSON.stringify(result)) > 240 * 1024) refuse();
      return result;
    }
    const corrected = design.steps.find(step => step.kind === "agent" && step.id === "format-correct");
    if (!Array.isArray(issues) || issues.length !== 1 || object(issues[0])?.code !== "invalid_revision" ||
        !corrected || corrected.kind !== "agent" || corrected.output !== original.draftText ||
        !Array.isArray(corrected.actions) || corrected.actions.length) refuse();
    const result: WorldDesignRecovery = { ...original, sourceRequestId, sourceRunId: root.id, formatCorrectionUsed: true };
    if (Buffer.byteLength(JSON.stringify(result)) > 240 * 1024) refuse();
    return result;
  }
  const planner = find("veya/veya-world-plan");
  if (runs.length !== 4 || world.parent?.runId !== root.id || planner.parent?.runId !== world.id || design.parent?.runId !== world.id ||
      object(world.output)?.status !== "needs_attention" || object(design.output)?.status !== "blocked") refuse();
  // These exact stages precede world-copy/draft/paid production in the real coordinator.
  if (world.steps.length !== 3 || !world.steps.some(step => step.kind === "action" && step.id === "creator-context" && step.actionId === "veya/creator-context") ||
      !world.steps.some(step => step.kind === "flow" && step.id === "plan" && step.childRunId === planner.id) ||
      !world.steps.some(step => step.kind === "flow" && step.id === "gameplay-design" && step.childRunId === design.id) ||
      designStages.length !== 2 || !design.steps.some(step => step.kind === "action" && step.id === "capabilities" && step.actionId === "veya/system-context")) refuse();
  const worldInput = object(world.input), brief = object(worldInput?.brief), plan = object(planner.output), designInput = object(design.input);
  if (worldInput?.outputMode !== "artifact" || worldInput.prior || worldInput.resume || worldInput.designRecovery ||
      brief?.schemaVersion !== 1 || brief.operation !== "create_world" || typeof brief.summary !== "string" ||
      !Array.isArray(brief.constraints) || !Array.isArray(brief.acceptance) ||
      !plan || plan.operation !== "copy" || plan.targetWorldId !== "creation-template" ||
      !Array.isArray(plan.gaps) || plan.gaps.length || !same(object(planner.input)?.brief, brief) || !same(plan.requirements, brief) ||
      designInput?.scope !== "world" || designInput.modular !== true || designInput.previous || designInput.repairProp === true ||
      designInput.task !== worldInput.task) refuse();
  const designPlan = object(designInput.plan), returnHome = object(designPlan?.returnHome);
  if (!designPlan || !same({ ...plan, returnHome }, designPlan) || !same(returnHome,
    { schemaVersion: 1, binding: "personal_home", entityId: "return_home", arrival: "home_return" })) refuse();
  const contexts = runs.flatMap(run => run.steps.filter(step => step.kind === "action" && step.actionId === "veya/creator-context"));
  if (!contexts.length || contexts.some(step => { const context = object(step.output); return context?.creationId !== sourceRequestId ||
    context.operation !== "create_world" || context.recovery || context.worldDesignRecovery; })) refuse();
  const issues = object(design.output)?.issues;
  if (!Array.isArray(issues) || issues.length !== 1 || object(issues[0])?.code !== "invalid_spec") refuse();
  const draft = design.steps.find(step => step.kind === "agent" && step.id === "draft"), text = draft?.output;
  if (!draft || typeof text !== "string" || !text.length || Buffer.byteLength(text) > 128 * 1024) refuse();
  let malformed = false;
  try { JSON.parse(text); } catch (error) { malformed = error instanceof SyntaxError; }
  if (!malformed) refuse(); // Valid JSON rejected by schema is a different recovery boundary.
  const result: WorldDesignRecovery = { schemaVersion: 1, sourceRequestId, sourceRunId: root.id,
    brief: brief as JsonValue, plan: plan as JsonValue, designInput: designInput as JsonValue,
    draftText: text, draftHash: createHash("sha256").update(text, "utf8").digest("hex"), formatCorrectionUsed: false };
  // Leave room for the sanitized creator identity, worker capabilities and budget.
  if (Buffer.byteLength(JSON.stringify(result)) > 240 * 1024) refuse();
  return result;
}
