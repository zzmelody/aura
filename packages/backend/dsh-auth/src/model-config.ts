import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-settings";
import {
  customProfiles,
  LUMINA_DEFAULT_MODEL,
  LUMINA_PROVIDER,
  luminaSettings,
  readAiServices,
  selectedAgentConfig,
} from "./ai-services.ts";
import type {
  FlowAgentConfig,
  FlowAgentOptions,
  FlowMode,
} from "@aura/protocol/types";
import { FlowError } from "@aura/protocol/errors";
import { z } from "zod";

const agentOptionFields = {
  model: z.string().trim().min(1).max(200).optional(),
  reasoningEffort: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)
    .optional(),
  maxTokens: z.number().int().min(1).max(1_000_000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  timeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(30 * 60_000)
    .optional(),
};
export const agentOptionsSchema = z.object(agentOptionFields).strict();
export const agentConfigSchema = z
  .object({
    ...agentOptionFields,
    provider: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/u),
    model: agentOptionFields.model.unwrap(),
    reasoningEffort: agentOptionFields.reasoningEffort.unwrap(),
    timeoutMs: agentOptionFields.timeoutMs.unwrap(),
  })
  .strict();

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new FlowError(
      result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("；"),
    );
  return result.data;
}

/** Resolve environment defaults once, at Run admission, never during replay. */
export function agentDefaults(
  mode: FlowMode,
  overrides: FlowAgentOptions = {},
  timeoutMs = 30 * 60_000,
  codexModel = process.env.AURA_CODEX_MODEL || "gpt-6.1-sol",
): FlowAgentConfig {
  if (mode === "custom") throw new FlowError("自定义模型尚未配置。", 422);
  if (mode === "lumina")
    return agentConfig(
      {
        provider: LUMINA_PROVIDER,
        model: LUMINA_DEFAULT_MODEL,
        reasoningEffort: "high",
        timeoutMs,
      },
      overrides,
    );
  return agentConfig(
    {
      provider: mode === "codex" ? "openai-codex" : "deepseek-official",
      model: mode === "codex" ? codexModel : "deepseek-v4-flash",
      reasoningEffort: mode === "codex" ? "xhigh" : "off",
      ...(mode === "demo" ? { maxTokens: 4096 } : {}),
      timeoutMs,
    },
    overrides,
  );
}

/** Undefined means inherit, including when supplied by a JavaScript property expression. */
export function agentConfig(
  defaults: FlowAgentConfig,
  overrides: FlowAgentOptions,
): FlowAgentConfig {
  const options = parse(agentOptionsSchema, overrides);
  const config = parse(agentConfigSchema, {
    ...defaults,
    ...Object.fromEntries(
      Object.entries(options).filter(([, value]) => value !== undefined),
    ),
  });
  if (config.provider === "openai-codex" && config.maxTokens !== undefined)
    throw new FlowError(
      "AGENT_OPTION_UNSUPPORTED: 当前 DSH Codex 适配器不支持 maxTokens，请移除此选项；可使用 timeoutMs 限制执行时长。",
      422,
    );
  return config;
}

/** Read the selected route per request so saved settings apply without a restart. */
export async function resolveModeDefaults(
  settings: Context["settings"],
  mode: FlowMode | "configured",
  root: string,
  codexModel?: string,
): Promise<FlowAgentConfig> {
  if (mode === "demo") return agentDefaults(mode);
  const document = await readAiServices(root, codexModel);
  if (
    mode === "custom" ||
    (mode === "configured" && document.model.mode === "custom")
  ) {
    const route = document.selectedRoute
      ? document.routes[document.selectedRoute]
      : undefined;
    if (!route) throw new FlowError("请先配置自定义模型服务。", 422);
    await settings.update("llm-pi-ai", {
      providers: customProfiles(document),
    });
    return selectedAgentConfig({ ...document, model: route.settings });
  }
  if (
    mode === "lumina" ||
    (mode === "configured" && document.model.mode === "lumina")
  ) {
    await settings.update("llm-pi-ai", {
      providers: customProfiles(document),
    });
    return selectedAgentConfig({
      ...document,
      model: luminaSettings(document),
    });
  }
  const codex =
    document.codex ??
    (document.model.mode === "codex" ? document.model : undefined);
  return codex
    ? selectedAgentConfig({ ...document, model: codex })
    : agentDefaults("codex");
}
