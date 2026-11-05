import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  TripoGameAssetResult,
  TripoPaidTaskJournal,
} from './game-asset.ts';

import {
  readBudgetConfig,
  TripoBudgetError,
  withBudgetLock,
  type BudgetConfig,
} from './budget-config.ts';
export { TripoBudgetError } from './budget-config.ts';

type Stage = Parameters<TripoPaidTaskJournal['prepare']>[0] | 'cloud' | 'http';
type Kind = Parameters<TripoPaidTaskJournal['prepare']>[1] | 'cloud';
/**
 * Caller-chosen accounting group for paid work, such as one creation. The ID is
 * opaque to Aura; `noNewPaidWork` lets a caller reuse retained results only.
 */
export type PaidScope = { id: string; noNewPaidWork?: boolean };
type CloudResult = {
  sha256: string;
  taskId: string;
  creditsConsumed: number | null;
  actualModel: string | null;
};
type Entry = {
  unlimited?: boolean;
  kind: Kind;
  status: 'submitting' | 'submitted' | 'completed';
  reserved: number;
  taskId?: string;
  actual?: number;
  actualUnknown?: boolean;
};
type Request = {
  scope?: string;
  cloud?: CloudResult;
  fingerprint: string;
  stages: Partial<Record<Stage, Entry>>;
  result?: TripoGameAssetResult;
};
type Ledger = { schemaVersion: 1; requests: Record<string, Request> };

/** Read-only projection of the ledger for one scope. */
export type PaidScopeLedger = {
  /** Some paid submission anywhere in the ledger has an unknown task or cost. */
  unreconciled: boolean;
  requests: Array<{
    key: string;
    stages: Partial<
      Record<
        Stage,
        Pick<Entry, 'kind' | 'status' | 'taskId' | 'actual' | 'actualUnknown'>
      >
    >;
  }>;
};

async function readLedger(directory: string): Promise<Ledger> {
  try {
    const ledger = JSON.parse(
      await readFile(join(directory, 'paid.json'), 'utf8'),
    ) as Ledger;
    if (
      ledger.schemaVersion !== 1 ||
      !ledger.requests ||
      typeof ledger.requests !== 'object'
    )
      throw new TripoBudgetError('Tripo ledger is invalid.');
    return ledger;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { schemaVersion: 1, requests: {} };
    throw error;
  }
}

/** A fail-closed paid-work ledger. The config is user-owned; model prompts never set limits. */
export class TripoBudgetJournal implements TripoPaidTaskJournal {
  readonly directory: string;
  readonly key: string;
  readonly fingerprint: string;
  readonly workId: string;
  readonly scope?: PaidScope;

  constructor(
    directory: string,
    fingerprintInput: unknown,
    stableKey?: string,
    scope?: PaidScope,
  ) {
    this.directory = directory;
    this.scope = scope;
    this.fingerprint = createHash('sha256')
      .update(JSON.stringify(fingerprintInput))
      .digest('hex');
    this.key = scope
      ? `${scope.id}:${stableKey ?? this.fingerprint}`
      : (stableKey ?? this.fingerprint);
    this.workId = scope
      ? createHash('sha256').update(this.key).digest('hex')
      : this.key;
  }

  static async hasPendingHttpTasks(directory: string): Promise<boolean> {
    const ledger = await readLedger(directory);
    return Object.values(ledger.requests).some(
      ({ stages }) =>
        stages.http?.status === 'submitted' && !stages.http.actualUnknown,
    );
  }

