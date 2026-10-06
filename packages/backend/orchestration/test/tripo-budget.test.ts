import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TripoBudgetJournal } from "../src/tripo-budget.ts";

async function ledger(run: (directory: string) => Promise<void>, budget?: object) {
  const root = await mkdtemp(join(tmpdir(), "aura-paid-budget-"));
  const directory = join(root, "tripo");
  try {
    if (budget) {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "budget.json"), JSON.stringify(budget));
    }
    await run(directory);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("paid stage reserves before submission and resumes only from a known task ID", () => ledger(async (directory) => {
  const request = { prompt: "bridge", id: randomUUID() };
  const first = new TripoBudgetJournal(directory, request);
  assert.equal(await first.prepare("front", "image"), undefined);
  await assert.rejects(first.prepare("front", "image"), /unknown result/u);
  await assert.rejects(new TripoBudgetJournal(directory, { prompt: "different" }).prepare("front", "image"), /unknown result/u);
  const stable = new TripoBudgetJournal(directory, { prompt: "bridge" }, first.key);
  await assert.rejects(stable.result(), /identity conflict/u);
  await first.submitted("front", "task-front");
  const resumed = new TripoBudgetJournal(directory, request);
  assert.equal(await first.prepare("front", "image"), "task-front");
  assert.equal(await resumed.prepare("front", "image"), "task-front");
  await first.completed("front", 2);
  assert.equal(await first.prepare("model", "model"), undefined);
  await first.submitted("model", "task-model");
  await first.completed("model", 5);
  await assert.rejects(first.prepare("left", "image"), /limit would be exceeded/u);
  const persisted = JSON.parse(await readFile(join(directory, "paid.json"), "utf8"));
  assert.equal(persisted.requests[first.key].stages.model.taskId, "task-model");
  assert.equal(await resumed.result(), undefined);
}, { schemaVersion: 1, maxCredits: 8, imageStageCredits: 3, modelStageCredits: 5 }));

test("unscoped work without a budget fails before any paid task is admitted", () => ledger(async (directory) => {
  await assert.rejects(new TripoBudgetJournal(directory, { prompt: "tree" }).prepare("front", "image"), /not configured/u);
}));

test("an overcharged stage is recorded and blocks later paid submissions", () => ledger(async (directory) => {
  const journal = new TripoBudgetJournal(directory, { prompt: "bridge" });
  await journal.prepare("front", "image");
  await journal.submitted("front", "task-front");
  await assert.rejects(journal.completed("front", 4), /more than the configured stage ceiling/u);
  await assert.rejects(journal.prepare("left", "image"), /exceeded its reserved credit ceiling/u);
  const persisted = JSON.parse(await readFile(join(directory, "paid.json"), "utf8"));
  assert.equal(persisted.requests[journal.key].stages.front.actual, 4);
}, { schemaVersion: 1, maxCredits: 20, imageStageCredits: 3, modelStageCredits: 5 }));

test("a scope ceiling spans all of the scope's requests and shares model/cloud reservations", () => ledger(async (directory) => {
  const config = { schemaVersion: 1, accountingUnit: "tripo_credits", maxCredits: 50,
    maxScopeCredits: 6, imageStageCredits: 3, modelStageCredits: 5, cloudStageCredits: 4 };
  const scope = { id: randomUUID() };
  const first = new TripoBudgetJournal(directory, { prompt: "a" }, "a", scope);
  await first.prepare("front", "image"); await first.submitted("front", "paid-a"); await first.completed("front", 3);
  const second = new TripoBudgetJournal(directory, { prompt: "b" }, "b", scope);
  await assert.rejects(second.prepare("cloud", "cloud"), /Per-scope credit limit/u);
  await writeFile(join(directory, "budget.json"), JSON.stringify({ ...config, maxScopeCredits: 20, accountingUnit: "usd" }));
  await assert.rejects(second.prepare("cloud", "cloud"), /accounting unit/u);
  await first.costUnknown("front");
  await assert.rejects(second.prepare("model", "model"), /unknown result/u);
  await first.completed("front", 2);
  await second.prepare("model", "model");
}, { schemaVersion: 1, accountingUnit: "tripo_credits", maxCredits: 50,
  maxScopeCredits: 6, imageStageCredits: 3, modelStageCredits: 5, cloudStageCredits: 4 }));

test("scoped work defaults to unlimited without inventing prices; unknown outcomes still stop work", () => ledger(async (directory) => {
  const scope = { id: randomUUID() };
  const first = new TripoBudgetJournal(directory, { prompt: "unlimited" }, "first", scope);
  const second = new TripoBudgetJournal(directory, { prompt: "next" }, "second", scope);
  assert.notEqual(first.workId.slice(0, 32), second.workId.slice(0, 32));
  await first.prepare("model", "model");
  await assert.rejects(second.prepare("cloud", "cloud"), /unknown result/u);
  await first.submitted("model", "paid-model");
  await first.completed("model", 1_000_000);
  await second.prepare("cloud", "cloud");
  await second.submitted("cloud", "paid-cloud");
  await second.costUnknown("cloud");
  await assert.rejects(first.prepare("front", "image"), /unknown result/u);
  await second.completed("cloud", 2_000_000);
  await first.prepare("front", "image");
  const persisted = JSON.parse(await readFile(join(directory, "paid.json"), "utf8"));
  assert.equal(persisted.requests[first.key].stages.model.unlimited, true);
  assert.equal(persisted.requests[first.key].stages.model.reserved, 0);
  assert.equal(persisted.requests[first.key].stages.model.actual, 1_000_000);
}));

test("noNewPaidWork retains the original paid identity and refuses every new paid stage", () => ledger(async (directory) => {
  const scope = { id: randomUUID() };
  const original = new TripoBudgetJournal(directory, { prompt: "plaque" }, "asset", scope);
  await original.prepare("front", "image"); await original.submitted("front", "existing-task");
  await original.completed("front", 10);
  const recovery = new TripoBudgetJournal(directory, { prompt: "plaque" }, "asset", { ...scope, noNewPaidWork: true });
  assert.equal(recovery.key, original.key);
  assert.equal(await recovery.prepare("front", "image"), "existing-task");
  await assert.rejects(recovery.prepare("model", "model"), /cannot start new paid requests/u);
  const newKey = new TripoBudgetJournal(directory, { prompt: "other" }, "other", { ...scope, noNewPaidWork: true });
  await assert.rejects(newKey.prepare("front", "image"), /cannot start new paid requests/u);
}));

test("scopeLedger projects one scope and reports unreconciled work anywhere", () => ledger(async (directory) => {
  const mine = { id: randomUUID() }, other = { id: randomUUID() };
  const a = new TripoBudgetJournal(directory, { prompt: "a" }, "a".repeat(64), mine);
  await a.prepare("front", "image"); await a.submitted("front", "task-a"); await a.completed("front", 1);
  const b = new TripoBudgetJournal(directory, { prompt: "b" }, "b", other);
  await b.prepare("model", "model");
  const view = await TripoBudgetJournal.scopeLedger(directory, mine.id);
  assert.equal(view.unreconciled, true);
  assert.deepEqual(view.requests, [{ key: "a".repeat(64), stages: { front: { kind: "image", status: "completed", taskId: "task-a", actual: 1 } } }]);
  assert.deepEqual(await TripoBudgetJournal.scopeLedger(join(directory, "missing"), mine.id), { unreconciled: false, requests: [] });
}));
