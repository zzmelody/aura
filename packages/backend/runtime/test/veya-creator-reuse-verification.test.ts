import assert from "node:assert/strict";
import test from "node:test";
import type { FlowRun } from "@aura/protocol/types";
import { reusedVerificationRuns } from "../src/veya-creator-reuse-verification.ts";

// Earlier recovery tests only exercised rejected composition. A retained module
// can now reach native playtest without a PropAgent child in this linked Run.
test("retained module recovery admits only its completed isolated verification subtree", () => {
  const module = { module_id: "a".repeat(64), content_hash: "a".repeat(64) };
  const candidate = { draftId: "draft", draftRevision: 2, worldId: "owned", contentHash: "b".repeat(64) };
  const spec = { mode: "prop", mainline: [], interactions: [] };
  const make = (id: string, flow: string, parent: string, input: unknown, output: unknown, steps: unknown[] = []) =>
    ({ id, flow: { id: flow }, parent: { runId: parent }, status: "completed", input, output, steps }) as unknown as FlowRun;
  const action = <I, O = Record<string, unknown>>(id: string, name: string, input: I, output: O = {} as O) =>
    ({ id, kind: "action", actionId: "veya/" + name, input, output, status: "completed" });
  const child = (id: string) => ({ kind: "flow", childRunId: id, status: "completed" });
  const build = make("build", "veya/veya-world-build", "specialist", {}, { candidate, gameplaySpec: spec }, [
    action("compose", "draft-compose", { modules: [module] }, { draft_id: "draft", draft_revision: 2, world_id: "owned", content_hash: candidate.contentHash }),
  ]);
  const verify = make("verify", "veya/veya-world-verify", "specialist", { candidate, gameplaySpec: spec }, { contentHash: candidate.contentHash }, [child("baseline")]);
  const begin = action("begin", "playtest-begin", { draftId: "draft", candidateHash: candidate.contentHash }, { operation_id: "begin", status: "queued" });
  const beginWait = action("begin-wait", "operation-status", { operationId: "begin" }, { operation_id: "begin", status: "succeeded",
    result: { ok: true, data: { world_id: "test_owned", playtest_id: "test_owned", candidate_hash: candidate.contentHash } } });
  const end = action("end", "playtest-end", { playtestId: "test_owned" }, { playtest: false });
  const baseline = make("baseline", "veya/veya-verify-baseline", "verify", { candidate }, {}, [begin, beginWait, child("interaction"), child("visual"), end]);
  const agent = { kind: "agent", status: "completed", actions: [{ id: "veya/character-navigate" }] };
  const interaction = make("interaction", "veya/veya-verify-interaction", "baseline", {}, {}, [agent,
    action("perform", "action-perform", { worldId: "test_owned", action: "talk", target: "prop:plaque" }),
    action("receipt", "character-inspect", { worldId: "test_owned", actionId: 1, runtimeEpoch: 1 })]);
  const visual = make("visual", "veya/veya-verify-visual", "baseline", {}, {}, [
    action("preview", "world-preview", { worldId: "test_owned", candidateHash: candidate.contentHash }),
    { kind: "agent", status: "completed", actions: [] },
  ]);
  const runs = [build, verify, baseline, interaction, visual];
  assert.deepEqual([...reusedVerificationRuns(runs, module)], ["verify", "baseline", "interaction", "visual"]);
  for (const name of ["creation-module-write", "model-generate", "cooker-submit", "world-apply"]) {
    visual.steps.push(action("hidden", name, {}) as never);
    assert.throws(() => reusedVerificationRuns(runs, module), /previous_request_unavailable/);
    visual.steps.pop();
  }
  agent.actions.push({ id: "veya/model-generate" });
  assert.throws(() => reusedVerificationRuns(runs, module)); agent.actions.pop();
  const preview = visual.steps[0]!; assert.equal(preview.kind, "action");
  if (preview.kind !== "action") throw new Error("fixture");
  (preview.input as Record<string, unknown>).worldId = "formal-world";
  assert.throws(() => reusedVerificationRuns(runs, module)); (preview.input as Record<string, unknown>).worldId = "test_owned";
  end.output.playtest = true; assert.throws(() => reusedVerificationRuns(runs, module)); end.output.playtest = false;
  beginWait.output.status = "running"; assert.throws(() => reusedVerificationRuns(runs, module)); beginWait.output.status = "succeeded";
  (verify.input as Record<string, unknown>).candidate = { ...candidate, contentHash: "c".repeat(64) };
  assert.throws(() => reusedVerificationRuns(runs, module)); (verify.input as Record<string, unknown>).candidate = candidate;
  const compose = build.steps[0]!; if (compose.kind !== "action") throw new Error("fixture");
  (compose.input as Record<string, unknown>).modules = [{ ...module, content_hash: "c".repeat(64) }];
  assert.throws(() => reusedVerificationRuns(runs, module));
});
