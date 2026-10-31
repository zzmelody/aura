import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { defineResult } from "@aura/plugin-ui";
import type { RegisteredResult } from "../src/pluginHost.ts";
import {
  matchPluginResult,
  PluginResultBoundary,
} from "../src/pluginResults.ts";

const context = {
  endpoint: "http://127.0.0.1:4311",
  run: { id: "run-1", flowId: "example.studio/video", status: "completed" },
  output: { kind: "clip" },
};

const result = (
  pluginId: string,
  id: string,
  match: () => boolean,
): RegisteredResult => ({
  pluginId,
  definition: defineResult({ id, match, render: () => id }),
});

test("the first matching renderer wins and receives its own plugin id", () => {
  const found = matchPluginResult(
    [
      result("one", "never", () => false),
      result("two", "clip", () => true),
      result("three", "later", () => true),
    ],
    context,
  );
  assert.equal(found?.result.definition.id, "clip");
  assert.equal(found?.context.pluginId, "two");
  assert.deepEqual(found?.context.output, context.output);
});

test("no renderer or a throwing match leaves the generic view", () => {
  assert.equal(matchPluginResult([], context), undefined);
  const found = matchPluginResult(
    [
      result("broken", "throws", () => {
        throw new Error("bad match");
      }),
      result("fine", "fallback", () => true),
    ],
    context,
  );
  assert.equal(found?.result.pluginId, "fine");
});

test("result definitions need an id, match and render", () => {
  assert.throws(() =>
    defineResult({
      id: "Bad Id",
      match: () => true,
      render: () => null,
    }),
  );
  assert.throws(() =>
    defineResult({ id: "ok" } as unknown as Parameters<typeof defineResult>[0]),
  );
});

// The server renderer does not run error boundaries, so check the boundary's
// state transition and both render branches directly.
test("a renderer that throws while rendering falls back to the generic view", () => {
  assert.deepEqual(PluginResultBoundary.getDerivedStateFromError(), {
    failed: true,
  });
  const fallback = React.createElement("pre", null, "generic");
  const boundary = new PluginResultBoundary({
    render: () => "plugin",
    fallback,
  });
  boundary.state = { failed: true };
  assert.equal(
    renderToStaticMarkup(boundary.render() as React.ReactElement),
    "<pre>generic</pre>",
  );
  boundary.state = { failed: false };
  assert.equal(
    renderToStaticMarkup(boundary.render() as React.ReactElement),
    "plugin",
  );
});
