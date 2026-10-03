import { Context } from "@deepseek-ai/cordis";
import LlmRuntime from "@deepseek-ai/dsh-llm";
import * as PiAiAdapter from "@deepseek-ai/dsh-llm-pi-ai";
import type { PiAiProviderProfile } from "@deepseek-ai/dsh-llm-pi-ai";

/** Keep the installed DSH catalog, supplementing the requested newer model. */
export async function codexProviderProfile(): Promise<PiAiProviderProfile> {
  const profile: PiAiProviderProfile = {
    reasoning: "xhigh",
    transport: "sse",
    cacheRetention: "short",
  };
  const ctx = new Context();
  try {
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(PiAiAdapter, {
      providers: { "openai-codex": profile },
    });
    const models = await ctx.llm.listModels("openai-codex");
    // Once DSH includes this model, prefer its native metadata unchanged.
    if (models.some(({ id }) => id === "gpt-6.1-sol")) return profile;
    return {
      ...profile,
      // A capability fallback, not a per-request maxTokens override.
      defaultMaxTokens: 128_000,
      models: [
        ...models.map(({ id }) => ({ id })),
        {
          id: "gpt-6.1-sol",
          name: "GPT-6.1 Sol",
          // https://developers.openai.com/api/docs/models/gpt-6.1-sol
          contextWindow: 1_050_000,
          input: ["text", "image"],
          reasoningEfforts: {
            low: "low",
            medium: "medium",
            high: "high",
            xhigh: "xhigh",
            max: "max",
          },
        },
      ],
    };
  } finally {
    await ctx.fiber.dispose();
  }
}
