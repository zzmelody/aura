import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { TripoGameAssetResult, TripoPaidTaskJournal } from "@aura/tripo";

type Stage = Parameters<TripoPaidTaskJournal["prepare"]>[0] | "cloud";
type Kind = Parameters<TripoPaidTaskJournal["prepare"]>[1] | "cloud";
export type CreationBudgetContext = { projectRoot: string; creationId: string; paidWorkForbidden?: boolean };
type BudgetConfig = { unlimited?: boolean; accountingUnit?: string; maxCredits?: number; imageStageCredits?: number; modelStageCredits?: number; maxCreationCredits?: number; cloudStageCredits?: number };
type CloudResult = { sha256: string; taskId: string; creditsConsumed: number | null; actualModel: string | null };
type Entry = { unlimited?: boolean; kind: Kind; status: "submitting" | "submitted" | "completed"; reserved: number; taskId?: string; actual?: number; actualUnknown?: boolean };
type Request = { creationId?: string; cloud?: CloudResult; fingerprint: string; stages: Partial<Record<Stage, Entry>>; result?: TripoGameAssetResult };
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
  readonly creation?: CreationBudgetContext;

  constructor(outputDirectory: string, fingerprintInput: unknown, stableKey?: string, creation?: CreationBudgetContext) {
    const root = resolve(outputDirectory);
    // Normal Veya roots end in assets/generated; custom standalone roots keep
    // their budget beside the selected output directory rather than in Aura's install.
    const projectRoot = basename(root).toLowerCase() === "generated" && basename(dirname(root)).toLowerCase() === "assets"
      ? dirname(dirname(root)) : dirname(root);
    this.creation = creation;
    this.directory = join(creation?.projectRoot ?? projectRoot, ".aura");
    this.fingerprint = createHash("sha256").update(JSON.stringify(fingerprintInput)).digest("hex");
    this.key = creation ? `${creation.creationId}:${stableKey ?? this.fingerprint}` : stableKey ?? this.fingerprint;
    this.workId = creation ? createHash("sha256").update(this.key).digest("hex") : this.key;
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
      const request = ledger.requests[this.key] ??= { fingerprint: this.fingerprint, ...(this.creation ? { creationId: this.creation.creationId } : {}), stages: {} };
      if (request.fingerprint !== this.fingerprint) throw new TripoBudgetError("Paid request identity conflict.");
      const prior = request.stages[stage];
      if (prior) {
        if (prior.kind !== kind) throw new TripoBudgetError("Paid stage kind changed during recovery.");
        if (!prior.taskId) throw new TripoBudgetError("Paid task submission has an unknown result; do not retry automatically.");
        return prior.taskId;
      }
      if (this.creation?.paidWorkForbidden) throw new TripoBudgetError("Recovered creation cannot start new paid work; reuse its retained artifacts.");
      if (Object.values(ledger.requests).some((item) => Object.values(item.stages).some((entry) => entry && (!entry.taskId || entry.actualUnknown))))
        throw new TripoBudgetError("Another paid task submission has an unknown result; reconcile the project ledger before any new paid request.");
      if (!config.unlimited && Object.values(ledger.requests).some((item) => Object.values(item.stages).some((entry) => entry?.actual !== undefined && !entry.unlimited && entry.actual > entry.reserved)))
        throw new TripoBudgetError("A paid stage exceeded its reserved credit ceiling; reconcile the project budget before any new paid request.");
      if (kind === "cloud" && config.accountingUnit !== "tripo_credits") throw new TripoBudgetError("Cloud accounting unit must explicitly be tripo_credits; no paid request submitted.");
      const reserved = config.unlimited ? 0 : kind === "cloud" ? config.cloudStageCredits : kind === "image" ? config.imageStageCredits : config.modelStageCredits;
      if (reserved === undefined || !Number.isFinite(reserved) || (!config.unlimited && reserved <= 0))
        throw new TripoBudgetError("Paid stage ceiling is not configured; no paid request submitted.");
      const used = Object.values(ledger.requests).reduce((total, item) => total +
        Object.values(item.stages).reduce((sum, value) => sum + (value?.actual ?? value?.reserved ?? 0), 0), 0);
      if (!config.unlimited && used + reserved > config.maxCredits!) throw new TripoBudgetError("Project Tripo credit limit would be exceeded; no paid request submitted.");
      if (this.creation && !config.unlimited) {
        if (!Number.isFinite(config.maxCreationCredits) || config.maxCreationCredits! <= 0)
          throw new TripoBudgetError("Creation credit ceiling is not configured; no paid request submitted.");
        const ownUsed = Object.values(ledger.requests).filter(item => item.creationId === this.creation!.creationId).reduce((sum, item) =>
          sum + Object.values(item.stages).reduce((total, entry) => total + (entry?.actual ?? entry?.reserved ?? 0), 0), 0);
        if (ownUsed + reserved > config.maxCreationCredits!) throw new TripoBudgetError("Creation credit limit would be exceeded; no paid request submitted.");
      }
      request.stages[stage] = { kind, status: "submitting", reserved, ...(config.unlimited ? { unlimited: true } : {}) };
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
      entry.actual = credits; entry.actualUnknown = false; entry.status = "completed";
      if (!entry.unlimited && credits > entry.reserved) throw new TripoBudgetError("Provider charged more than the configured stage ceiling; stop further paid work.");
    });
  }

  async costUnknown(stage: Stage): Promise<void> {
    await this.#transaction(async ledger => {
      const entry = ledger.requests[this.key]?.stages[stage];
      if (!entry?.taskId) throw new TripoBudgetError("Paid task cannot be reconciled.");
      entry.actualUnknown = true;
    });
  }

  async saveCloud(bytes: Uint8Array, result: Omit<CloudResult, "sha256">): Promise<void> {
    if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw new TripoBudgetError("Paid cloud bytes exceeded the bounded limit; do not regenerate.");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const directory = join(this.directory, "world-agent-cloud");
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${sha256}.png`);
    try { await writeFile(path, bytes, { flag: "wx" }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    await this.#transaction(async ledger => {
      const request = ledger.requests[this.key];
      if (!request || request.fingerprint !== this.fingerprint || request.stages.cloud?.taskId !== result.taskId)
        throw new TripoBudgetError("Paid cloud result cannot be reconciled.");
      request.cloud = { ...result, sha256 };
      if (result.creditsConsumed === null) request.stages.cloud.actualUnknown = true;
    });
  }

  async loadCloud(): Promise<(Omit<CloudResult, "sha256"> & { bytes: Uint8Array }) | undefined> {
    const result = await this.#transaction(async ledger => {
      const request = ledger.requests[this.key];
      if (request && request.fingerprint !== this.fingerprint) throw new TripoBudgetError("Paid request identity conflict.");
      if (request?.stages.cloud?.actual !== undefined && !request.stages.cloud.unlimited && request.stages.cloud.actual > request.stages.cloud.reserved) throw new TripoBudgetError("Cloud charge exceeded its reserved ceiling; reconcile before continuing.");
      return request?.cloud;
    });
    if (!result) return undefined;
    const bytes = await readFile(join(this.directory, "world-agent-cloud", `${result.sha256}.png`));
    if (bytes.length > 8 * 1024 * 1024 || createHash("sha256").update(bytes).digest("hex") !== result.sha256)
      throw new TripoBudgetError("Paid cloud bytes do not match their recorded hash; do not regenerate.");
    return { bytes, taskId: result.taskId, creditsConsumed: result.creditsConsumed, actualModel: result.actualModel };
  }

  async #transaction<T>(work: (ledger: Ledger, config: BudgetConfig) => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true });
    let config;
    try { config = JSON.parse(await readFile(join(this.directory, "world-agent-budget.json"), "utf8")); }
    catch (error) {
      if (this.creation && (error as NodeJS.ErrnoException).code === "ENOENT")
        config = { schemaVersion: 1, unlimited: true, accountingUnit: "tripo_credits" };
      else throw new TripoBudgetError("Project Tripo budget is not configured; no paid request submitted.");
    }
    if (config?.schemaVersion !== 1 || (config.unlimited !== undefined && typeof config.unlimited !== "boolean") ||
        (config.unlimited ? config.accountingUnit !== "tripo_credits" : ![config.maxCredits, config.imageStageCredits, config.modelStageCredits].every(
      (value) => typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1_000_000,
    ))) throw new TripoBudgetError("Project Tripo budget is missing or invalid; no paid request submitted.");
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