  static async settleHttpTask(
    directory: string,
    taskId: string,
    credits: unknown,
  ) {
    const findTask = (ledger: Ledger) =>
      Object.values(ledger.requests).find(
        ({ stages }) => stages.http?.taskId === taskId,
      )?.stages.http;
    const task = findTask(await readLedger(directory));
    if (!task || task.status === 'completed') return;
    await new TripoBudgetJournal(directory, {}).#transaction(async (ledger) => {
      const entry = findTask(ledger);
      if (!entry || entry.status === 'completed') return;
      if (
        typeof credits === 'number' &&
        Number.isFinite(credits) &&
        credits >= 0
      ) {
        entry.actual = credits;
        entry.actualUnknown = false;
        entry.status = 'completed';
      } else {
        entry.actualUnknown = true;
      }
    });
  }

  async result(): Promise<TripoGameAssetResult | undefined> {
    return this.#transaction(async (ledger) => {
      const request = ledger.requests[this.key];
      if (request && request.fingerprint !== this.fingerprint)
        throw new TripoBudgetError(
          'Paid request identity conflict; changed prompt cannot reuse or repay the same work key.',
        );
      return request?.result;
    });
  }

  async published(result: TripoGameAssetResult): Promise<void> {
    await this.#transaction(async (ledger) => {
      const request = ledger.requests[this.key];
      if (
        !request ||
        request.fingerprint !== this.fingerprint ||
        !request.stages.model?.taskId
      )
        throw new TripoBudgetError(
          'Paid model publication cannot be reconciled.',
        );
      request.result = result;
    });
  }

  async prepare(stage: Stage, kind: Kind): Promise<string | undefined> {
    return this.#transaction(async (ledger, config) => {
      // A refused reservation must leave the ledger unchanged, so a new request is attached only on success.
      const request = ledger.requests[this.key] ?? {
        fingerprint: this.fingerprint,
        ...(this.scope ? { scope: this.scope.id } : {}),
        stages: {},
      };
      if (request.fingerprint !== this.fingerprint)
        throw new TripoBudgetError('Paid request identity conflict.');
      const prior = request.stages[stage];
      if (prior) {
        if (prior.kind !== kind)
          throw new TripoBudgetError(
            'Paid stage kind changed during recovery.',
          );
        if (!prior.taskId)
          throw new TripoBudgetError(
            'Paid task submission has an unknown result; do not retry automatically.',
          );
        return prior.taskId;
      }
      if (this.scope?.noNewPaidWork)
        throw new TripoBudgetError(
          'This work cannot start new paid requests; reuse its retained results.',
        );
      if (
        Object.values(ledger.requests).some((item) =>
          Object.values(item.stages).some(
            (entry) => entry && (!entry.taskId || entry.actualUnknown),
          ),
        )
      )
        throw new TripoBudgetError(
          'Another paid task submission has an unknown result; reconcile the Tripo ledger before any new paid request.',
        );
      if (
        !config.unlimited &&
        Object.values(ledger.requests).some((item) =>
          Object.values(item.stages).some(
            (entry) =>
              entry?.actual !== undefined &&
              !entry.unlimited &&
              entry.actual > entry.reserved,
          ),
        )
      )
        throw new TripoBudgetError(
          'A paid stage exceeded its reserved credit ceiling; reconcile the Tripo budget before any new paid request.',
        );
      if (kind === 'cloud' && config.accountingUnit !== 'tripo_credits')
        throw new TripoBudgetError(
          'Cloud accounting unit must explicitly be tripo_credits; no paid request submitted.',
        );
      const reserved = config.unlimited
        ? 0
        : kind === 'cloud'
          ? config.cloudStageCredits
          : kind === 'image'
            ? config.imageStageCredits
            : config.modelStageCredits;
      if (
        reserved === undefined ||
        !Number.isFinite(reserved) ||
        (!config.unlimited && reserved <= 0)
      )
        throw new TripoBudgetError(
          'Paid stage ceiling is not configured; no paid request submitted.',
        );
      const spent = (item: Request) =>
        Object.values(item.stages).reduce(
          (sum, value) => sum + (value?.actual ?? value?.reserved ?? 0),
          0,
        );
      const used = Object.values(ledger.requests).reduce(
        (total, item) => total + spent(item),
        0,
      );
      if (!config.unlimited && used + reserved > config.maxCredits!)
        throw new TripoBudgetError(
          'Tripo credit limit would be exceeded; no paid request submitted.',
        );
      if (this.scope && !config.unlimited) {
        if (
          !Number.isFinite(config.maxScopeCredits) ||
          config.maxScopeCredits! <= 0
        )
          throw new TripoBudgetError(
            'Per-scope credit ceiling is not configured; no paid request submitted.',
          );
        const ownUsed = Object.values(ledger.requests)
          .filter((item) => item.scope === this.scope!.id)
          .reduce((sum, item) => sum + spent(item), 0);
        if (ownUsed + reserved > config.maxScopeCredits!)
          throw new TripoBudgetError(
            'Per-scope credit limit would be exceeded; no paid request submitted.',
          );
      }
      request.stages[stage] = {
        kind,
        status: 'submitting',
        reserved,
        ...(config.unlimited ? { unlimited: true } : {}),
      };
      ledger.requests[this.key] = request;
      return undefined;
    });
  }

  async submitted(stage: Stage, taskId: string): Promise<void> {
    await this.#transaction(async (ledger) => {
      const entry = ledger.requests[this.key]?.stages[stage];
      if (!entry || (entry.taskId && entry.taskId !== taskId))
        throw new TripoBudgetError('Paid task journal conflict.');
      entry.taskId = taskId;
      entry.status = 'submitted';
    });
  }

  async completed(stage: Stage, credits: number): Promise<void> {
    await this.#transaction(async (ledger) => {
      const entry = ledger.requests[this.key]?.stages[stage];
      if (!entry?.taskId || !Number.isFinite(credits) || credits < 0)
        throw new TripoBudgetError('Paid task cannot be reconciled.');
      entry.actual = credits;
      entry.actualUnknown = false;
      entry.status = 'completed';
      if (!entry.unlimited && credits > entry.reserved)
        throw new TripoBudgetError(
          'Provider charged more than the configured stage ceiling; stop further paid work.',
        );
    });
  }

  async costUnknown(stage: Stage): Promise<void> {
    await this.#transaction(async (ledger) => {
      const entry = ledger.requests[this.key]?.stages[stage];
      if (!entry?.taskId)
        throw new TripoBudgetError('Paid task cannot be reconciled.');
      entry.actualUnknown = true;
    });
  }

  async saveCloud(
    bytes: Uint8Array,
    result: Omit<CloudResult, 'sha256'>,
  ): Promise<void> {
    if (!bytes.length || bytes.length > 8 * 1024 * 1024)
      throw new TripoBudgetError(
        'Paid cloud bytes exceeded the bounded limit; do not regenerate.',
      );
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const directory = join(this.directory, 'cloud');
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${sha256}.png`);
    try {
      await writeFile(path, bytes, { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    await this.#transaction(async (ledger) => {
      const request = ledger.requests[this.key];
      if (
        !request ||
        request.fingerprint !== this.fingerprint ||
        request.stages.cloud?.taskId !== result.taskId
      )
        throw new TripoBudgetError('Paid cloud result cannot be reconciled.');
      request.cloud = { ...result, sha256 };
      if (result.creditsConsumed === null)
        request.stages.cloud.actualUnknown = true;
    });
  }

  async loadCloud(): Promise<
    | {
        bytes: Uint8Array;
        taskId: string;
        creditsConsumed: number | null;
        actualModel: string | null;
      }
    | undefined
  > {
    const result = await this.#transaction(async (ledger) => {
      const request = ledger.requests[this.key];
      if (request && request.fingerprint !== this.fingerprint)
        throw new TripoBudgetError('Paid cloud identity conflict.');
      return request?.cloud;
    });
    if (!result) return undefined;
    const bytes = await readFile(
      join(this.directory, 'cloud', `${result.sha256}.png`),
    );
    if (createHash('sha256').update(bytes).digest('hex') !== result.sha256)
      throw new TripoBudgetError(
        'Retained paid cloud bytes changed; do not regenerate.',
      );
    return {
      bytes,
      taskId: result.taskId,
      creditsConsumed: result.creditsConsumed,
      actualModel: result.actualModel,
    };
  }

  /** The entries of one scope plus whether any paid submission anywhere is unreconciled. */
  static async scopeLedger(
    directory: string,
    scope: string,
  ): Promise<PaidScopeLedger> {
    let ledger: Ledger;
    try {
      ledger = JSON.parse(await readFile(join(directory, 'paid.json'), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { unreconciled: false, requests: [] };
      throw new TripoBudgetError('Tripo ledger is unreadable.');
    }
    if (
      ledger?.schemaVersion !== 1 ||
      !ledger.requests ||
      typeof ledger.requests !== 'object'
    )
      throw new TripoBudgetError('Tripo ledger is invalid.');
    const requests = Object.entries(ledger.requests);
    return {
      unreconciled: requests.some(([, item]) =>
        Object.values(item.stages ?? {}).some(
          (entry) => entry && (!entry.taskId || entry.actualUnknown),
        ),
      ),
      requests: requests
        .filter(([, item]) => item.scope === scope)
        .map(([key, item]) => ({
          key: key.slice(scope.length + 1),
          stages: Object.fromEntries(
            Object.entries(item.stages ?? {}).map(([stage, entry]) => [
              stage,
              {
                kind: entry!.kind,
                status: entry!.status,
                ...(entry!.taskId ? { taskId: entry!.taskId } : {}),
                ...(entry!.actual !== undefined
                  ? { actual: entry!.actual }
                  : {}),
                ...(entry!.actualUnknown ? { actualUnknown: true } : {}),
              },
            ]),
          ),
        })),
    };
  }

  async #transaction<T>(
    work: (ledger: Ledger, config: BudgetConfig) => Promise<T>,
  ): Promise<T> {
    return withBudgetLock(this.directory, async () => {
      const config = await readBudgetConfig(this.directory);
      const path = join(this.directory, 'paid.json');
      const ledger = await readLedger(this.directory);
      const previous = JSON.stringify(ledger);
      let result: T | undefined;
      let failure: unknown;
      try {
        result = await work(ledger, config);
      } catch (error) {
        failure = error;
      }
      const updated = JSON.stringify(ledger);
      if (updated !== previous) {
        const temporary = path + '.' + randomUUID() + '.tmp';
        try {
          await writeFile(temporary, updated, { flag: 'wx', mode: 0o600 });
          await rename(temporary, path);
        } finally {
          await rm(temporary, { force: true });
        }
      }
      if (failure) throw failure;
      return result as T;
    });
  }
}
