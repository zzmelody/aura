import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { BackendHost, PluginHttpHost } from '@aura/plugin-sdk/backend';
import { GeneratedArtifacts } from '@aura/plugin-sdk/media';
import backend from '../backend/index.ts';
import createTripoHttp from '../backend/http.ts';

test('Tripo HTTP uses plugin credentials, revision checks, and the paid ledger', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'aura-tripo-http-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const priorKey = process.env.TRIPO_API_KEY;
  const priorRegion = process.env.AURA_TRIPO_REGION;
  delete process.env.TRIPO_API_KEY;
  delete process.env.AURA_TRIPO_REGION;
  t.after(() => {
    if (priorKey !== undefined) process.env.TRIPO_API_KEY = priorKey;
    if (priorRegion !== undefined) process.env.AURA_TRIPO_REGION = priorRegion;
  });
  const artifacts = new GeneratedArtifacts(join(dataDir, 'artifacts'));
  const { requests } = await backend.open({
    dataDir,
    media: artifacts,
  } as BackendHost);
  assert.ok(requests);
  const host: PluginHttpHost = {
    localConfiguration: true,
    async request<T>(
      method: string,
      input: Record<string, unknown> = {},
      signal = new AbortController().signal,
    ) {
      return (await requests.handle(method, input, signal)) as T;
    },
    artifacts,
    artifactContent: async () => {
      throw new Error('Unexpected artifact request');
    },
  };
  const app = createTripoHttp(host);
  const fetchRoute = (path: string, init?: RequestInit) =>
    app.fetch(new Request(`http://localhost/tripo${path}`, init));
  const post = (path: string, body: unknown, requestId?: string) =>
    fetchRoute(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(requestId ? { 'Idempotency-Key': requestId } : {}),
      },
      body: JSON.stringify(body),
    });
  const initial = await (await fetchRoute('/status')).json();
  assert.equal(initial.configured, false);
  assert.equal(initial.revision, '0');
  const lan = createTripoHttp({ ...host, localConfiguration: false });
  assert.equal(
    (
      await lan.fetch(
        new Request('http://localhost/tripo/settings', { method: 'POST' }),
      )
    ).status,
    403,
  );
  assert.equal(
    (await post('/tasks/text-to-model', { prompt: 'Box' }, 'first')).status,
    503,
  );
  const updated = await post('/settings', {
    revision: initial.revision,
    region: 'china',
    key: 'fixture-secret',
  });
  assert.equal(updated.status, 200);
  const snapshot = await updated.text();
  assert.doesNotMatch(snapshot, /fixture-secret/);
  assert.equal(JSON.parse(snapshot).region, 'china');
  assert.equal(
    (await post('/settings', { revision: initial.revision, region: 'global' }))
      .status,
    409,
  );

  let submits = 0;
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string, init?: RequestInit) => {
      assert.match(input, /^https:\/\/openapi\.tripo3d\.com\/v3\//u);
      assert.equal(
        new Headers(init?.headers).get('authorization'),
        'Bearer fixture-secret',
      );
      if (input.endsWith('/account/balance'))
        return Response.json({ code: 0, data: { balance: 100 } });
      if (init?.method === 'POST') {
        submits++;
        const ledger = JSON.parse(
          await readFile(join(dataDir, 'paid.json'), 'utf8'),
        );
        const reservations = Object.values(ledger.requests).map(
          (request) =>
            (
              request as {
                stages: { http: { status: string; reserved: number } };
              }
            ).stages.http,
        );
        assert.ok(
          reservations.some(
            (entry) => entry.status === 'submitting' && entry.reserved === 5,
          ),
        );
        if (submits === 2) throw new Error('Fixture upstream response lost');
        return Response.json({ code: 0, data: { task_id: 'task-1' } });
      }
      return Response.json({
        code: 0,
        data: {
          task_id: 'task-1',
          type: 'text_to_model',
          status: 'success',
          credits_consumed: 3,
          output: {
            model_url: 'https://assets.example/model.glb',
            unknown_field: 'fixture-secret',
          },
        },
      });
    },
  );
  assert.equal((await post('/check', {})).status, 200);
  assert.equal(submits, 0);
  assert.equal(
    (await post('/tasks/text-to-model', { prompt: 'Box' }, 'first')).status,
    409,
  );
  await writeFile(
    join(dataDir, 'budget.json'),
    JSON.stringify({
      schemaVersion: 1,
      maxCredits: 10,
      imageStageCredits: 2,
      modelStageCredits: 5,
    }),
  );
  assert.equal(
    (await post('/tasks/text-to-model', { prompt: 'Box' })).status,
    400,
  );
  assert.equal(
    (
      await post(
        '/tasks/image-to-model',
        { image: { url: 'http://local/image.png' } },
        'invalid',
      )
    ).status,
    400,
  );
  for (const requestId of ['first', 'first']) {
    const response = await post(
      '/tasks/text-to-model',
      { prompt: 'Box' },
      requestId,
    );
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { taskId: 'task-1' });
  }
  assert.equal(submits, 1);
  assert.equal(
    (await post('/tasks/text-to-model', { prompt: 'Changed' }, 'first')).status,
    409,
  );
  assert.equal(
    (
      await post('/settings', {
        revision: JSON.parse(snapshot).revision,
        region: 'china',
        clearKey: true,
      })
    ).status,
    409,
  );
  const task = await fetchRoute('/tasks/task-1');
  assert.equal(task.status, 200);
  assert.doesNotMatch(await task.text(), /fixture-secret|unknown_field/);
  assert.match(
    await readFile(join(dataDir, 'paid.json'), 'utf8'),
    /"actual":3/,
  );
  assert.equal(
    (await post('/tasks/text-to-model', { prompt: 'Second' }, 'second')).status,
    502,
  );
  assert.equal(
    (await post('/tasks/text-to-model', { prompt: 'Second' }, 'second')).status,
    409,
  );
  assert.equal(submits, 2);
});
