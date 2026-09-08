import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { readJson } from "../validation.mjs";

test("request reader joins chunks and rejects malformed or oversized bodies", async () => {
  assert.deepEqual(
    await readJson(Readable.from([Buffer.from('{"a":'), Buffer.from("1}")])),
    { a: 1 },
  );
  await assert.rejects(
    readJson(Readable.from([Buffer.from("not json")])),
    SyntaxError,
  );
  await assert.rejects(
    readJson(Readable.from([Buffer.alloc(9)]), 8),
    /请求过大/,
  );
});
