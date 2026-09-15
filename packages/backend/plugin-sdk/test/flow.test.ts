import assert from "node:assert/strict";
import test from "node:test";
import { defineFlow, z } from "../src/flow.ts";
import type {
  FlowDefinition as InternalDefinition,
  FlowRegistrationConfig,
  FlowScope,
} from "@aura/orchestration/flow";

test("public Flow contract adapts root Action calls to an internal sequence", async () => {
  let registered: InternalDefinition | undefined;
  const plugin = defineFlow({
    title: "Plugin flow",
    input: z.object({ value: z.string() }),
    output: z.object({ value: z.string() }),
    async run(ctx, input) {
      const result = await ctx.action({
        id: "echo",
        action: "example.plugin/echo",
        input,
      });
      return { value: String(result.output) };
    },
  });
  const config: FlowRegistrationConfig = {
    flowId: "example.plugin/flow",
    directory: "plugin-flow",
    entry: "plugin-flow/flow.flow.js",
  };
  const context = {
    auraFlowRegistry: {
      async register(
        _config: FlowRegistrationConfig,
        definition: InternalDefinition,
      ) {
        registered = definition;
      },
    },
  } as unknown as Parameters<NonNullable<typeof plugin.apply>>[0];
  await plugin.apply!(context, config);

  const scope = {
    async action() {
      return {
        stepId: "plugin/echo",
        actionId: "example.plugin/echo",
        output: "ok",
      };
    },
  } as unknown as FlowScope;
  const output = await registered!.run(
    {
      runId: "run",
      mode: "demo",
      signal: new AbortController().signal,
      async sequence(options, run) {
        assert.equal(options.id, "plugin");
        return run(scope);
      },
    },
    { value: "input" },
  );
  assert.deepEqual(output, { value: "ok" });
});
