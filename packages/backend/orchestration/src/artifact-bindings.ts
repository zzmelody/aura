import { TRIPO_GAME_ASSET_CAPABILITY } from "@aura/tripo";
import type { ActionBinding, AuraCapabilityClient } from "./action-api.ts";
import type { LocalAIClient } from "./local-ai/api.ts";
import type { WorkflowArtifactIndex } from "./workflow-artifacts.ts";

/** Observe host producer results before an Action can reshape/drop them (including Agent tools). */
export function artifactCallBinding(
  index: WorkflowArtifactIndex | undefined,
  binding: ActionBinding,
  localAI?: LocalAIClient,
  aura?: AuraCapabilityClient,
): ActionBinding["bindCall"] {
  if (!index || !binding.runId || !binding.stepId) return undefined;
  return (callId) => {
    const owner = {
      runId: binding.runId!,
      stepKey: binding.stepId!,
      attempt: binding.attempt,
      callId,
    };
    const capture = async <T>(value: T, producer: string): Promise<T> => {
      await index.capture(owner, value, producer).catch(() => {});
      return value;
    };
    return {
      artifacts: {
        async register(path, options) {
          await index.register(owner, path, options).catch(() => {});
        },
      },
      localAI: localAI
        ? {
            service: (...args) => localAI.service(...args),
            image: async (...args) =>
              capture(await localAI.image(...args), "local-image"),
            comfyWorkflow: async (...args) =>
              capture(await localAI.comfyWorkflow(...args), "comfy-workflow"),
            video: (...args) => localAI.video(...args),
            tts: (...args) => localAI.tts(...args),
          }
        : undefined,
      aura: aura
        ? {
            async invoke(capability, operation, input, signal) {
              const output = await aura.invoke(
                capability,
                operation,
                input,
                signal,
              );
              return capability === TRIPO_GAME_ASSET_CAPABILITY &&
                operation === "generate"
                ? capture(output, "tripo")
                : output;
            },
          }
        : undefined,
    };
  };
}
