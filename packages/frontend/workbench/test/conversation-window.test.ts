import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeConversationWindow,
  newTurn,
  turnsFromHistory,
} from "../src/features/coding/turns.ts";

test("reconnected history keeps older turns with equal timestamps and replaces overlapping rows by native ID", () => {
  const history = ["turn-0", "turn-1", "turn-2"].map((turnId) => ({
    turnId,
    prompt: turnId,
    startedAt: 1,
    status: "complete" as const,
    events: [],
  }));
  const prior = turnsFromHistory("session", history);
  const recent = turnsFromHistory("session", history.slice(1));
  const merged = mergeConversationWindow(prior, recent, true);
  assert.deepEqual(
    merged.map((turn) => turn.id),
    prior.map((turn) => turn.id),
  );
  assert.equal(mergeConversationWindow(merged, recent, true).length, 3);
  assert.equal(mergeConversationWindow(merged, recent, false).length, 2);
});

test("snapshot attachment recovery only matches a local optimistic row, never an earlier identical prompt", () => {
  const image = {
    assetId: "asset",
    mimeType: "image/png" as const,
    name: "photo",
  };
  const old = {
    ...newTurn("session:turn-0", "same", 1),
    status: "complete" as const,
    images: [image],
  };
  const incoming = newTurn("session:turn-1", "same", 2);
  assert.equal(
    mergeConversationWindow([old], [incoming], false)[0]?.images,
    undefined,
  );
  const optimistic = newTurn("local", "same", 2, [image]);
  assert.deepEqual(
    mergeConversationWindow([old, optimistic], [incoming], false)[0]?.images,
    [image],
  );
});
