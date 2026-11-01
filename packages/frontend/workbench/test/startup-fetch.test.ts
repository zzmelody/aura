import assert from "node:assert/strict";
import { test } from "node:test";
import { startupFetch } from "../src/startup-fetch.ts";

test("startup reads retry connection refusal and a warming backend without a multi-second gap", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    if (calls === 1) throw new TypeError("Fixture connection refused");
    return new Response("{}", { status: calls === 2 ? 503 : 200 });
  });
  assert.equal((await startupFetch("http://fixture/projects")).status, 200);
  assert.equal(calls, 3);
});

test("startup reads do not retry invalid input or authorization refusals", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response("{}", { status: 401 });
  });
  assert.equal((await startupFetch("http://fixture/projects")).status, 401);
  assert.equal(calls, 1);
});

test("cancelling a startup retry stops its wait and never issues another read", async (t) => {
  const requested = Promise.withResolvers<void>();
  const abort = new AbortController();
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    requested.resolve();
    return new Response("{}", { status: 503 });
  });
  const waiting = startupFetch("http://fixture/projects", abort.signal);
  await requested.promise;
  abort.abort(new Error("Fixture cancelled"));
  await assert.rejects(waiting, /Fixture cancelled/u);
  assert.equal(calls, 1);
});

test("an unavailable startup read surfaces its response once the retry window expires", async (t) => {
  let clockReads = 0;
  let calls = 0;
  t.mock.method(Date, "now", () => (++clockReads === 1 ? 0 : 6_000));
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response("{}", { status: 503 });
  });
  assert.equal((await startupFetch("http://fixture/projects")).status, 503);
  assert.equal(calls, 1);
});
