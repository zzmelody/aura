/** Explicit real packaged-runtime acceptance; never imported by production. */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { horizontalMovement, positionVector, requireFloatingPassage, roundtripMode, verifyRestoredReading, type Vec3 } from "./world-roundtrip-support.ts";

type Data = Record<string, any>; // Untrusted test JSON is validated before each operation.
const args = process.argv.slice(2), flags = new Map<string, string>();
if (!args.length || args[0] === "help") {
  console.log("world-roundtrip.ts --worker <descriptor> --case <JSON> --output <new-directory>. Requires --creation-owned-input-test worker; see README.");
  process.exit(0);
}
while (args.length) {
  const key = args.shift()!, value = args.shift();
  if (!key.startsWith("--") || value === undefined || flags.has(key)) throw new Error("Use unique --name value pairs");
  flags.set(key, value);
}
function absolute(key: string) {
  const value = flags.get(key);
  if (!value || !isAbsolute(value)) throw new Error(`${key} requires an absolute path`);
  return resolve(value);
}
function requireValue(ok: unknown, reason: string): asserts ok { if (!ok) throw new Error(reason); }
const read = async (file: string): Promise<Data> => JSON.parse(await readFile(file, "utf8"));
const descriptor = await read(absolute("--worker")), fixture = await read(absolute("--case"));
const output = absolute("--output"), origin = new URL(descriptor.base_url);
requireValue(descriptor.role === "creator-worker" && /^[a-f0-9]{32}$/.test(descriptor.creation_session_id), "Isolated creator worker required");
requireValue(origin.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname) && !origin.username && !origin.password, "Loopback descriptor required");
requireValue(typeof descriptor.token === "string" && descriptor.token.length > 0, "Descriptor credential missing");
const named = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 256 && !v.includes("REPLACE_");
requireValue(/^[a-f0-9]{64}$/.test(fixture.artifactId), "Exact artifact ID required");
const mode = roundtripMode(fixture);
for (const key of ["homeWorldId", "playerId", "targetId", "scalarKey", "expectedText", ...(mode.kind === "world" ? ["returnTargetId"] : [])])
  requireValue(named(fixture[key]), `Invalid fixture ${key}`);
requireValue(["string", "number", "boolean"].includes(typeof fixture.scalarAfter), "Expected persistent scalar required");
requireValue(fixture.scalarBefore === null || ["string", "number", "boolean"].includes(typeof fixture.scalarBefore), "scalarBefore must be an exact scalar or null for absent");
const vector = positionVector;
const waypoints = (value: unknown): Vec3[] => {
  requireValue(value === undefined || Array.isArray(value) && value.length <= 32, "At most 32 test route waypoints");
  return (value ?? []) as Vec3[];
};
for (const key of ["toReading", "toReturn"]) waypoints(fixture[key]).forEach(vector);
await mkdir(output, { recursive: true });
// Refuse accidental reruns that might hide a previous partial side effect.
await writeFile(join(output, "claimed.json"), JSON.stringify({ startedAt: new Date().toISOString(), fixture }), { flag: "wx", mode: 0o600 });
const prefix = "roundtrip-" + randomUUID().replaceAll("-", ""), trace: Data[] = [];
const report: Data = { schemaVersion: 1, ok: false, startedAt: new Date().toISOString(), artifactId: fixture.artifactId,
  creationSessionId: descriptor.creation_session_id, test: mode.kind === "prop" ? "owned_floating_prop_normal_input_roundtrip" : "owned_world_normal_input_roundtrip", fixture };
