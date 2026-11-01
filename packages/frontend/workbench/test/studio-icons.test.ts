import test from "node:test";
import assert from "node:assert/strict";
import { Puzzle } from "lucide-react";
import { studioIcon } from "../src/studioIcons.ts";

test("studio icons resolve the names plugins actually declare", () => {
  // Plugins in this repo declare both spellings: "FlaskConical" and
  // "message-square". Both must reach a real icon, not the generic fallback.
  assert.notEqual(studioIcon("FlaskConical"), Puzzle);
  assert.notEqual(studioIcon("message-square"), Puzzle);
  assert.equal(studioIcon("message-square"), studioIcon("MessageSquare"));
});

test("studio icons fall back when a plugin names no icon or an unknown one", () => {
  assert.equal(studioIcon(), Puzzle);
  assert.equal(studioIcon(""), Puzzle);
  assert.equal(studioIcon("not-a-real-icon"), Puzzle);
});
