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
