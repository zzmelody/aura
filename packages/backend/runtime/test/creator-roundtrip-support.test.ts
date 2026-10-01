import assert from "node:assert/strict";
import { test } from "node:test";
import { horizontalMovement, positionVector, requireFloatingPassage, roundtripMode, verifyRestoredReading } from "./creator-acceptance/world-roundtrip-support.ts";

// No runtime test previously exercised the acceptance harness's conversion:
// agent_entity and other native Transform projections use tuple/object forms.
test("owned roundtrip accepts native tuple and object positions without dropping coordinates", () => {
  const point = [3.4572203159, 0.00013, 34];
  assert.deepEqual(positionVector(point), point);
  assert.deepEqual(positionVector({ x: point[0], y: point[1], z: point[2] }), point);
  assert.notEqual(positionVector(point), point);
});
test("owned roundtrip rejects malformed positions before any movement", () => {
  for (const value of [null, [0, 1], [0, 1, 2, 3], [0, Infinity, 0], [0, NaN, 0], [0, "1", 0],
    { x: 0, z: 1 }, { x: 0, y: 1, z: 2, w: 1 }, { x: 0, y: "1", z: 2 }, { x: 0, y: Infinity, z: 2 }])
    assert.throws(() => positionVector(value));
});

// Existing world fixtures do not cover prop anchor/owner routing or prevent a
// spawn already in range from being misreported as a collision passage test.
test("floating roundtrip is explicit and preserves the legacy world target", () => {
  assert.deepEqual(roundtripMode({ targetId: "plaque" }), { kind: "world", ownerTargetId: "plaque" });
  assert.deepEqual(roundtripMode({ artifactKind: "prop", display: "floating", targetId: "ground_anchor", ownerTargetId: "plaque",
    toReading: [[0, 0, 1], { x: 0, y: 0, z: 3 }] }), { kind: "prop", ownerTargetId: "plaque" });
  const valid = { artifactKind: "prop", display: "floating", targetId: "ground_anchor", ownerTargetId: "plaque", toReading: [[0, 0, 1], [0, 0, 3]] };
  for (const patch of [{ artifactKind: "patch" }, { display: "tabletop" }, { ownerTargetId: "ground_anchor" },
    { ownerTargetId: undefined }, { toReading: [] }, { toReading: [[0, 0, 1]] }, { toReading: [[0, 0, 1], [0, 9, 1]] },
    { toReading: [[0, 0, Infinity], [0, 0, 3]] }]) assert.throws(() => roundtripMode({ ...valid, ...patch }));
});

// A world can use a table-level interaction point whose Dialogue lives on a
// different owner. Earlier world fixtures only exercised the direct target.
test("world roundtrip preserves direct defaults and routes split dialogue to an explicit bounded owner", () => {
  assert.deepEqual(roundtripMode({ targetId: "plaque" }), { kind: "world", ownerTargetId: "plaque" });
  const fixture = { artifactKind: "world", targetId: "plaque_interaction", ownerTargetId: "plaque" };
  assert.deepEqual(roundtripMode(fixture), { kind: "world", ownerTargetId: "plaque" });
  assert.equal(fixture.targetId, "plaque_interaction", "action submission retains the interaction point");
  assert.equal(roundtripMode({ ...fixture, ownerTargetId: "x".repeat(192) }).ownerTargetId.length, 192);
  for (const ownerTargetId of [undefined, null, "", 7, "x".repeat(193), "bad id", "../owner", "REPLACE_OWNER"])
    assert.throws(() => roundtripMode({ ...fixture, ownerTargetId }));
});

test("floating passage counts actual receipt movement with camera and ticks", () => {
  const receipt = { start_position: [0, 0, 0], end_position: { x: 1.5, y: 0.01, z: 2 }, camera_yaw: 0.4, start_tick: 10, end_tick: 22 };
  assert.equal(horizontalMovement(receipt), 2.5);
  requireFloatingPassage(2, horizontalMovement(receipt));
  for (const args of [[0, 3], [1, 3], [2, 0], [2, 1.999], [2, NaN], [2, Infinity]])
    assert.throws(() => requireFloatingPassage(args[0]!, args[1]!));
  for (const patch of [{ camera_yaw: undefined }, { camera_yaw: NaN }, { end_tick: 10 }, { start_tick: 1.5 },
    { end_position: [0, 1] }]) assert.throws(() => horizontalMovement({ ...receipt, ...patch }));
});

// Earlier acceptance stopped at the restored scalar. A disabled post-reentry
// action, wrong Dialogue owner or stale first-read receipt could go unnoticed.
test("normal roundtrip re-approaches the point and proves a fresh scoped reading after restoration", async () => {
  const scope = { world_id: "world", instance_id: "new-instance", runtime_epoch: 1, revision: 3 };
  const calls: string[] = [], scalar = { "prop:read": true };
  const snapshot = (active: boolean) => ({ ...scope, script_state: scalar,
    actor_state: { dialogue: { active, target: "owner", text: "Exact prose" } } });
  const receipt = { ...scope, receipt: { action_id: 7, phase: "succeeded", committed: true } };
  const firstAction = { ...receipt, instance_id: "old-instance" }; // IDs may repeat in a different world instance.
  let closed = false;
  const result = await verifyRestoredReading({ scope, targetId: "point", ownerTargetId: "owner", scalarKey: "prop:read",
    scalarAfter: true, expectedText: "Exact prose", firstAction,
    route: async () => { calls.push("route"); },
    perform: async (target, action) => { calls.push(`${target}:${action}`); return receipt; },
    observe: async () => { calls.push(closed ? "observe-closed" : "observe-open"); return snapshot(!closed); },
    close: async () => { calls.push("normal-close"); closed = true; } });
  assert.deepEqual(calls, ["route", "point:talk", "observe-open", "normal-close", "observe-closed"]);
  assert.equal(result.rereadAction, receipt);
  assert.equal(result.reread.actor_state.dialogue.target, "owner");
  assert.equal(result.rereadClosed.actor_state.dialogue.active, false);
});

test("restored reading rejects stale receipts, refusal, wrong owner/text and lost progress", async () => {
  const scope = { world_id: "world", instance_id: "new-instance", runtime_epoch: 2, revision: 3 };
  const receipt = { ...scope, receipt: { action_id: 8, phase: "succeeded", committed: true } };
  const snapshot = { ...scope, script_state: { read: true }, actor_state: { dialogue: { active: true, target: "owner", text: "Exact" } } };
  for (const defect of ["old-scope", "same-receipt", "refused", "owner", "text", "scalar", "close"]) {
    let closed = false;
    await assert.rejects(verifyRestoredReading({ scope, targetId: "point", ownerTargetId: "owner", scalarKey: "read",
      scalarAfter: true, expectedText: "Exact", firstAction: defect === "same-receipt" ? receipt : { ...receipt, instance_id: "old-instance" },
      route: async () => {}, perform: async () => defect === "old-scope" ? { ...receipt, instance_id: "old-instance" }
        : defect === "refused" ? { ...receipt, receipt: { ...receipt.receipt, phase: "failed", committed: false } } : receipt,
      observe: async () => ({ ...snapshot, script_state: { read: defect !== "scalar" }, actor_state: { dialogue: {
        ...snapshot.actor_state.dialogue, active: !closed || defect === "close", target: defect === "owner" ? "point" : "owner",
        text: defect === "text" ? "Other" : "Exact" } } }), close: async () => { closed = true; } }), /Restored reading/);
  }
});
