/** Stable Action authoring surface for trusted external Aura plugins. */
import type {
  ActionContext,
  AuraCapabilityClient,
} from "@aura/orchestration/action";

export {
  defineAction,
  type ActionContext,
  type ActionDefinition,
  type AuraCapabilityClient,
  type InferArgs,
  type InferValue,
  type ParameterSchemaSpec,
  type ValueSchemaSpec,
} from "@aura/orchestration/action";

/** Binds one declared host capability to the current Action cancellation scope. */
export function auraCapability(context: ActionContext, id: string) {
  if (!context.aura)
    throw new Error(`Aura host capability is unavailable: ${id}`);
  const client: AuraCapabilityClient = context.aura;
  return Object.freeze({
    invoke(
      operation: string,
      input: Parameters<AuraCapabilityClient["invoke"]>[2],
    ) {
      return client.invoke(id, operation, input, context.signal);
    },
  });
}
