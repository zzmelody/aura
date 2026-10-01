import type { JsonValue } from "@aura/protocol/types";
import type { AuraCapabilityClient } from "./action-api.ts";

/** Dispatches a manifest-gated capability ID to exactly one host-owned port. */
export class AuraCapabilityRouter implements AuraCapabilityClient {
  readonly #routes: ReadonlyMap<string, AuraCapabilityClient>;

  constructor(routes: Iterable<readonly [string, AuraCapabilityClient]>) {
    this.#routes = new Map(routes);
  }

  invoke(
    capability: string,
    operation: string,
    input: JsonValue,
    signal: AbortSignal,
    context?: { readonly runId?: string },
  ): Promise<JsonValue> {
    const client = this.#routes.get(capability);
    if (!client)
      throw new Error(`Aura host capability is unavailable: ${capability}`);
    return client.invoke(capability, operation, input, signal, context);
  }
}
