import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { JsonValue } from "@aura/protocol/types";
import { VeyaWorldAgentCapability, VEYA_WORLD_AGENT_CAPABILITY } from "./veya-world-agent.ts";

export type VeyaCraftScope = { schemaVersion: 1; worldId: string; instanceId: string; runtimeEpoch: number; orderId: string };
const id = /^[A-Za-z0-9_.:-]{1,96}$/u;
export function readVeyaCraftScope(value: unknown): VeyaCraftScope {
  const v = value as Record<string, unknown> | undefined;
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some(k => !["schemaVersion", "worldId", "instanceId", "runtimeEpoch", "orderId"].includes(k)) ||
      v.schemaVersion !== 1 || ![v.worldId, v.instanceId, v.orderId].every(x => typeof x === "string" && id.test(x)) ||
      !Number.isSafeInteger(v.runtimeEpoch) || Number(v.runtimeEpoch) < 0) throw new Error("craft_scope_invalid");
  return v as VeyaCraftScope;
}
export function craftToolScope(scope: VeyaCraftScope): Record<string, JsonValue> {
  return { world_id: scope.worldId, instance_id: scope.instanceId, runtime_epoch: scope.runtimeEpoch, order_id: scope.orderId };
}
export function assertCraftToolScope(scope: VeyaCraftScope, value: JsonValue | undefined): void {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.entries(craftToolScope(scope)).some(([k, v]) => value[k] !== v))
    throw new Error("craft_scope_mismatch");
}
export async function verifyCraftForeground(path: string): Promise<void> {
  if (!isAbsolute(path)) throw new Error("craft_foreground_invalid");
  const bytes = await readFile(path);
  if (bytes.length > 8192) throw new Error("craft_foreground_invalid");
  const descriptor = JSON.parse(bytes.toString("utf8"));
  if (descriptor.role !== "game-runtime" || descriptor.protocol !== "veya-world-http/1" ||
      typeof descriptor.base_url !== "string" || !/^http:\/\/127\.0\.0\.1:\d+\/?$/u.test(descriptor.base_url) ||
      typeof descriptor.token !== "string" || !/^[a-f0-9]{64}$/u.test(descriptor.token)) throw new Error("craft_foreground_invalid");
}
/** Admission reads the live native order. HTTP callers never supply authority. */
export async function admitVeyaCraft(path: string, scope: VeyaCraftScope, request: typeof fetch = fetch): Promise<string> {
  await verifyCraftForeground(path);
  const result = await new VeyaWorldAgentCapability(path, request).invoke(VEYA_WORLD_AGENT_CAPABILITY, "veya.craft.context", craftToolScope(scope), AbortSignal.timeout(10000));
  if (!result || typeof result !== "object" || Array.isArray(result))
    throw new Error("craft_authority_refused");
  assertCraftToolScope(scope, result);
  if (!["queued", "designing", "producing", "failed", "needs_input"].includes(String(result.phase))) throw new Error("craft_order_stale");
  if (typeof result.authorization_digest !== "string" || !/^[a-f0-9]{64}$/u.test(result.authorization_digest)) throw new Error("craft_authority_refused");
  return result.authorization_digest;
}
