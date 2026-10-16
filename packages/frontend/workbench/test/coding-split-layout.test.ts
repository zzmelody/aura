import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONVERSATION_DIVIDER_WIDTH,
  DEFAULT_SIDE_WIDTH,
  MIN_CONVERSATION_WIDTH,
  conversationSplit,
} from "../src/features/coding/split-layout.ts";

test("default side width adapts to the container and caps at 440 pixels", () => {
  assert.equal(conversationSplit(1200).width, DEFAULT_SIDE_WIDTH);
  assert.equal(conversationSplit(900).width, 401);
  assert.equal(conversationSplit(648).width, MIN_CONVERSATION_WIDTH);
});

test("dragging left widens the side conversation and dragging right narrows it", () => {
  const initial = conversationSplit(1200).width;
  assert.equal(conversationSplit(1200, initial - -120).width, initial + 120);
  assert.equal(conversationSplit(1200, initial - 120).width, initial - 120);
});

test("resizing reserves a usable minimum for both conversations and the handle", () => {
  for (const container of [648, 700, 900, 1000.7, 1600]) {
    for (const preferred of [-100, 0, 320, 440, 10000]) {
      const { min, max, width, stacked } = conversationSplit(
        container,
        preferred,
      );
      assert.equal(stacked, false);
      assert.equal(min, MIN_CONVERSATION_WIDTH);
      assert.ok(width >= min && width <= max);
      assert.ok(
        container - width - CONVERSATION_DIVIDER_WIDTH >=
          MIN_CONVERSATION_WIDTH,
      );
    }
  }
});

test("a saved width is constrained on smaller windows without changing the preference", () => {
  const preferred = 700;
  assert.equal(conversationSplit(1200, preferred).width, preferred);
  assert.equal(conversationSplit(800, preferred).width, 472);
  assert.equal(conversationSplit(1200, preferred).width, preferred);
});

test("narrow containers stack exactly when two minimum-width panes no longer fit", () => {
  const breakpoint = MIN_CONVERSATION_WIDTH * 2 + CONVERSATION_DIVIDER_WIDTH;
  assert.equal(conversationSplit(breakpoint).stacked, false);
  for (const container of [breakpoint - 0.5, 600, 375, 0]) {
    const { stacked, min, max, width } = conversationSplit(container);
    assert.equal(stacked, true);
    assert.ok(width >= 0 && width >= min && width <= max);
  }
});

test("reset and non-finite preferences use the adaptive default", () => {
  const expected = conversationSplit(900).width;
  for (const preferred of [undefined, NaN, Infinity, -Infinity]) {
    assert.equal(conversationSplit(900, preferred).width, expected);
  }
});
