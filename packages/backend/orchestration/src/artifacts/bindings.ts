import type { ActionBinding } from "../action-api.ts";
import type { WorkflowArtifactIndex } from "./workflow-index.ts";

/** Records files explicitly published by an Action, including Agent tools. */
export function artifactCallBinding(
  index: WorkflowArtifactIndex | undefined,
  binding: ActionBinding,
): ActionBinding["bindCall"] {
  if (!index || !binding.runId || !binding.stepId) return undefined;
  return (callId) => {
    const owner = {
      runId: binding.runId!,
      stepKey: binding.stepId!,
      attempt: binding.attempt,
      callId,
    };
    return {
      artifacts: {
        async register(path, options) {
          await index.register(owner, path, options).catch(() => {});
        },
      },
    };
  };
}
