import {
  retainErrorTranslations,
  tripoErrorMessages,
  type TripoErrorKey,
} from '../shared/error-messages.ts';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FlowError } from '@aura/plugin-sdk/errors';
import { z } from '@aura/plugin-sdk/flow';
import type { BudgetSettings } from '../shared/settings.ts';

const credits = z.number().positive().max(1_000_000);
const ceilings = {
  maxCredits: credits,
  imageStageCredits: credits,
  modelStageCredits: credits,
  maxScopeCredits: credits.optional(),
  cloudStageCredits: credits.optional(),
};
const fileBudget = z.union([
  z.object({
    schemaVersion: z.literal(1),
    unlimited: z.literal(true),
    accountingUnit: z.literal('tripo_credits'),
  }),
  z.object({
    schemaVersion: z.literal(1),
    unlimited: z.literal(false).optional(),
    accountingUnit: z.string().optional(),
    ...ceilings,
  }),
]);
export type BudgetConfig = {
  unlimited?: boolean;
  accountingUnit?: string;
  maxCredits?: number;
  imageStageCredits?: number;
  modelStageCredits?: number;
  maxScopeCredits?: number;
  cloudStageCredits?: number;
};

const saveBudget = z.strictObject({
  revision: z.string().max(64),
  budget: z.discriminatedUnion('unlimited', [
    z.strictObject({ unlimited: z.literal(true) }),
    z.strictObject({ unlimited: z.literal(false), ...ceilings }),
  ]),
});

export class TripoBudgetError extends Error {
  constructor(message: string, key: TripoErrorKey = 'ledgerInvalid') {
    super(message);
    this.name = 'TripoBudgetError';
    retainErrorTranslations(this, tripoErrorMessages(key));
  }
}

export async function withBudgetLock<T>(
  directory: string,
  work: () => Promise<T>,
): Promise<T> {
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'paid.lock');
  let lock;
  try {
    lock = await open(path, 'wx');
  } catch {
    throw new TripoBudgetError(
      'Tripo ledger is locked or requires recovery; no paid request submitted.',
      'ledgerLocked',
    );
  }
  try {
    return await work();
  } finally {
    await lock.close();
    await rm(path, { force: true });
  }
}

async function readBudgetFile(directory: string) {
  const path = join(directory, 'budget.json');
  const bytes = await readFile(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!bytes) return { revision: '0', config: null, invalid: false };
  const revision = createHash('sha256').update(bytes).digest('hex');
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { revision, config: null, invalid: true };
  }
  const parsed = fileBudget.safeParse(value);
  return parsed.success
    ? { revision, config: parsed.data, invalid: false }
    : { revision, config: null, invalid: true };
}

export async function readBudgetConfig(
  directory: string,
): Promise<BudgetConfig> {
  const { config, invalid } = await readBudgetFile(directory);
  if (config) return config;
  throw new TripoBudgetError(
    invalid
      ? 'Tripo budget is missing or invalid; no paid request submitted.'
      : 'Tripo budget is not configured; no paid request submitted.',
    'budgetMissing',
  );
}

export async function readBudgetSettings(
  directory: string,
): Promise<BudgetSettings> {
  const { revision, config, invalid } = await readBudgetFile(directory);
  if (!config) return { revision, invalid, budget: null };
  if (config.unlimited)
    return { revision, invalid, budget: { unlimited: true } };
  const {
    maxCredits,
    imageStageCredits,
    modelStageCredits,
    maxScopeCredits,
    cloudStageCredits,
  } = config;
  return {
    revision,
    invalid,
    budget: {
      unlimited: false,
      maxCredits,
      imageStageCredits,
      modelStageCredits,
      ...(maxScopeCredits === undefined ? {} : { maxScopeCredits }),
      ...(cloudStageCredits === undefined ? {} : { cloudStageCredits }),
    },
  };
}

export async function saveBudgetSettings(directory: string, input: unknown) {
  const parsed = saveBudget.safeParse(input);
  if (!parsed.success) throw new FlowError('tripo_budget_invalid', 400);
  const { revision, budget } = parsed.data;
  return withBudgetLock(directory, async () => {
    const current = await readBudgetSettings(directory);
    if (revision !== current.revision) {
      throw new FlowError('tripo_budget_stale', 409);
    }
    const path = join(directory, 'budget.json');
    const contents = JSON.stringify({
      schemaVersion: 1,
      accountingUnit: 'tripo_credits',
      ...budget,
    });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, contents, { flag: 'wx', mode: 0o600 });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
    return {
      revision: createHash('sha256').update(contents).digest('hex'),
      budget,
      invalid: false,
    };
  });
}
