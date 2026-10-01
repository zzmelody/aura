import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TripoBudgetJournal } from "../src/tripo-budget.ts";

test("paid stage reserves before submission and resumes only from a known task ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "aura-paid-budget-"));
  try {
    const directory = join(root, ".aura");
    await mkdir(directory);
    await writeFile(join(directory, "world-agent-budget.json"), JSON.stringify({
      schemaVersion: 1, maxCredits: 8, imageStageCredits: 3, modelStageCredits: 5,
    }));
    const output = join(root, "assets", "generated");
    const request = { prompt: "bridge", id: randomUUID() };
    const first = new TripoBudgetJournal(output, request);
    assert.equal(await first.prepare("front", "image"), undefined);
    await assert.rejects(first.prepare("front", "image"), /unknown result/u);
    await assert.rejects(new TripoBudgetJournal(output, { prompt: "different" }).prepare("front", "image"), /unknown result/u);
    const stable = new TripoBudgetJournal(output, { prompt: "bridge" }, first.key);
    await assert.rejects(stable.result(), /identity conflict/u);
    await first.submitted("front", "task-front");
    const resumed = new TripoBudgetJournal(output, request);
    assert.equal(await first.prepare("front", "image"), "task-front");
    assert.equal(await resumed.prepare("front", "image"), "task-front");
    await first.completed("front", 2);
    assert.equal(await first.prepare("model", "model"), undefined);
    await first.submitted("model", "task-model");
    await first.completed("model", 5);
    await assert.rejects(first.prepare("left", "image"), /limit would be exceeded/u);
    const persisted = JSON.parse(await readFile(join(directory, "world-agent-paid.json"), "utf8"));
    assert.equal(persisted.requests[first.key].stages.model.taskId, "task-model");
    assert.equal(await resumed.result(), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("missing project budget fails before any paid task is admitted", async () => {
  const root = await mkdtemp(join(tmpdir(), "aura-paid-budget-"));
  try {
    const journal = new TripoBudgetJournal(join(root, "assets", "generated"), { prompt: "tree" });
    await assert.rejects(journal.prepare("front", "image"), /not configured/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an overcharged stage is recorded and blocks later paid submissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "aura-paid-budget-"));
  try {
    const directory = join(root, ".aura");
    await mkdir(directory);
    await writeFile(join(directory, "world-agent-budget.json"), JSON.stringify({
      schemaVersion: 1, maxCredits: 20, imageStageCredits: 3, modelStageCredits: 5,
    }));
    const journal = new TripoBudgetJournal(join(root, "assets", "generated"), { prompt: "bridge" });
    await journal.prepare("front", "image");
    await journal.submitted("front", "task-front");
    await assert.rejects(journal.completed("front", 4), /more than the configured stage ceiling/u);
    await assert.rejects(journal.prepare("left", "image"), /exceeded its reserved credit ceiling/u);
    const persisted = JSON.parse(await readFile(join(directory, "world-agent-paid.json"), "utf8"));
    assert.equal(persisted.requests[journal.key].stages.front.actual, 4);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a custom output directory keeps its budget beside that directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "aura-paid-budget-"));
  try {
    const output = join(root, "custom-output");
    const journal = new TripoBudgetJournal(output, { prompt: "bridge" });
    assert.equal(journal.directory, join(root, ".aura"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("creation budget survives worker replacement and shares model/cloud reservations", async () => {
  const root = await mkdtemp(join(tmpdir(), "aura-paid-budget-"));
  try {
    await mkdir(join(root, ".aura"));
    const config = { schemaVersion: 1, accountingUnit: "tripo_credits", maxCredits: 50,
      maxCreationCredits: 6, imageStageCredits: 3, modelStageCredits: 5, cloudStageCredits: 4 };
    await writeFile(join(root, ".aura", "world-agent-budget.json"), JSON.stringify(config));
    const creation = { projectRoot: root, creationId: randomUUID() };
    const first = new TripoBudgetJournal(join(root, "worker-a", "generated"), { prompt: "a" }, "a", creation);
    await first.prepare("front", "image"); await first.submitted("front", "paid-a"); await first.completed("front", 3);
    const second = new TripoBudgetJournal(join(root, "worker-b", "generated"), { prompt: "b" }, "b", creation);
    assert.equal(second.directory, first.directory);
    await assert.rejects(second.prepare("cloud", "cloud"), /Creation credit limit/u);
    await writeFile(join(root, ".aura", "world-agent-budget.json"), JSON.stringify({ ...config, maxCreationCredits: 20, accountingUnit: "usd" }));
    await assert.rejects(second.prepare("cloud", "cloud"), /accounting unit/u);
    await first.costUnknown("front");
    await assert.rejects(second.prepare("model", "model"), /unknown result/u);
    await first.completed("front", 2);
    await second.prepare("model", "model");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("creator monetary policy defaults unlimited without inventing prices; unknown outcomes still stop work", async () => {
  const root = await mkdtemp(join(tmpdir(), "aura-paid-budget-"));
  try {
    const creation = { projectRoot: root, creationId: randomUUID() };
    const first = new TripoBudgetJournal(join(root, "worker"), { prompt: "unlimited" }, "first", creation);
    const second = new TripoBudgetJournal(join(root, "other-worker"), { prompt: "next" }, "second", creation);
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
    const ledger = JSON.parse(await readFile(join(root, ".aura", "world-agent-paid.json"), "utf8"));
    assert.equal(ledger.requests[first.key].stages.model.unlimited, true);
    assert.equal(ledger.requests[first.key].stages.model.reserved, 0);
    assert.equal(ledger.requests[first.key].stages.model.actual, 1_000_000);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("linked recovery retains the original paid identity and refuses all new paid stages", async () => {
  const root = await mkdtemp(join(tmpdir(), "aura-paid-recovery-"));
  try {
    const creation = { projectRoot: root, creationId: randomUUID() };
    const original = new TripoBudgetJournal(join(root, "worker-a"), { prompt: "plaque" }, "asset", creation);
    await original.prepare("front", "image"); await original.submitted("front", "existing-task");
    await original.completed("front", 10);
    const recovery = new TripoBudgetJournal(join(root, "worker-b"), { prompt: "plaque" }, "asset",
      { ...creation, paidWorkForbidden: true });
    assert.equal(recovery.key, original.key);
    assert.equal(await recovery.prepare("front", "image"), "existing-task");
    await assert.rejects(recovery.prepare("model", "model"), /cannot start new paid work/u);
    const newKey = new TripoBudgetJournal(join(root, "worker-b"), { prompt: "other" }, "other",
      { ...creation, paidWorkForbidden: true });
    await assert.rejects(newKey.prepare("front", "image"), /cannot start new paid work/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
