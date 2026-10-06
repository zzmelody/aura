import assert from "node:assert/strict";
import test from "node:test";
import { defineFlow, z } from "../src/flow.ts";
import { ActionFailure, auraCapability } from "../src/action.ts";
import type { ActionContext } from "../src/action.ts";
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

test("public Action capability helper binds identity and cancellation", async () => {
  const abort = new AbortController();
  const calls: unknown[][] = [];
  const context = {
    signal: abort.signal,
    cwd: "/workspace",
    directory: "/plugin/action",
    callId: "call-1",
    mode: "demo",
    aura: {
      async invoke(...args: unknown[]) {
        calls.push(args);
        return { ok: true };
      },
    },
  } as ActionContext;

  const output = await auraCapability(context, "aura.tripo.game-asset").invoke(
    "worlds.list",
    {},
  );
  assert.deepEqual(output, { ok: true });
  assert.deepEqual(calls, [
    ["aura.tripo.game-asset", "worlds.list", {}, abort.signal],
  ]);
  assert.throws(
    () => auraCapability({ ...context, aura: undefined }, "missing"),
    /capability is unavailable/u,
  );
});

test("public Action failures are bounded product-facing errors", () => {
  const error = new ActionFailure(" 生成左视图\n超时。 ");
  assert.equal(error.name, "ActionFailure");
  assert.equal(error.code, "ACTION_FAILURE");
  assert.equal(error.message, "生成左视图 超时。");
  assert.throws(() => new ActionFailure("\n\t"), /message is required/u);
});
