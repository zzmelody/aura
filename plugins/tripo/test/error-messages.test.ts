import assert from 'node:assert/strict';
import test from 'node:test';
import {
  tripoErrorMessages,
  tripoStageMessages,
  tripoErrorTranslations,
} from '../shared/error-messages.ts';
import { TripoBudgetError } from '../backend/budget-config.ts';
import { TripoGameAssetError } from '../backend/game-asset.ts';

test('Tripo failures own six literal translations without adding them to serialized errors or changing legacy messages', () => {
  const budget = new TripoBudgetError(
    'original budget refusal',
    'resultUnknown',
  );
  const stage = new TripoGameAssetError(
    'generate-left',
    'timeout',
    'original timeout',
    { display: { seconds: 90 } },
  );
  assert.equal(budget.message, 'original budget refusal');
  assert.match(stage.message, /original timeout/u);
  for (const error of [budget, stage]) {
    const translations = tripoErrorTranslations(error)!;
    assert.equal(Object.keys(translations).length, 6);
    assert.equal(new Set(Object.values(translations)).size, 6);
    assert.equal(JSON.stringify(error).includes(translations.en), false);
  }
  for (const locale of ['zh-CN', 'en', 'ja', 'ko', 'ru', 'fr'] as const) {
    assert.ok(tripoErrorTranslations(stage)![locale]!.includes('90'));
    assert.equal(
      tripoStageMessages('publish-output', 'local-io', {
        retainedMissing: true,
      })[locale]!.includes('undefined'),
      false,
    );
    assert.notEqual(
      tripoErrorMessages('creditLimit')[locale],
      tripoErrorMessages('scopeCreditLimit')[locale],
    );
  }
  assert.equal(
    tripoErrorTranslations(new Error('custom plugin advice')),
    undefined,
  );
});