const save = (file: string, data: unknown) => writeFile(join(output, file), JSON.stringify(data, null, 2), { mode: 0o600 });
let sequence = 0, pendingOperation: string | undefined;
const requestId = (kind: string) => `${prefix}-${kind}-${++sequence}`;
async function post(path: string, body: Data): Promise<Data> {
  const response = await fetch(new URL(path, origin), { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${descriptor.token}` },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const result = await response.json() as Data;
  trace.push({ observedAt: new Date().toISOString(), path, input: body, httpStatus: response.status, result });
  if (!response.ok || result.ok !== true) throw new Error(`Native request failed (${response.status}): ${String(result.error ?? "unknown")}`);
  return result.data;
}
const call = (tool: string, input: Data = {}) => post("/agent/v1/call", { tool, arguments: input });
async function complete(result: Data): Promise<Data> {
  if (!result.operation_id) return result;
  const operation = String(result.operation_id); pendingOperation = operation;
  for (let i = 0; i < 240; i++) {
    const state = await call("veya.operation.status", { operation_id: operation });
    if (!["queued", "running"].includes(state.status)) {
      pendingOperation = undefined;
      requireValue(state.status === "succeeded" && state.result?.ok === true, `Operation failed: ${state.result?.error ?? state.status}`);
      return state.result.data;
    }
    await delay(250);
  }
  throw new Error("Operation timed out; no mutation was resubmitted");
}
const status = () => call("veya.world.status");
function sameScope(observed: Data, scope: Data) {
  for (const key of ["world_id", "instance_id", "runtime_epoch", "revision"])
    requireValue(observed[key] === scope[key], `Observed scope changed: ${key}`);
}
async function observe(scope: Data) {
  const observed = await call("veya.runtime.observe", { world_id: scope.world_id, instance_id: scope.instance_id,
    actor: fixture.playerId, ids: [...new Set([fixture.playerId, fixture.targetId, mode.ownerTargetId,
      ...(mode.kind === "world" ? [fixture.returnTargetId] : [])])] });
  sameScope(observed, scope); requireValue(!observed.lua?.error && !observed.lua?.last_error, "Runtime Lua failed");
  return observed;
}
function entity(snapshot: Data, id: string): Data {
  const value = snapshot.entities?.find((entry: Data) => entry.id === id); requireValue(value, `Missing observed entity: ${id}`); return value;
}
const position = (snapshot: Data, id: string) => vector(entity(snapshot, id).components?.transform?.position);
const distance = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[2] - b[2]);
let inputCount = 0, inputTicks = 0, movedMeters = 0;
const movements: Data[] = [], reachedWaypoints: Data[] = [];
async function input(scope: Data, move: Vec3, ticks: number) {
  requireValue(++inputCount <= 180 && (inputTicks += ticks) <= 3600, "Normal input route exceeded test budget");
  const result = await complete(await post("/v2/testing/creation-input", { request_id: requestId("input"), world_id: scope.world_id,
    instance_id: scope.instance_id, expected_revision: scope.revision, runtime_epoch: scope.runtime_epoch,
    artifact_id: fixture.artifactId, player_id: fixture.playerId, move, ticks }));
  requireValue(result.world_id === scope.world_id && result.instance_id === scope.instance_id && result.runtime_epoch === scope.runtime_epoch &&
    result.expected_revision === scope.revision && result.artifact_id === fixture.artifactId && result.player_id === fixture.playerId &&
    result.submitted_ticks === ticks && result.end_tick > result.start_tick && result.device_input_restored === true,
  "Input operation lacks exact scope, ticks or restored device collection");
  const actualMeters = horizontalMovement(result); movedMeters += actualMeters;
  movements.push({ observedAt: new Date().toISOString(), move, ticks, actualMeters, result });
  return result;
}
async function approach(scope: Data, targetId: string | undefined, goal: Vec3, radius: number, action?: string) {
  // A zero-vector normal-input probe obtains authoritative camera yaw without changing the camera/controller.
  let movement = await input(scope, [0, 0, 0], 1), stalled = 0;
  for (let attempt = 0; attempt < 100; attempt++) {
    const snapshot = await observe(scope), current = position(snapshot, fixture.playerId);
    if (targetId && action && entity(snapshot, targetId).interaction?.options?.some((x: Data) => x.action === action && x.available === true)) return;
    const gap = distance(current, goal); if (gap <= radius) return;
    requireValue(typeof movement.camera_yaw === "number" && Number.isFinite(movement.camera_yaw), "Test input result lacks authoritative camera_yaw");
    const dx = (goal[0] - current[0]) / gap, dz = (goal[2] - current[2]) / gap;
    const c = Math.cos(movement.camera_yaw), s = Math.sin(movement.camera_yaw);
    movement = await input(scope, [Math.max(-1, Math.min(1, c * dx - s * dz)), 0, Math.max(-1, Math.min(1, s * dx + c * dz))], gap < 1 ? 4 : 12);
    const actual = distance(vector(movement.start_position), vector(movement.end_position));
    stalled = actual < 0.015 ? stalled + 1 : 0;
    requireValue(stalled < 5, "Normal input blocked by real collision; provide an explicit safe test route");
  }
  throw new Error("Normal input did not reach the target within bounded route attempts");
}
async function route(scope: Data, points: Vec3[], targetId: string, action: string) {
  for (const point of points) {
    await approach(scope, undefined, vector(point), 0.35);
    const reached = await observe(scope), actual = position(reached, fixture.playerId);
    requireValue(distance(actual, vector(point)) <= 0.35, "Explicit route waypoint was not reached");
    reachedWaypoints.push({ point, actual, scope, runtimeTick: reached.runtime_tick, observedAt: new Date().toISOString() });
  }
  const snapshot = await observe(scope);
  await approach(scope, targetId, position(snapshot, targetId), 0.7, action);
  const reached = await observe(scope);
  requireValue(entity(reached, targetId).interaction?.options?.some((x: Data) => x.action === action && x.available === true), "Required interaction unavailable after normal input");
}
async function perform(scope: Data, target: string, action: string, wait = true) {
  const result = await call("veya.action.perform", { world_id: scope.world_id, instance_id: scope.instance_id,
    actor: fixture.playerId, target, action, request_id: requestId(action) });
  requireValue(result.submitted === true && Number.isSafeInteger(result.action_id) && result.action_id > 0 && result.actor === fixture.playerId &&
    result.world_id === scope.world_id && result.instance_id === scope.instance_id && result.runtime_epoch === scope.runtime_epoch, "Exact action submission receipt required");
  if (!wait) return result;
  for (let i = 0; i < 100; i++) {
    const done = await call("veya.character.inspect", { world_id: scope.world_id, instance_id: scope.instance_id,
      runtime_epoch: scope.runtime_epoch, actor: fixture.playerId, action_id: result.action_id });
    requireValue(done.world_id === scope.world_id && done.instance_id === scope.instance_id && done.runtime_epoch === scope.runtime_epoch &&
      done.actor === fixture.playerId && done.receipt?.action_id === result.action_id, "Action inspection returned another receipt");
    if (!["pending", "running"].includes(done.receipt.phase)) {
      requireValue(done.receipt.phase === "succeeded" && done.receipt.committed === true && done.runtime_tick > result.runtime_tick, "Action did not complete its domain commit");
      return done;
    }
    await delay(100);
  }
  throw new Error("Action completion timeout; submitted action was not repeated");
}
function readFact(snapshot: Data) { return snapshot.script_state?.[fixture.scalarKey]; }
function textObserved(snapshot: Data) {
  const dialogue = snapshot.actor_state?.dialogue;
  requireValue(dialogue?.active === true && dialogue.target === mode.ownerTargetId && dialogue.text === fixture.expectedText, "Observed reading owner or complete text mismatch");
  return dialogue;
}
async function closeDialogue(scope: Data, snapshot: Data) {
  const d = textObserved(snapshot);
  requireValue(Array.isArray(d.option_closes) && Array.isArray(d.option_available) && d.option_closes.length === d.option_available.length, "Typed dialogue closing option required");
  const option = d.option_closes.findIndex((closes: unknown, i: number) => closes === true && d.option_available[i] === true);
  requireValue(option >= 0, "No available typed closing option");
  await call("veya.dialogue.choose", { world_id: scope.world_id, instance_id: scope.instance_id, actor: fixture.playerId, option, request_id: requestId("close") });
  const closed = await observe(scope);
  requireValue(closed.actor_state?.dialogue?.active === false && readFact(closed) === fixture.scalarAfter, "Closing changed persistent fact or did not close");
}
try {
  const initial = await status(); requireValue(!initial.playtest_id, "Another isolated playtest owns the worker");
  if (mode.kind === "prop") requireValue(initial.profile?.home_world_id === fixture.homeWorldId, "Floating prop exit must use trusted profile home");
  report.initial = initial;
  const checkout = await call("veya.creation.checkout", { request_id: requestId("checkout"), artifact_id: fixture.artifactId,
    content_hash: fixture.artifactId, mode: "recompose" });
  requireValue(checkout.kind === mode.kind && checkout.artifact_id === fixture.artifactId && named(checkout.world_id), "Verified artifact checkout kind mismatch");
  if (mode.kind === "prop") requireValue(checkout.edit_context?.prop_spec?.display === "floating", "Artifact must prove a floating prop fixture");
  report.checkout = checkout;
  await complete(await call("veya.travel.enter", { request_id: requestId("enter"), world_id: checkout.world_id }));
  const entered = await status(); requireValue(entered.world_id === checkout.world_id && !entered.playtest_id && entered.editable === true, "Owned non-scratch world not active");
  report.entered = entered; const before = await observe(entered); report.before = before;
  requireValue(fixture.scalarBefore === null ? readFact(before) === undefined : readFact(before) === fixture.scalarBefore, "Authored initial state already contains test progress");
  await route(entered, waypoints(fixture.toReading), fixture.targetId, "talk");
  if (mode.kind === "prop") {
    requireFloatingPassage(reachedWaypoints.length, movedMeters);
    report.passage = { passed: true, measuredMeters: movedMeters, waypoints: [...reachedWaypoints],
      ownerTargetId: mode.ownerTargetId, anchorTargetId: fixture.targetId, beforeAction: await observe(entered) };
  }
  report.readAction = await perform(entered, fixture.targetId, "talk");
  const readSnapshot = await observe(entered); textObserved(readSnapshot);
  requireValue(readFact(readSnapshot) === fixture.scalarAfter, "Observable read did not change the required scalar");
  report.read = readSnapshot; await closeDialogue(entered, readSnapshot);
  if (mode.kind === "world") {
    await route(entered, waypoints(fixture.toReturn), fixture.returnTargetId, "interact");
    report.beforeLeave = await observe(entered);
    report.returnAction = await perform(entered, fixture.returnTargetId, "interact", false);
    report.exitMethod = "authored_return_home_entrance";
  } else {
    report.beforeLeave = await observe(entered);
    report.exitMethod = "trusted_profile_home_travel_for_fixture_save";
    report.homeTravel = await complete(await call("veya.travel.enter", { request_id: requestId("fixture-exit"), world_id: fixture.homeWorldId }));
  }
  let home: Data = {};
  for (let i = 0; i < 160; i++) { home = await status(); if (home.world_id === fixture.homeWorldId) break; await delay(250); }
  requireValue(home.world_id === fixture.homeWorldId && home.profile?.home_world_id === fixture.homeWorldId && !home.playtest_id && home.instance_id !== entered.instance_id, "Roundtrip exit did not enter the trusted personal home");
  report.home = home;
  await complete(await call("veya.travel.enter", { request_id: requestId("reenter"), world_id: checkout.world_id }));
  const reentered = await status(); requireValue(reentered.world_id === checkout.world_id && reentered.instance_id !== entered.instance_id && !reentered.playtest_id, "World was not actually unloaded and recreated");
  const restored = await observe(reentered); requireValue(readFact(restored) === fixture.scalarAfter, "Saved read progress was not restored");
  requireValue(restored.actor_state?.dialogue?.active === false, "Transient dialogue was incorrectly persisted");
  report.reentered = reentered; report.restored = restored;
  Object.assign(report, await verifyRestoredReading({ scope: reentered, targetId: fixture.targetId, ownerTargetId: mode.ownerTargetId,
    scalarKey: fixture.scalarKey, scalarAfter: fixture.scalarAfter, expectedText: fixture.expectedText, firstAction: report.readAction,
    route: () => route(reentered, waypoints(fixture.toReading), fixture.targetId, "talk"),
    perform: (target, action) => perform(reentered, target, action), observe: () => observe(reentered),
    close: snapshot => closeDialogue(reentered, snapshot) }));
  const source = await call("veya.world.read", { world_id: checkout.world_id });
  requireValue(/^[a-f0-9]{64}$/.test(source.content_hash), "Authored content hash missing");
  const lineage = await call("veya.world.read", { world_id: checkout.world_id, artifact_id: fixture.artifactId,
    artifact_content_hash: fixture.artifactId, expected_revision: source.revision, expected_content_hash: source.content_hash });
  report.savedLineage = lineage;
  // This is a snapshot, not an automatic edit grant; E4/E5 must supply their exact allowedEntityIds separately.
  await save("saved-target-snapshot.json", { worldId: checkout.world_id, baseRevision: source.revision, baseHash: source.content_hash,
    artifactId: fixture.artifactId, scalarKey: fixture.scalarKey, scalarValue: fixture.scalarAfter, instanceId: reentered.instance_id, runtimeEpoch: reentered.runtime_epoch });
  report.ok = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : "Acceptance failed";
  if (pendingOperation) {
    try { report.cleanup = await call("veya.operation.cancel", { operation_id: pendingOperation }); }
    catch { report.cleanup = { status: "unverified", operationId: pendingOperation }; }
  }
  process.exitCode = 1;
} finally {
  report.completedAt = new Date().toISOString(); report.normalInput = { operations: inputCount, ticks: inputTicks, movedMeters, movements, reachedWaypoints };
  await save("trace.json", trace); await save("report.json", report);
  console.log(JSON.stringify({ ok: report.ok, artifactId: report.artifactId, worldId: report.checkout?.world_id, error: report.error, output }));
}
