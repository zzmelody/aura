import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { FlowRun, JsonValue } from "@aura/protocol/types";
import { ActionFailure, type AuraCapabilityClient } from "./action-api.ts";
import { VeyaCreatorBindings } from "./veya-creator-bindings.ts";
import { VEYA_WORLD_AGENT_CAPABILITY } from "./veya-world-agent.ts";

type Lease = { rootRunId: string; requestId: string; beginRequestId?: string; operationId?: string;
  playtestId?: string; endOperationId?: string; cancelling?: boolean; state: "starting" | "active" | "needs_attention" };
type Journal = { version: 1; leases: Record<string, Lease> };
const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const path = (root: string) => join(root, ".aura", "veya-creator", "playtest-leases.json");
export async function readCreatorLeases(root: string): Promise<Journal> {
  try {
    const bytes = await readFile(path(root));
    if (bytes.length > 256 * 1024) throw new Error("creator_lease_invalid");
    const value = JSON.parse(bytes.toString("utf8"));
    if (value?.version !== 1 || !object(value.leases)) throw new Error("creator_lease_invalid");
    return value as Journal;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, leases: {} };
    throw error;
  }
}
function status(value: unknown): Record<string, unknown> | undefined {
  const outer = object(value), result = object(outer?.result);
  return object(result?.data) ?? result ?? object(outer?.data) ?? outer;
}
function stableEndId(requestId: string) {
  const h = createHash("sha256").update("creator-playtest-cleanup:" + requestId).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** One host-owned lease per bound worker. Flow cancellation cannot skip cleanup. */
export class VeyaCreatorLifecycle implements AuraCapabilityClient {
  private writes: Promise<unknown> = Promise.resolve();
  readonly bindings: VeyaCreatorBindings;
  readonly get: (id: string) => FlowRun;
  readonly worker: AuraCapabilityClient;
  constructor(bindings: VeyaCreatorBindings, get: (id: string) => FlowRun, worker: AuraCapabilityClient) {
    this.bindings = bindings; this.get = get; this.worker = worker;
  }
  private mutate<T>(work: (journal: Journal) => T): Promise<T> {
    const task = this.writes.then(async () => {
      const journal = await readCreatorLeases(this.bindings.projectRoot), result = work(journal);
      const bytes = JSON.stringify(journal);
      if (Buffer.byteLength(bytes) > 256 * 1024) throw new ActionFailure("creator_lease_capacity_exceeded");
      await mkdir(join(this.bindings.projectRoot, ".aura", "veya-creator"), { recursive: true });
      const target = path(this.bindings.projectRoot), temporary = target + "." + randomUUID() + ".tmp";
      await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
      await rename(temporary, target);
      return result;
    });
    this.writes = task.catch(() => undefined); return task;
  }
  private async owner(id?: string) { return id ? this.bindings.binding(id, this.get, false) : undefined; }
  async invoke(capability: string, operation: string, input: JsonValue, signal: AbortSignal,
    context?: { readonly runId?: string }): Promise<JsonValue> {
    signal.throwIfAborted();
    if (!["veya.playtest.begin", "veya.playtest.end", "veya.operation.status"].includes(operation))
      return this.worker.invoke(capability, operation, input, signal, context);
    const bound = await this.owner(context?.runId);
    if (!bound) return this.worker.invoke(capability, operation, input, signal, context);
    const session = bound.record.creationSessionId!, body = object(input)!;
    if (operation === "veya.playtest.begin") {
      if (typeof body.request_id !== "string") throw new ActionFailure("creator_begin_identity_missing");
      await this.mutate(journal => {
        const old = journal.leases[session];
        if (old && (old.rootRunId !== bound.run.id || old.beginRequestId !== body.request_id || old.cancelling))
          throw new ActionFailure("creator_playtest_lease_busy");
        journal.leases[session] = old ?? { rootRunId: bound.run.id, requestId: bound.run.requestId,
          beginRequestId: body.request_id as string, state: "starting" };
      });
    }
    let result: JsonValue;
    try { result = await this.worker.invoke(capability, operation, input, signal, context); }
    catch (error) {
      // A native validation refusal did not submit begin; network/abort failures
      // remain owned and unresolved, even when no response supplied an op ID.
      if (operation === "veya.playtest.begin" && error instanceof ActionFailure && /\(HTTP 4\d\d\)/u.test(error.message))
        await this.mutate(journal => { const lease = journal.leases[session];
          if (lease?.rootRunId === bound.run.id && !lease.operationId && !lease.cancelling) delete journal.leases[session]; });
      throw error;
    }
    await this.mutate(journal => {
      const lease = journal.leases[session];
      if (!lease || lease.rootRunId !== bound.run.id) return;
      const response = object(result), state = status(result);
      if (operation === "veya.playtest.begin" && typeof response?.operation_id === "string") lease.operationId = response.operation_id;
      if (operation === "veya.playtest.end" && body.playtest_id === lease.playtestId && typeof response?.operation_id === "string")
        lease.endOperationId = response.operation_id;
      if (operation === "veya.operation.status" && body.operation_id === lease.operationId && response?.status === "succeeded" &&
          typeof state?.playtest_id === "string" && state.playtest_id.startsWith("test_")) {
        lease.playtestId = state.playtest_id; lease.state = "active";
      }
      const ended = operation === "veya.playtest.end" && body.playtest_id === lease.playtestId && state?.playtest_id === "";
      const endPolled = operation === "veya.operation.status" && body.operation_id === lease.endOperationId &&
        response?.status === "succeeded" && state?.playtest_id === "";
      if (ended || endPolled) delete journal.leases[session];
    });
    return result;
  }
  async markCancelling(runId: string) {
    const bound = await this.owner(runId); if (!bound) return;
    await this.mutate(journal => {
      const session = bound.record.creationSessionId!, lease = journal.leases[session];
      if (lease && lease.rootRunId !== bound.run.id) return; // Never claim another Run's test.
      journal.leases[session] = { ...(lease ?? { rootRunId: bound.run.id, requestId: bound.run.requestId, state: "starting" }), cancelling: true };
    });
  }
  async cleanup(runId: string) {
    const bound = await this.owner(runId); if (!bound) return;
    const session = bound.record.creationSessionId!, context = { runId }, signal = AbortSignal.timeout(12_000);
    const call = (tool: string, body: JsonValue) => this.worker.invoke(VEYA_WORLD_AGENT_CAPABILITY, tool, body, signal, context);
    let lease = (await readCreatorLeases(this.bindings.projectRoot)).leases[session];
    if (!lease || lease.rootRunId !== bound.run.id) return;
    try {
      if (!lease.beginRequestId) { await this.clear(session, bound.run.id); return; }
      if (!lease.playtestId) {
        if (!lease.operationId) throw new Error("begin_outcome_unknown");
        for (;;) {
          const response = object(await call("veya.operation.status", { operation_id: lease.operationId }));
          if (response?.status === "succeeded") {
            const id = status(response)?.playtest_id;
            if (typeof id !== "string" || !id.startsWith("test_")) throw new Error("begin_identity_unknown");
            lease = { ...lease, playtestId: id }; break;
          }
          if (response?.status === "failed" || response?.status === "cancelled") {
            const current = status(await call("veya.world.status", {}));
            if (current?.playtest_id !== "") throw new Error("begin_identity_unknown");
            await this.clear(session, bound.run.id); return;
          }
          await delay(100, undefined, { signal });
        }
        await this.mutate(journal => { if (journal.leases[session]?.rootRunId === bound.run.id) journal.leases[session] = lease; });
      }
      const current = status(await call("veya.world.status", {}));
      if (current?.playtest_id === "") { await this.clear(session, bound.run.id); return; }
      if (current?.playtest_id !== lease.playtestId) throw new Error("test_owner_changed");
      // Native end checks this exact playtest_id. An old cleanup cannot end a
      // later test even if it starts between this read and the guarded write.
      await call("veya.playtest.end", { playtest_id: lease.playtestId!, request_id: stableEndId(lease.requestId) });
      for (;;) {
        const observed = status(await call("veya.world.status", {}));
        if (observed?.playtest_id === "") { await this.clear(session, bound.run.id); return; }
        if (observed?.playtest_id !== lease.playtestId) throw new Error("test_owner_changed");
        await delay(100, undefined, { signal });
      }
    } catch {
      await this.mutate(journal => { if (journal.leases[session]?.rootRunId === bound.run.id)
        journal.leases[session] = { ...lease, cancelling: true, state: "needs_attention" }; });
      throw new ActionFailure("creator_cleanup_needs_attention");
    }
  }
  private clear(session: string, runId: string) {
    return this.mutate(journal => { if (journal.leases[session]?.rootRunId === runId) delete journal.leases[session]; });
  }
}
