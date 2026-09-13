import { test } from "node:test";
import assert from "node:assert/strict";
import { zoomFlowViewport, wheelGestureMode } from "../src/flowViewport.ts";

test("zoom preserves the world point under the cursor after panning", () => {
  const view = { zoom: 0.8, pan: { x: 43, y: -25 } };
  const anchor = { x: -130, y: 51 };
  const world = {
    x: (anchor.x - view.pan.x) / view.zoom,
    y: (anchor.y - view.pan.y) / view.zoom,
  };
  const next = zoomFlowViewport(view, 1.7, anchor);
  assert.ok(Math.abs(next.pan.x + world.x * next.zoom - anchor.x) < 1e-9);
  assert.ok(Math.abs(next.pan.y + world.y * next.zoom - anchor.y) < 1e-9);
});

test("pinch zoom follows a moving midpoint and clamps extreme scales", () => {
  const next = zoomFlowViewport(
    { zoom: 1, pan: { x: 0, y: 0 } },
    2,
    { x: 20, y: 10 },
    { x: 40, y: 40 },
  );
  assert.deepEqual(next, { zoom: 2, pan: { x: 0, y: 20 } });
  assert.equal(zoomFlowViewport(next, 100, { x: 0, y: 0 }).zoom, 3);
  assert.equal(zoomFlowViewport(next, 0, { x: 0, y: 0 }).zoom, 0.1);
});

test("wheel hints separate line/notched scrolling from smooth two-axis gestures", () => {
  assert.equal(
    wheelGestureMode({ deltaMode: 0, deltaX: 0, deltaY: 119.99999 }),
    "zoom",
  );
  assert.equal(
    wheelGestureMode({ deltaMode: 1, deltaX: 0, deltaY: 3 }),
    "zoom",
  );
  assert.equal(
    wheelGestureMode({ deltaMode: 0, deltaX: 0, deltaY: 120 }),
    "zoom",
  );
  assert.equal(
    wheelGestureMode({ deltaMode: 0, deltaX: 0, deltaY: 2.5 }),
    "pan",
  );
  assert.equal(
    wheelGestureMode({ deltaMode: 0, deltaX: 30, deltaY: 100 }),
    "pan",
  );
});
