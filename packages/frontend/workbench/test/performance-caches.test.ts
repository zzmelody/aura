import assert from "node:assert/strict";
import { test } from "node:test";
import { PERSONAL_ASSISTANT_SESSION_ID } from "@aura/protocol/conversations";
import { fileDiff } from "../src/features/coding/diff.ts";
import { retainConversations } from "../src/features/coding/conversation-cache.ts";

test("a file hunk shares alignment and counts until its contents change", () => {
  const hunk = { oldText: "before\n", newText: "after\n" };
  const first = fileDiff(hunk);
  assert.equal(fileDiff(hunk), first);
  assert.equal(first.added, 1);
  assert.equal(first.removed, 1);
  hunk.newText = "before\n";
  assert.notEqual(fileDiff(hunk), first);
  assert.equal(fileDiff(hunk).added, 0);
});

test("transcript eviction preserves selected and streaming conversations", () => {
  const entries = { oldest: [], selected: [], streaming: [], recent: [] };
  assert.deepEqual(
    Object.keys(retainConversations(entries, "selected", ["streaming"], 3)),
    ["selected", "streaming", "recent"],
  );
  assert.equal(retainConversations(entries, "selected", [], 4), entries);
  assert.deepEqual(
    Object.keys(
      retainConversations(entries, "selected", Object.keys(entries), 1),
    ),
    Object.keys(entries),
  );
});

test("returning to Aura can still use its transcript after older tasks are evicted", () => {
  const assistant = ["retained transcript"];
  const retained = retainConversations(
    { [PERSONAL_ASSISTANT_SESSION_ID]: assistant, oldest: [], selected: [] },
    "selected",
    [],
    2,
  );
  assert.equal(retained[PERSONAL_ASSISTANT_SESSION_ID], assistant);
  assert.equal(retained.oldest, undefined);
});
