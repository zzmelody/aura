import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ActionFailure } from '@aura/plugin-sdk/action';
import { GeneratedArtifacts, sharp } from '@aura/plugin-sdk/media';
import { TripoAssetService } from '../backend/asset-service.ts';
import {
  TripoGameAssetError,
  type TripoGameAssetRequest,
} from '../backend/game-asset.ts';

const asset = (directory: string) => ({
  outputDirectory: directory,
  modelPath: join(directory, 'model.glb'),
  imagePaths: {
    front: 'front.png',
    left: 'left.png',
    back: 'back.png',
    right: 'right.png',
  },
  manifestPath: 'manifest.json',
  taskIds: { front: 'f', left: 'l', back: 'b', right: 'r', model: 'm' },
  creditsConsumed: 50,
  imageModel: 'chat_image_2.5_sunburst' as const,
  modelVersion: 'P1-20260311' as const,
  faceLimit: 12_000,
});

async function scratch(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'aura-tripo-capability-'));
  try {
    const directory = join(root, 'tripo');
    await mkdir(directory);
    await writeFile(
      join(directory, 'budget.json'),
      JSON.stringify({
        schemaVersion: 1,
        unlimited: true,
        accountingUnit: 'tripo_credits',
      }),
    );
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('Tripo model generation journals paid work, defaults its output and never returns host paths', () =>
  scratch(async (root) => {
    const calls: TripoGameAssetRequest[] = [];
    const secret = join(root, 'private-registration-detail');
    const tripo = new TripoAssetService({
      tripo: {
        async generateGameAsset(input) {
          calls.push(input);
          return asset(input.outputDirectory);
        },
      },
      ledgerDirectory: join(root, 'tripo'),
      artifacts: {
        async registerModel() {
          throw new Error(secret);
        },
        async put() {
          throw new Error('unused');
        },
      },
    });
    const signal = new AbortController().signal;
    const result = (await tripo.invoke(
      'generate',
      {
        prompt: 'a low-poly wooden crate',
        faceLimit: 12_000,
        scope: { id: 'creation-1' },
      },
      signal,
    )) as Record<string, unknown>;
    assert.equal(calls[0]!.outputDirectory, join(root, 'tripo', 'models'));
    assert.equal(result.faceLimit, 12_000);
    assert.equal(
      JSON.stringify(result).includes('private-registration-detail'),
      false,
    );
    assert.equal(JSON.stringify(result).includes('model.glb'), false);
    assert.equal(
      (result.artifactRegistration as { code: string }).code,
      'artifact_registration_failed',
    );
    await assert.rejects(
      tripo.invoke(
        'generate',
        { prompt: 'crate', outputDirectory: 'relative/dir' },
        signal,
      ),
      /invalid_tripo_request/u,
    );
    await assert.rejects(
      tripo.invoke('unknown', {}, signal),
      /unsupported_operation/u,
    );
  }));

test('Tripo failures become bounded Action failures', () =>
  scratch(async (root) => {
    const failing = new TripoAssetService({
      tripo: {
        async generateGameAsset() {
          throw new TripoGameAssetError(
            'generate-left',
            'timeout',
            '等待超过 90 秒，请勿立即重复提交。',
          );
        },
      },
      ledgerDirectory: join(root, 'tripo'),
    });
    await assert.rejects(
      failing.invoke(
        'generate',
        { prompt: 'crate', scope: { id: 'c' } },
        new AbortController().signal,
      ),
      (error: unknown) => {
        assert.ok(error instanceof ActionFailure);
        assert.equal(error.code, 'ACTION_FAILURE');
        assert.equal(
          error.message,
          '模型生成未完成 · 生成左视图：等待超过 90 秒，请勿立即重复提交。',
        );
        return true;
      },
    );
  }));

test('Tripo image generation stores one paid PNG, reuses it, and refuses new paid work under noNewPaidWork', () =>
  scratch(async (root) => {
    const png = await sharp({
      create: {
        width: 512,
        height: 512,
        channels: 4,
        background: { r: 155, g: 155, b: 155, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    let calls = 0;
    const artifacts = new GeneratedArtifacts(join(root, 'store'));
    const tripo = new TripoAssetService({
      tripo: {
        async generateGameAsset() {
          throw new Error('unused');
        },
        async generateCloudImage(_input, _signal, journal) {
          calls++;
          await journal?.submitted('paid-1');
          return {
            bytes: png,
            taskId: 'paid-1',
            creditsConsumed: 1.25,
            actualModel: 'chat_image_2.5_flare',
          };
        },
      },
      ledgerDirectory: join(root, 'tripo'),
      artifacts,
    });
    const signal = new AbortController().signal;
    const input = {
      prompt: 'abstract cloud mask',
      generationKey: 'c'.repeat(64),
      scope: { id: 'creation-2' },
    };
    const first = (await tripo.invoke('image', input, signal)) as Record<
      string,
      unknown
    >;
    assert.deepEqual(
      [first.status, first.width, first.height, first.creditsConsumed],
      ['ready', 512, 512, 1.25],
    );
    const again = (await tripo.invoke(
      'image',
      { ...input, scope: { id: 'creation-2', noNewPaidWork: true } },
      signal,
    )) as Record<string, unknown>;
    assert.equal(again.artifactId, first.artifactId);
    assert.equal(calls, 1);
    assert.deepEqual(
      (await artifacts.read(first.artifactId as string, signal)).bytes,
      png,
    );
    await assert.rejects(
      tripo.invoke(
        'image',
        { prompt: 'another', scope: { id: 'creation-2', noNewPaidWork: true } },
        signal,
      ),
      /cannot start new paid requests/u,
    );
    const view = (await tripo.invoke(
      'ledger',
      { scope: 'creation-2' },
      signal,
    )) as { requests: Array<{ key: string }> };
    assert.deepEqual(
      view.requests.map((request) => request.key),
      ['c'.repeat(64)],
    );
  }));
