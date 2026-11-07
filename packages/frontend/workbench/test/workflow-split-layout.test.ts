import assert from "node:assert/strict";
import { test } from "node:test";
import { paneSplit } from "../src/pane-split.ts";
import { WORKFLOW_SPLIT_BOUNDS } from "../src/workflow-split.ts";
import { CONVERSATION_BOUNDS } from "../src/features/coding/split-layout.ts";

const bounds = WORKFLOW_SPLIT_BOUNDS;
const split = (container: number, preferred?: number) =>
  paneSplit(container, preferred, bounds);

test("the assistant opens at its preferred width and adapts to narrow decks", () => {
  // Wide decks cap at the preferred width; mid decks fall back to the share;
  // at the stacking breakpoint the minimum governs instead.
  assert.equal(split(1400).width, bounds.preferred);
  assert.equal(split(1000).width, Math.round((1000 - bounds.divider) * 0.34));
  assert.equal(
    split(bounds.side + bounds.main + bounds.divider).width,
    bounds.side,
  );
});

test("dragging left widens the assistant and dragging right narrows it", () => {
  const initial = split(1400).width;
  assert.equal(split(1400, initial + 120).width, initial + 120);
  assert.equal(split(1400, initial - 60).width, initial - 60);
});

test("resizing always leaves the canvas and the assistant usable", () => {
  for (const container of [688, 700, 900, 1200.4, 1920]) {
    for (const preferred of [-400, 0, 320, 420, 99999]) {
      const { min, max, width, stacked } = split(container, preferred);
      assert.equal(stacked, false);
      assert.equal(min, bounds.side);
      assert.ok(width >= min && width <= max, `${container}/${preferred}`);
      assert.ok(
        container - width - bounds.divider >= bounds.main,
        `canvas kept ${container - width - bounds.divider}px at ${container}px`,
      );
    }
  }
});

test("a saved width is constrained on smaller decks without losing the preference", () => {
  const preferred = 900;
  assert.equal(split(1600, preferred).width, preferred);
  assert.equal(split(1000, preferred).width, 1000 - bounds.divider - 360);
  assert.equal(split(1600, preferred).width, preferred);
});

test("the deck stacks exactly when the canvas and assistant minimums no longer fit", () => {
  const breakpoint = bounds.side + bounds.main + bounds.divider;
  assert.equal(split(breakpoint).stacked, false);
  for (const container of [breakpoint - 0.5, 600, 360, 320, 0]) {
    const { stacked, min, max, width } = split(container);
    assert.equal(stacked, true, `${container}px`);
    assert.ok(width >= 0 && width >= min && width <= max);
  }
});

test("reset and non-finite preferences fall back to the adaptive default", () => {
  const expected = split(1100).width;
  for (const preferred of [undefined, NaN, Infinity, -Infinity])
    assert.equal(split(1100, preferred).width, expected);
});

test("the workflow divider matches the conversation divider's grip width", () => {
  assert.equal(bounds.divider, CONVERSATION_BOUNDS.divider);
});
