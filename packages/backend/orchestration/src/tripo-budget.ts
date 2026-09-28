import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { TripoGameAssetResult, TripoPaidTaskJournal } from "@aura/tripo";

type Stage = Parameters<TripoPaidTaskJournal["prepare"]>[0];
type Kind = Parameters<TripoPaidTaskJournal["prepare"]>[1];
type Entry = { kind: Kind; status: "submitting" | "submitted" | "completed"; reserved: number; taskId?: string; actual?: number };
type Request = { fingerprint: string; stages: Partial<Record<Stage, Entry>>; result?: TripoGameAssetResult };
type Ledger = { schemaVersion: 1; requests: Record<string, Request> };

export class TripoBudgetError extends Error {
  constructor(message: string) { super(message); this.name = "TripoBudgetError"; }
}

/** A fail-closed project ledger. The config is user-owned; model prompts never set limits. */
export class TripoBudgetJournal implements TripoPaidTaskJournal {
  readonly directory: string;
  readonly key: string;
  readonly fingerprint: string;
  readonly workId: string;

  constructor(outputDirectory: string, fingerprintInput: unknown, stableKey?: string) {
    const root = resolve(outputDirectory);
    // Normal Veya roots end in assets/generated; custom standalone roots keep
    // their budget beside the selected output directory rather than in Aura's install.
    const projectRoot = basename(root).toLowerCase() === "generated" && basename(dirname(root)).toLowerCase() === "assets"
      ? dirname(dirname(root)) : dirname(root);
    this.directory = join(projectRoot, ".aura");
    this.fingerprint = createHash("sha256").update(JSON.stringify(fingerprintInput)).digest("hex");
    this.key = stableKey ?? this.fingerprint;
    this.workId = this.key;
  }

  async result(): Promise<TripoGameAssetResult | undefined> {
    return this.#transaction(async (ledger) => {
      const request = ledger.requests[this.key];
      if (request && request.fingerprint !== this.fingerprint) throw new TripoBudgetError("Paid request identity conflict; changed prompt cannot reuse or repay the same work key.");
      return request?.result;
    });
  }

  async published(result: TripoGameAssetResult): Promise<void> {
    await this.#transaction(async (ledger) => {
      const request = ledger.requests[this.key];
      if (!request || request.fingerprint !== this.fingerprint || !request.stages.model?.taskId)
        throw new TripoBudgetError("Paid model publication cannot be reconciled.");
      request.result = result;
    });
  }

  async prepare(stage: Stage, kind: Kind): Promise<string | undefined> {
    return this.#transaction(async (ledger, config) => {
      const request = ledger.requests[this.key] ??= { fingerprint: this.fingerprint, stages: {} };
      if (request.fingerprint !== this.fingerprint) throw new TripoBudgetError("Paid request identity conflict.");
      const prior = request.stages[stage];
      if (prior) {
        if (prior.kind !== kind) throw new TripoBudgetError("Paid stage kind changed during recovery.");
        if (!prior.taskId) throw new TripoBudgetError("Paid task submission has an unknown result; do not retry automatically.");
        return prior.taskId;
      }
      if (Object.values(ledger.requests).some((item) => Object.values(item.stages).some((entry) => entry && !entry.taskId)))
        throw new TripoBudgetError("Another paid task submission has an unknown result; reconcile the project ledger before any new paid request.");
      if (Object.values(ledger.requests).some((item) => Object.values(item.stages).some((entry) => entry?.actual !== undefined && entry.actual > entry.reserved)))
        throw new TripoBudgetError("A paid stage exceeded its reserved credit ceiling; reconcile the project budget before any new paid request.");
      const reserved = kind === "image" ? config.imageStageCredits : config.modelStageCredits;
      const used = Object.values(ledger.requests).reduce((total, item) => total +
        Object.values(item.stages).reduce((sum, value) => sum + (value?.actual ?? value?.reserved ?? 0), 0), 0);
      if (used + reserved > config.maxCredits) throw new TripoBudgetError("Project Tripo credit limit would be exceeded; no paid request submitted.");
      request.stages[stage] = { kind, status: "submitting", reserved };
      return undefined;
    });
  }

  async submitted(stage: Stage, taskId: string): Promise<void> {
    await this.#transaction(async (ledger) => {
      const entry = ledger.requests[this.key]?.stages[stage];
      if (!entry || (entry.taskId && entry.taskId !== taskId)) throw new TripoBudgetError("Paid task journal conflict.");
      entry.taskId = taskId; entry.status = "submitted";
    });
  }

  async completed(stage: Stage, credits: number): Promise<void> {
    await this.#transaction(async (ledger) => {
      const entry = ledger.requests[this.key]?.stages[stage];
      if (!entry?.taskId || !Number.isFinite(credits) || credits < 0) throw new TripoBudgetError("Paid task cannot be reconciled.");
      entry.actual = credits; entry.status = "completed";
      if (credits > entry.reserved) throw new TripoBudgetError("Provider charged more than the configured stage ceiling; stop further paid work.");
    });
  }

  async #transaction<T>(work: (ledger: Ledger, config: { maxCredits: number; imageStageCredits: number; modelStageCredits: number }) => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true });
    let config;
    try { config = JSON.parse(await readFile(join(this.directory, "world-agent-budget.json"), "utf8")); }
    catch { throw new TripoBudgetError("Project Tripo budget is not configured; no paid request submitted."); }
    if (config?.schemaVersion !== 1 || ![config.maxCredits, config.imageStageCredits, config.modelStageCredits].every(
      (value) => typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1_000_000,
    )) throw new TripoBudgetError("Project Tripo budget is missing or invalid; no paid request submitted.");
    const lockPath = join(this.directory, "world-agent-paid.lock");
    let lock;
    try { lock = await open(lockPath, "wx"); }
    catch { throw new TripoBudgetError("Project Tripo ledger is locked or requires recovery; no paid request submitted."); }
    try {
      const path = join(this.directory, "world-agent-paid.json");
      let ledger: Ledger;
      try { ledger = JSON.parse(await readFile(path, "utf8")); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        ledger = { schemaVersion: 1, requests: {} };
      }
      if (ledger.schemaVersion !== 1 || !ledger.requests || typeof ledger.requests !== "object")
        throw new TripoBudgetError("Project Tripo ledger is invalid; no paid request submitted.");
      let result: T | undefined, failure: unknown;
      try { result = await work(ledger, config); } catch (error) { failure = error; }
      const temporary = path + "." + randomUUID() + ".tmp";
      await writeFile(temporary, JSON.stringify(ledger), { flag: "wx" });
      await rename(temporary, path);
      if (failure) throw failure;
      return result as T;
    } finally {
      await lock.close();
      await rm(lockPath, { force: true });
    }
  }
}
