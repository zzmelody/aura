import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { FlowRun } from "@aura/protocol/types";
import type { PropRecovery } from "../src/veya-creator-recovery.ts";
import { importPreparationReconciliation, preparationReconciliation } from "../src/veya-creator-reconciliation.ts";

// Durable recovery tests do not cover an operator-admitted native geometry
// diagnosis. A visual guess or unrelated resource cannot authorize recooking.
test("preparation reconciliation binds native byte hashes, failed candidate and retained source without exposing paths", async () => {
  const folder = await mkdtemp(join(tmpdir(), "aura-preparation-reconcile-"));
  try {
    const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
    const sources = (["raw", "visual", "collision"] as const).map(role => {
      const bytes = Buffer.from("fixture " + role);
      return { role, assetId: role, contentHash: sha(bytes), resourcePath: `res://assets/generated/test/${role}.scn`, bytes };
    });
    const candidateHash = "a".repeat(64), moduleHash = "b".repeat(64), receiptHash = "c".repeat(64), request = randomUUID();
    const recovery = { schemaVersion: 1, sourceRequestId: request, sourceRunId: randomUUID(), noNewPaidWork: true, repairRound: 1,
      propSpec: { id: "plaque", dimensions: [.26, .04, .16] }, retainedProp: { module: { module_id: moduleHash, content_hash: moduleHash } },
      preparation: { receiptHash, sourceBindings: [{ requirementId: "model", assetId: "raw", version: sources[0]!.contentHash }],
        preparedBindings: [{ requirementId: "model", assetId: "visual", version: sources[1]!.contentHash, collisionAssetId: "collision", collisionVersion: sources[2]!.contentHash }] } } as unknown as PropRecovery;
    const build = { flow: { id: "veya/veya-world-build" }, status: "completed", input: { contributions: [{ module: { module_id: moduleHash, content_hash: moduleHash } }] },
      output: { status: "ready", candidate: { contentHash: candidateHash } } } as unknown as FlowRun;
    const verify = { flow: { id: "veya/veya-world-verify" }, status: "completed", output: { contentHash: candidateHash, visual: "failed",
      defects: [{ severity: "error", owner: "assets", requirementId: "model", moduleId: "plaque" }] } } as unknown as FlowRun;
    const runs = [build, verify], report = Buffer.from(JSON.stringify({ kind: "serialized_resource_geometry", rendered: false,
      raw: { path: sources[0]!.resourcePath, min: [0, 0, 0], size: [.046, .3, .58] },
      prepared: { path: sources[1]!.resourcePath, min: [0, 0, 0], size: [.006, .04, .077] } }));
    assert.equal(await preparationReconciliation(folder, recovery, runs), undefined);
    await assert.rejects(importPreparationReconciliation(folder, recovery, [build], candidateHash, "model", report, sources));
    await assert.rejects(importPreparationReconciliation(folder, recovery, runs, "d".repeat(64), "model", report, sources));
    await assert.rejects(importPreparationReconciliation(folder, recovery, runs, candidateHash, "model", report,
      sources.map(source => source.role === "visual" ? { ...source, bytes: Buffer.from("changed") } : source)));
    await assert.rejects(importPreparationReconciliation(folder, { ...recovery, repairRound: 3 }, runs, candidateHash, "model", report, sources));
    await importPreparationReconciliation(folder, recovery, runs, candidateHash, "model", report, sources);
    await importPreparationReconciliation(folder, recovery, runs, candidateHash, "model", report, sources);
    const defects = await preparationReconciliation(folder, recovery, runs);
    assert.deepEqual(defects?.map(value => (value as Record<string, unknown>).code), ["prop_preparation_geometry"]);
    assert.doesNotMatch(JSON.stringify(defects), /res:\/\/|fixture raw|serialized_resource|reportHash/);
    assert.equal(recovery.repairRound, 1, "admission never resets or spends a coordinator round");
    const path = join(folder, ".aura", "veya-creator", "reconciliation", "blobs", sources[1]!.contentHash + ".bin");
    const bytes = await readFile(path); await writeFile(path, "tampered");
    await assert.rejects(preparationReconciliation(folder, recovery, runs)); await writeFile(path, bytes);
    await assert.rejects(preparationReconciliation(folder, { ...recovery, retainedProp: { module: { module_id: "d".repeat(64) } } }, runs));
  } finally { await rm(folder, { recursive: true, force: true }); }
});
