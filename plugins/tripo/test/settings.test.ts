import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { BackendHost } from '@aura/plugin-sdk/backend';
import { GeneratedArtifacts } from '@aura/plugin-sdk/media';
import { TripoBudgetJournal } from '../backend/budget.ts';
import backend from '../backend/index.ts';
import type { TripoSettings } from '../shared/settings.ts';

test('Tripo page updates budget revisions without resetting paid reservations', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'aura-tripo-settings-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const artifacts = new GeneratedArtifacts(join(dataDir, 'assets'));
  const host = { dataDir, media: artifacts } as BackendHost;
  const local = await backend.open({ ...host, localConfiguration: true });
  const remote = await backend.open(host);
  assert.ok(local.invoke && remote.invoke);
  assert.deepEqual(local.pageOperations, ['settings', 'save-budget', 'check']);
  const call = { signal: new AbortController().signal };
  const read = async () =>
    (await local.invoke!('settings', null, call)) as TripoSettings;
  const initial = await read();
  assert.equal(initial.localConfiguration, true);
  assert.deepEqual(initial.budget, {
    revision: '0',
    budget: null,
    invalid: false,
  });
  assert.equal('key' in initial.connection, false);
  const budget = {
    unlimited: false,
    maxCredits: 25,
    imageStageCredits: 3,
    modelStageCredits: 5,
    maxScopeCredits: 10,
    cloudStageCredits: 4,
  };
  await assert.rejects(
    Promise.resolve(
      remote.invoke('save-budget', { revision: '0', budget }, call),
    ),
    /tripo_settings_forbidden/u,
  );
  assert.equal(
    ((await remote.invoke('settings', null, call)) as TripoSettings).budget,
    null,
  );
  await assert.rejects(
    Promise.resolve(
      local.invoke(
        'save-budget',
        { revision: '0', budget: { ...budget, maxCredits: 0 } },
        call,
      ),
    ),
    /tripo_budget_invalid/u,
  );
  await assert.rejects(readFile(join(dataDir, 'budget.json')), {
    code: 'ENOENT',
  });
  await local.invoke('save-budget', { revision: '0', budget }, call);
  const saved = (await read()).budget!;
  assert.deepEqual(saved.budget, budget);
  const paid = new TripoBudgetJournal(dataDir, { prompt: 'fixture' });
  await paid.prepare('http', 'model');
  await paid.submitted('http', 'fixture-task');
  const ledgerPath = join(dataDir, 'paid.json');
  const ledger = await readFile(ledgerPath, 'utf8');
  await assert.rejects(
    Promise.resolve(
      local.invoke('save-budget', { revision: '0', budget }, call),
    ),
    /tripo_budget_stale/u,
  );
  await local.invoke(
    'save-budget',
    { revision: saved.revision, budget: { ...budget, maxCredits: 8 } },
    call,
  );
  assert.equal(await readFile(ledgerPath, 'utf8'), ledger);
  await assert.rejects(
    new TripoBudgetJournal(dataDir, { prompt: 'new fixture' }).prepare(
      'http',
      'model',
    ),
    /credit limit would be exceeded/u,
  );
  await writeFile(join(dataDir, 'budget.json'), '{');
  const invalid = (await read()).budget!;
  assert.equal(invalid.invalid, true);
  await local.invoke(
    'save-budget',
    { revision: invalid.revision, budget },
    call,
  );
  assert.deepEqual((await read()).budget?.budget, budget);
});
