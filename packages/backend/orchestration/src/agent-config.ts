import type {
  FlowAgentConfig,
  FlowAgentOptions,
  FlowMode,
} from "@aura/protocol/types";
import {
  agentConfigSchema,
  agentOptionsSchema,
  FlowError,
  parse,
} from "./schema.ts";

/** Resolve environment defaults once, at Run admission, never during replay. */
export function agentDefaults(
  mode: FlowMode,
  overrides: FlowAgentOptions = {},
  timeoutMs = 180_000,
  codexModel = process.env.AURA_CODEX_MODEL || "gpt-5.6-terra",
): FlowAgentConfig {
  return agentConfig(
    {
      provider: mode === "codex" ? "openai-codex" : "deepseek-official",
      model: mode === "codex" ? codexModel : "deepseek-v4-flash",
      reasoningEffort: mode === "codex" ? "medium" : "off",
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
