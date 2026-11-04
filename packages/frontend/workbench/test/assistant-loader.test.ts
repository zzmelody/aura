import assert from "node:assert/strict";
import { test } from "node:test";
import { createAssistantLoader } from "../src/features/coding/assistant-loader.ts";

test("repeated opens share the first request and later navigation reuses the session", async () => {
  const response = Promise.withResolvers<boolean>();
  const requests: boolean[] = [];
  const { load } = createAssistantLoader((create) => {
    requests.push(create);
    return response.promise;
  });

  const first = load(true);
  const second = load(true);
  assert.deepEqual(requests, [true]);
  response.resolve(true);
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(await load(), true);
  assert.equal(await load(true), true);
  assert.deepEqual(requests, [true]);
});

test("an explicit open waits for restoration and only creates if no session was loaded", async () => {
  for (const found of [true, false]) {
    const restored = Promise.withResolvers<boolean>();
    const requests: boolean[] = [];
    const { load } = createAssistantLoader((create) => {
      requests.push(create);
      return create ? Promise.resolve(true) : restored.promise;
    });

    const restore = load();
    const firstOpen = load(true);
    const secondOpen = load(true);
    assert.deepEqual(requests, [false]);
    restored.resolve(found);
    assert.deepEqual(await Promise.all([restore, firstOpen, secondOpen]), [
      found,
      true,
      true,
    ]);
    assert.deepEqual(requests, found ? [false] : [false, true]);
  }
});

test("cancelled and failed requests leave the assistant retryable", async () => {
  const response = Promise.withResolvers<boolean>();
  const requests: AbortSignal[] = [];
  const { load, cancel } = createAssistantLoader((_create, signal) => {
    requests.push(signal);
    if (requests.length === 1) return response.promise;
    return Promise.resolve(requests.length === 3);
  });

  const restore = load();
  const open = load(true);
  cancel();
  assert.equal(requests[0]?.aborted, true);
  assert.equal(await load(true), false);
  response.resolve(true);
  assert.deepEqual(await Promise.all([restore, open]), [false, false]);
  assert.equal(await load(true), true);
  assert.equal(requests.length, 3);
});
