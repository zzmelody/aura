import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { FlowRun, JsonValue } from "@aura/protocol/types";
import { VeyaCreatorBindings } from "../src/veya-creator-bindings.ts";
import { VeyaCreatorLifecycle, readCreatorLeases } from "../src/veya-creator-lifecycle.ts";
import { VEYA_WORLD_AGENT_CAPABILITY as capability } from "../src/veya-world-agent.ts";

// Existing cancellation tests stop durable execution. They cannot observe the
// native test instance or prove that a late cancellation cannot end another one.
test("creator host owns guarded playtest cleanup and reconciles a lost end response", async () => {
  const root = await mkdtemp(join(tmpdir(), "aura-creator-lease-"));
  try {
    const session = "a".repeat(32), descriptor = join(root, "worker.json");
    await writeFile(descriptor, JSON.stringify({ role: "creator-worker", creation_session_id: session }));
    const make = () => ({ id: randomUUID(), requestId: randomUUID(), flow: { id: "veya/veya-wish" } }) as FlowRun;
    const first = make(), second = make(), runs = new Map([first, second].map(run => [run.id, run]));
    const child = { ...make(), parent: { runId: first.id, stepKey: "child" } }; runs.set(child.id, child);
    await mkdir(join(root, ".aura", "veya-creator"), { recursive: true });
    await writeFile(join(root, ".aura", "veya-creator", "bindings.json"), JSON.stringify({ version: 1,
      bindings: Object.fromEntries([first, second].map(run => [run.requestId, { sessionPath: descriptor, creationSessionId: session, runId: run.id }])) }));
    let current = "", loseBegin = false, loseEnd = false, endCalls = 0;
    const worker = { async invoke(_cap: string, op: string, input: JsonValue) {
      const body = input as Record<string, string>;
      if (op === "veya.playtest.begin") {
        current = "test_owned";
        if (loseBegin) throw new Error("lost response");
        return { operation_id: "op_begin", status: "queued" };
      }
      if (op === "veya.operation.status") return { status: "succeeded", result: { ok: true, data: { playtest_id: current } } };
      if (op === "veya.world.status") return { playtest_id: current };
      if (op === "veya.playtest.end") {
        ++endCalls; assert.equal(body.playtest_id, "test_owned");
        assert.match(body.request_id!, /^[a-f0-9-]{36}$/u); current = "";
        if (loseEnd) throw new Error("lost response");
        return { playtest_id: "" };
      }
      throw new Error(op);
    } };
    const bindings = new VeyaCreatorBindings(root), get = (id: string) => runs.get(id)!;
    let lifecycle = new VeyaCreatorLifecycle(bindings, get, worker);
    const invoke = (op: string, body: JsonValue, runId = child.id) => lifecycle.invoke(capability, op, body, new AbortController().signal, { runId });
    await invoke("veya.playtest.begin", { request_id: randomUUID() });
    await invoke("veya.operation.status", { operation_id: "op_begin" });
    assert.equal((await readCreatorLeases(root)).leases[session]?.rootRunId, first.id);
    await assert.rejects(invoke("veya.playtest.begin", { request_id: randomUUID() }, second.id), /lease_busy/u);
    await lifecycle.markCancelling(second.id); await lifecycle.cleanup(second.id);
    assert.equal(endCalls, 0, "a different root cannot end the owned test");
    lifecycle = new VeyaCreatorLifecycle(bindings, get, worker); // Persisted ownership survives host restart.
    await lifecycle.markCancelling(first.id);
    current = "test_someone_else";
    await assert.rejects(lifecycle.cleanup(first.id), /cleanup_needs_attention/u);
    assert.equal(endCalls, 0); assert.equal((await readCreatorLeases(root)).leases[session]?.state, "needs_attention");
    current = "test_owned"; loseEnd = true;
    await assert.rejects(lifecycle.cleanup(first.id), /cleanup_needs_attention/u);
    assert.equal(endCalls, 1);
    await lifecycle.cleanup(first.id); // Read empty test before deciding whether to replay end.
    assert.equal(endCalls, 1); assert.equal((await readCreatorLeases(root)).leases[session], undefined);
    loseEnd = false;
    await invoke("veya.playtest.begin", { request_id: randomUUID() });
    await lifecycle.markCancelling(first.id);
    await lifecycle.cleanup(first.id); // The persisted operation proves ownership before any Flow polling.
    assert.equal(endCalls, 2); assert.equal((await readCreatorLeases(root)).leases[session], undefined);
    await invoke("veya.playtest.begin", { request_id: randomUUID() });
    await invoke("veya.operation.status", { operation_id: "op_begin" });
    await invoke("veya.playtest.end", { request_id: randomUUID(), playtest_id: "test_owned" });
    assert.equal(endCalls, 3); assert.equal((await readCreatorLeases(root)).leases[session], undefined);
    loseBegin = true;
    await assert.rejects(invoke("veya.playtest.begin", { request_id: randomUUID() }));
    await lifecycle.markCancelling(first.id);
    await assert.rejects(lifecycle.cleanup(first.id), /cleanup_needs_attention/u);
    assert.equal(endCalls, 3, "unknown begin outcome cannot claim the current test");
    assert.equal((await readCreatorLeases(root)).leases[session]?.state, "needs_attention");
  } finally { await rm(root, { recursive: true, force: true }); }
});
