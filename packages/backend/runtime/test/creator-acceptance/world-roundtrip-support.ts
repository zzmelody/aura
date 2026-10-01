/** Test-only decoding of the two existing native position representations. */
export type Vec3 = [number, number, number];
export function positionVector(value: unknown): Vec3 {
  let coordinates: unknown[];
  if (Array.isArray(value)) coordinates = value;
  else if (value !== null && typeof value === "object") {
    const point = value as Record<string, unknown>;
    if (Object.keys(point).length !== 3 || !Object.hasOwn(point, "x") || !Object.hasOwn(point, "y") || !Object.hasOwn(point, "z"))
      throw new Error("Position must contain exactly x/y/z");
    coordinates = [point.x, point.y, point.z];
  } else throw new Error("Position must be a tuple or x/y/z object");
  if (coordinates.length !== 3 || coordinates.some(x => typeof x !== "number" || !Number.isFinite(x)))
    throw new Error("Position coordinates must be three finite numbers");
  return [...coordinates] as Vec3;
}

/** Keep the E3 test opt-in: a normal world case retains the old entrance route. */
export function roundtripMode(fixture: Record<string, unknown>): { kind: "world" | "prop"; ownerTargetId: string } {
  const kind = fixture.artifactKind ?? "world";
  if (kind !== "world" && kind !== "prop") throw new Error("Roundtrip artifactKind must be world or prop");
  if (typeof fixture.targetId !== "string" || !fixture.targetId.length) throw new Error("Reading target required");
  const owner = Object.hasOwn(fixture, "ownerTargetId") ? fixture.ownerTargetId : kind === "world" ? fixture.targetId : undefined;
  if (typeof owner !== "string" || !/^[A-Za-z0-9_.:-]{1,192}$/u.test(owner) || owner.includes("REPLACE_"))
    throw new Error("Reading ownerTargetId must be an exact bounded stable ID");
  if (kind === "world") return { kind, ownerTargetId: owner };
  if (fixture.display !== "floating" || owner === fixture.targetId)
    throw new Error("Floating prop requires a distinct, explicit ownerTargetId");
  if (!Array.isArray(fixture.toReading) || fixture.toReading.length < 2 || fixture.toReading.length > 32)
    throw new Error("Floating prop requires at least two explicit passage waypoints");
  const points = fixture.toReading.map(positionVector);
  if (!points.some(point => Math.hypot(point[0] - points[0]![0], point[2] - points[0]![2]) > 0.01))
    throw new Error("Floating passage waypoints must be distinct");
  return { kind, ownerTargetId: owner };
}

export function horizontalMovement(receipt: Record<string, unknown>): number {
  const start = positionVector(receipt.start_position), end = positionVector(receipt.end_position);
  if (typeof receipt.camera_yaw !== "number" || !Number.isFinite(receipt.camera_yaw) ||
      !Number.isSafeInteger(receipt.start_tick) || !Number.isSafeInteger(receipt.end_tick) ||
      Number(receipt.end_tick) <= Number(receipt.start_tick)) throw new Error("Movement needs actual camera and advancing ticks");
  return Math.hypot(end[0] - start[0], end[2] - start[2]);
}

export function requireFloatingPassage(waypointCount: number, movedMeters: number): void {
  if (!Number.isSafeInteger(waypointCount) || waypointCount < 2 || !Number.isFinite(movedMeters) || movedMeters < 2)
    throw new Error("Floating passage requires two reached waypoints and at least two metres of normal input movement");
}

type ReadingData = Record<string, any>; // Test receipts, independently checked below.

/** A restored scalar alone does not prove that the saved object's action still
 * works. Exercise the normal point again and retain its new scoped receipt. */
export async function verifyRestoredReading(options: {
  scope: ReadingData; targetId: string; ownerTargetId: string; scalarKey: string;
  scalarAfter: string | number | boolean; expectedText: string; firstAction: ReadingData;
  route: () => Promise<void>;
  perform: (targetId: string, action: string) => Promise<ReadingData>;
  observe: () => Promise<ReadingData>;
  close: (snapshot: ReadingData) => Promise<void>;
}): Promise<{ rereadAction: ReadingData; reread: ReadingData; rereadClosed: ReadingData }> {
  const { scope, firstAction } = options;
  const fail = (condition: unknown, reason: string) => { if (!condition) throw new Error(reason); };
  const scoped = (value: ReadingData) => {
    for (const key of ["world_id", "instance_id", "runtime_epoch"])
      fail(value[key] === scope[key], `Restored reading scope changed: ${key}`);
  };
  await options.route();
  const rereadAction = await options.perform(options.targetId, "talk");
  scoped(rereadAction);
  fail(Number.isSafeInteger(rereadAction.receipt?.action_id) && rereadAction.receipt.action_id > 0 &&
    rereadAction.receipt.phase === "succeeded" && rereadAction.receipt.committed === true,
  "Restored reading needs its own completed action receipt");
  fail(firstAction.world_id !== rereadAction.world_id || firstAction.instance_id !== rereadAction.instance_id ||
    firstAction.runtime_epoch !== rereadAction.runtime_epoch || firstAction.receipt?.action_id !== rereadAction.receipt.action_id,
  "Restored reading reused the original scoped action receipt");
  const reread = await options.observe(); scoped(reread);
  fail(reread.revision === scope.revision && reread.script_state?.[options.scalarKey] === options.scalarAfter,
    "Restored reading changed saved progress or revision");
  const dialogue = reread.actor_state?.dialogue;
  fail(dialogue?.active === true && dialogue.target === options.ownerTargetId && dialogue.text === options.expectedText,
    "Restored reading owner or complete text mismatch");
  await options.close(reread);
  const rereadClosed = await options.observe(); scoped(rereadClosed);
  fail(rereadClosed.revision === scope.revision && rereadClosed.actor_state?.dialogue?.active === false &&
    rereadClosed.script_state?.[options.scalarKey] === options.scalarAfter,
  "Restored reading did not close normally with saved progress unchanged");
  return { rereadAction, reread, rereadClosed };
}
