import { test } from "node:test";
import assert from "node:assert/strict";
import { diffLines, diffStats } from "../src/features/coding/diff.ts";

test("a new file renders every line as added", () => {
  const lines = diffLines(null, "one\ntwo\n");
  assert.deepEqual(lines, [
    { kind: "add", text: "one" },
    { kind: "add", text: "two" },
  ]);
  assert.deepEqual(diffStats(lines), { added: 2, removed: 0 });
});

test("an edit keeps context and pairs the changed line", () => {
  const lines = diffLines("a\nb\nc\n", "a\nB\nc\n");
  assert.deepEqual(lines, [
    { kind: "same", text: "a" },
    { kind: "remove", text: "b" },
    { kind: "add", text: "B" },
    { kind: "same", text: "c" },
  ]);
  assert.deepEqual(diffStats(lines), { added: 1, removed: 1 });
});

test("insertions and deletions keep the surrounding lines aligned", () => {
  assert.deepEqual(diffLines("a\nc", "a\nb\nc"), [
    { kind: "same", text: "a" },
    { kind: "add", text: "b" },
    { kind: "same", text: "c" },
  ]);
  assert.deepEqual(diffLines("a\nb\nc", "a\nc"), [
    { kind: "same", text: "a" },
    { kind: "remove", text: "b" },
    { kind: "same", text: "c" },
  ]);
});

test("CRLF input compares equal to LF and identical text has no changes", () => {
  const lines = diffLines("x\r\ny\r\n", "x\ny\n");
  assert.deepEqual(diffStats(lines), { added: 0, removed: 0 });
  assert.equal(lines.length, 2);
});

test("an oversized hunk skips alignment instead of stalling", () => {
  const big = Array.from({ length: 600 }, (_, i) => `line ${i}`).join("\n");
  const lines = diffLines(big, `${big}\nextra`);
  assert.deepEqual(diffStats(lines), { added: 601, removed: 600 });
});
