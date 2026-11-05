import type { Context } from "@deepseek-ai/cordis";
import {
  LlmError,
  ReasoningEffortId,
  type LlmModelReasoningInfo,
} from "@deepseek-ai/dsh-llm";
import type {
  ChatModelCatalog,
  ChatModelSelection,
  FlowAgentConfig,
  FlowMode,
} from "@aura/protocol/types";
import { modelVendor } from "@aura/protocol/models";
import { agentDefaults } from "@aura/dsh-auth/model-config";
import { FlowError } from "@aura/protocol/errors";

type ModelRuntime = Pick<
  Context["llm"],
  "listModels" | "resolveModelInfo" | "resolveCallConfig"
>;

function defaultEffort(
  reasoning: LlmModelReasoningInfo | undefined,
  preferred: string,
) {
  return (
    reasoning?.efforts.find(({ id }) => id === preferred)?.id ??
    reasoning?.defaultEffort ??
    reasoning?.efforts[0]?.id
  );
}

/**
 * Models the account rejected at request time. The DSH catalog also lists
 * API-only models a ChatGPT subscription cannot use; once one is refused it
 * leaves the picker for the life of this host process.
 */
export class RejectedChatModels {
  private readonly rejected = new Map<FlowMode, Set<string>>();
  reject(mode: FlowMode, model: string) {
    const set = this.rejected.get(mode) ?? new Set<string>();
    set.add(model);
    this.rejected.set(mode, set);
  }
  has(mode: FlowMode, model: string) {
    return this.rejected.get(mode)?.has(model) ?? false;
  }
}

/** Catalog and capability checks stay in the same DSH host that executes chat. */
export async function chatModelCatalog(
  llm: ModelRuntime,
  mode: FlowMode,
  signal: AbortSignal,
  rejected?: RejectedChatModels,
  defaults: FlowAgentConfig = agentDefaults(mode),
): Promise<ChatModelCatalog> {
  // Gateway catalogs mix vendors; subscription catalogs are single-vendor.
  const grouped = mode === "lumina" || mode === "custom";
  const models = (await llm.listModels(defaults.provider)).filter(
    ({ id }) => id === defaults.model || !rejected?.has(mode, id),
  );
  return {
    mode,
    defaultModel: defaults.model,
    models: await Promise.all(
      models.map(async ({ id, name }) => {
        const info = await llm.resolveModelInfo(defaults.provider, id, signal);
        const effort = defaultEffort(info.reasoning, defaults.reasoningEffort);
        return {
          id,
          name,
          ...(grouped ? { vendor: modelVendor(id) } : {}),
          reasoningEfforts: (info.reasoning?.efforts ?? []).map(
            ({ id, name }) => ({ id, name }),
          ),
          ...(effort ? { defaultReasoningEffort: effort } : {}),
        };
      }),
    ),
  };
}

/** No settings writes: resolve only the model selection for this chat turn. */
export async function resolveChatModel(
  llm: ModelRuntime,
  mode: FlowMode,
  selection: ChatModelSelection,
  signal: AbortSignal,
  defaults: FlowAgentConfig = agentDefaults(mode),
) {
  const model = selection.model ?? defaults.model;
  try {
    const info = await llm.resolveModelInfo(defaults.provider, model, signal);
    // "off" on a model without reasoning levels means "send none".
    const requested =
      selection.reasoningEffort === "off" && !info.reasoning
        ? undefined
        : selection.reasoningEffort;
    const effort =
      requested ?? defaultEffort(info.reasoning, defaults.reasoningEffort);
    return await llm.resolveCallConfig(
      {
        provider: defaults.provider,
        model,
        ...(effort ? { reasoningEffort: ReasoningEffortId(effort) } : {}),
        ...(defaults.maxTokens === undefined
          ? {}
          : { maxTokens: defaults.maxTokens }),
      },
      signal,
    );
  } catch (error) {
    signal.throwIfAborted();
    const code =
      error instanceof LlmError && /^[A-Z0-9_]+$/u.test(error.code)
        ? error.code
        : "MODEL_CONFIG_UNAVAILABLE";
    throw new FlowError(
      `对话模型或思考强度不可用（${code}），请重新选择。`,
      422,
    );
  }
}
