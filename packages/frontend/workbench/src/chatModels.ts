import type {
  ChatModelCatalog,
  ChatModelSelection,
} from "@aura/protocol/types";

/** Keep an explicit effort only when the newly chosen model supports it. */
export function selectChatModel(
  catalog: ChatModelCatalog,
  current: ChatModelSelection,
  model: string,
): ChatModelSelection {
  const entry = catalog.models.find(
    ({ id }) => id === (model || catalog.defaultModel),
  );
  return {
    ...(model ? { model } : {}),
    ...(current.reasoningEffort &&
    entry?.reasoningEfforts.some(({ id }) => id === current.reasoningEffort)
      ? { reasoningEffort: current.reasoningEffort }
      : {}),
  };
}
