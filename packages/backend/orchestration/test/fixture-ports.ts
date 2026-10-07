import type { JsonValue, FlowHistory } from "@aura/protocol/types";
import type { FlowRegistry } from "../src/registry.ts";
import type { ActionRegistry, LoadedAction } from "../src/action-registry.ts";
import type { ActionBinding } from "../src/action-api.ts";

/** Fixtures intentionally provide only the Cordis services used by registration. */
export type RegistrationPlugin = {
  apply(
    context: {
      auraFlowRegistry?: FlowRegistry;
      auraActionRegistry?: ActionRegistry;
    },
    configuration: unknown,
  ): Promise<void>;
};

/** Direct unit fixtures exercise the Action body without constructing a DSH Agent. */
export type FixtureToolExecute = (
  input: unknown,
  context: { signal: AbortSignal; callId: string },
) => Promise<JsonValue>;

export type FixtureInput = Record<string, JsonValue>;

export const emptyHistory = async (step: {
  sessionId: string;
  preset: string;
}): Promise<FlowHistory> => ({
  sessionId: step.sessionId,
  preset: step.preset,
  entries: [],
  hasMore: false,
});

export function executeFixtureTool(
  action: LoadedAction,
  input: unknown,
  binding: ActionBinding,
  signal: AbortSignal,
  callId: string,
) {
  const tool = action.tool("fixture", binding);
  return (tool.execute as FixtureToolExecute)(input, { signal, callId });
}
