import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import {
  credentialRef,
  type CredentialProvider,
} from "@deepseek-ai/dsh-credentials";
import LlmRuntime, { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import * as PiAiAdapter from "@deepseek-ai/dsh-llm-pi-ai";
import type { PiAiProviderProfile } from "@deepseek-ai/dsh-llm-pi-ai";
import type {
  AiCustomProvider,
  AiModelSettings,
  FlowAgentConfig,
} from "@aura/protocol/types";

export class AiConfigurationError extends Error {}
/** Lumina is a fixed OpenAI-compatible gateway; only its key is user-supplied. */
export const LUMINA_PROVIDER = "aura-lumina";
export const LUMINA_BASE_URL = "https://lumina.tripo3d.com/v1";
/** DSH credential reference name; the launch environment may also supply it. */
export const LUMINA_CREDENTIAL = "AURA_LUMINA_API_KEY";
export const LUMINA_DEFAULT_MODEL = "claude-sonnet-4-6";
const modelIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/u;
const efforts = ["off", "low", "medium", "high", "xhigh", "max"];
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
function text(value: unknown, limit: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > limit ||
    // eslint-disable-next-line no-control-regex -- Intentionally sanitize or detect ASCII control characters.
    /[\x00-\x1f\x7f]/u.test(value)
  )
    throw new AiConfigurationError("配置字段为空、过长或含无效字符。");
  return value.trim();
}
export function secret(value: unknown): string {
  const key = text(value, 4096);
  if (!/^[\x21-\x7e]+$/u.test(key))
    throw new AiConfigurationError("密钥必须为不含空格的可打印字符。");
  return key;
}
export function parseModelSettings(
  value: unknown,
): AiModelSettings & { key?: string; clearKey?: boolean } {
  if (
    !record(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "mode",
          "model",
          "reasoningEffort",
          "custom",
          "key",
          "clearKey",
        ].includes(key),
    ) ||
    !["codex", "lumina", "custom"].includes(String(value.mode))
  )
    throw new AiConfigurationError("模型设置无效。");
  const model = text(value.model, 200);
  const reasoningEffort = text(value.reasoningEffort, 16);
  if (!efforts.includes(reasoningEffort))
    throw new AiConfigurationError("思考强度无效。");
  let custom: AiCustomProvider | undefined;
  if (value.mode === "custom") {
    const item = value.custom;
    if (
      !record(item) ||
      Object.keys(item).some(
        (key) =>
          !["name", "api", "baseURL", "images", "contextWindow"].includes(key),
      )
    )
      throw new AiConfigurationError("自定义服务设置无效。");
    const baseURL = text(item.baseURL, 2048);
    let url: URL;
    try {
      url = new URL(baseURL);
    } catch {
      throw new AiConfigurationError("服务地址无效。");
    }
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      (url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new AiConfigurationError(
        "服务地址须使用 HTTPS；本机服务可使用 HTTP，地址不得含凭据或查询参数。",
      );
    if (
      ![
        "openai-completions",
        "openai-responses",
        "anthropic-messages",
      ].includes(String(item.api)) ||
      typeof item.images !== "boolean" ||
      !Number.isSafeInteger(item.contextWindow) ||
      Number(item.contextWindow) < 1024 ||
      Number(item.contextWindow) > 4_000_000
    )
      throw new AiConfigurationError("服务协议、图片能力或上下文长度无效。");
    custom = {
      name: text(item.name, 80),
      api: item.api as AiCustomProvider["api"],
      baseURL: baseURL.replace(/\/+$/u, ""),
      images: item.images,
      contextWindow: Number(item.contextWindow),
    };
  } else if (value.mode === "lumina") {
    if (value.custom !== undefined)
      throw new AiConfigurationError("Lumina 服务地址固定，不接受自定义地址。");
  } else if (
    value.custom !== undefined ||
    value.key !== undefined ||
    value.clearKey !== undefined
  ) {
    throw new AiConfigurationError("Codex 订阅通过账号登录，不接受 API Key。");
  }
  if (
    (value.clearKey !== undefined && typeof value.clearKey !== "boolean") ||
    (value.clearKey === true && value.key !== undefined)
  )
    throw new AiConfigurationError("密钥操作无效。");
  return {
    mode: value.mode as AiModelSettings["mode"],
    model,
    reasoningEffort,
    ...(custom ? { custom } : {}),
    ...(value.key === undefined ? {} : { key: secret(value.key) }),
    ...(value.clearKey === undefined
      ? {}
      : { clearKey: value.clearKey as boolean }),
  };
}

export interface AiServiceRoute {
  settings: AiModelSettings;
  credential: string;
  /** Chat model IDs the endpoint listed when last checked. */
  catalog?: string[];
}
export interface AiServiceDocument {
  version: 1;
  model: AiModelSettings;
  /** Old routes remain immutable so a durable Run keeps its endpoint and key reference. */
  routes: Record<string, AiServiceRoute>;
  selectedRoute?: string;
  codex?: AiModelSettings;
  /** Lumina keeps one stable route; `models` is the discovered chat catalog. */
  lumina?: AiModelSettings & { models: string[] };
}
function modelList(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 500 ||
    value.some((id) => typeof id !== "string" || !modelIdPattern.test(id))
  )
    throw new AiConfigurationError("模型目录记录无效。");
  return [...new Set(value as string[])];
}
export const aiServicesPath = (root: string) =>
  join(root, ".aura", "ai-services.json");
export async function readAiServices(
  root: string,
  codexModel = "gpt-6.1-sol",
): Promise<AiServiceDocument> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(aiServicesPath(root), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return {
        version: 1,
        model: { mode: "codex", model: codexModel, reasoningEffort: "xhigh" },
        routes: {},
      };
    throw new AiConfigurationError("AI 服务配置无法读取，请重新保存设置。");
  }
  if (!record(raw) || raw.version !== 1 || !record(raw.routes))
    throw new AiConfigurationError("AI 服务配置无效。");
  const model = parseModelSettings(raw.model);
  const routes: AiServiceDocument["routes"] = {};
  for (const [id, value] of Object.entries(raw.routes)) {
    if (
      !/^aura-custom-[a-f0-9]{32}$/u.test(id) ||
      !record(value) ||
      !/^AURA_CUSTOM_[A-F0-9]{32}$/u.test(String(value.credential))
    )
      throw new AiConfigurationError("AI 服务版本记录无效。");
    const settings = parseModelSettings(value.settings);
    if (
      settings.mode !== "custom" ||
      settings.key ||
      settings.clearKey !== undefined
    )
      throw new AiConfigurationError("AI 服务版本记录无效。");
    routes[id] = {
      settings,
      credential: String(value.credential),
      ...(value.catalog === undefined
        ? {}
        : { catalog: modelList(value.catalog) }),
    };
  }
  if (
    model.key ||
    model.clearKey !== undefined ||
    (model.mode === "custom" &&
      (typeof raw.selectedRoute !== "string" || !routes[raw.selectedRoute]))
  )
    throw new AiConfigurationError("AI 服务选择无效。");
  const codex =
    raw.codex === undefined ? undefined : parseModelSettings(raw.codex);
  if (codex && codex.mode !== "codex")
    throw new AiConfigurationError("Codex 配置无效。");
  let lumina: AiServiceDocument["lumina"];
  if (raw.lumina !== undefined) {
    if (!record(raw.lumina))
      throw new AiConfigurationError("Lumina 配置无效。");
    const { models, ...rest } = raw.lumina;
    const parsed = parseModelSettings(rest);
    if (parsed.mode !== "lumina" || parsed.key || parsed.clearKey !== undefined)
      throw new AiConfigurationError("Lumina 配置无效。");
    lumina = { ...parsed, models: modelList(models) };
  }
  return {
    version: 1,
    model,
    routes,
    ...(codex ? { codex } : {}),
    ...(lumina ? { lumina } : {}),
    ...(typeof raw.selectedRoute === "string"
      ? { selectedRoute: raw.selectedRoute }
      : {}),
  };
}
export async function writeAiServices(
  root: string,
  document: AiServiceDocument,
) {
  const path = aiServicesPath(root);
  const temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, JSON.stringify(document), {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}
const reasoningLevels = Object.fromEntries(
  efforts.filter((e) => e !== "off").map((e) => [e, e]),
);
/** DeepSeek Flash thinking defaults to 64K, including reasoning and final
 * output. The adapter's generic 32K fallback can end before a source module
 * is returned. Keep other providers and non-thinking modes unchanged. */
function thinkingOutputBudget(
  model: string,
  effort: string,
): number | undefined {
  return effort !== "off" &&
    [
      "deepseek-flash",
      "deepseek-v4.1-flash",
      "deepseek-v4.1-flash-anthropic",
    ].includes(model)
    ? 65_536
    : undefined;
}
/** The chosen model first, then every other listed model, without duplicates. */
function catalogIds(selected: string, listed: readonly string[] = []) {
  return [...new Set([selected, ...listed])];
}
/** Gateways do not publish modality; these families are text-only upstream. */
function imageCapable(id: string) {
  return !/^(deepseek-|minimax-|step-)/u.test(id);
}
export function luminaSettings(document: AiServiceDocument) {
  return (
    document.lumina ?? {
      mode: "lumina" as const,
      model: LUMINA_DEFAULT_MODEL,
      reasoningEffort: "high",
      models: [],
    }
  );
}
/** Always registered so a saved key works without rebuilding the DSH profile. */
export function luminaProfile(
  document: AiServiceDocument,
): PiAiProviderProfile {
  const settings = luminaSettings(document);
  return {
    displayName: "Lumina",
    api: "openai-completions",
    baseURL: LUMINA_BASE_URL,
    apiKeyEnv: LUMINA_CREDENTIAL,
    defaultContextWindow: 200_000,
    models: catalogIds(settings.model, settings.models).map((id) => ({
      id,
      ...(thinkingOutputBudget(id, settings.reasoningEffort)
        ? { maxTokens: thinkingOutputBudget(id, settings.reasoningEffort) }
        : {}),
      input: imageCapable(id) ? ["text", "image"] : ["text"],
      reasoningEfforts: reasoningLevels,
    })),
  };
}
export function customProfiles(
  document: AiServiceDocument,
): Record<string, PiAiProviderProfile> {
  return {
    ...Object.fromEntries(
      Object.entries(document.routes).map(
        ([id, { settings, credential, catalog }]) => {
          const custom = settings.custom!;
          return [
            id,
            {
              displayName: custom.name,
              api: custom.api,
              baseURL: custom.baseURL,
              apiKeyEnv: credential,
              models: catalogIds(settings.model, catalog).map((model) => ({
                id: model,
                ...(thinkingOutputBudget(model, settings.reasoningEffort)
                  ? {
                      maxTokens: thinkingOutputBudget(
                        model,
                        settings.reasoningEffort,
                      ),
                    }
                  : {}),
                contextWindow: custom.contextWindow,
                input: custom.images ? ["text", "image"] : ["text"],
                reasoningEfforts:
                  settings.reasoningEffort === "off" ? false : reasoningLevels,
              })),
            },
          ];
        },
      ),
    ),
    [LUMINA_PROVIDER]: luminaProfile(document),
  };
}
export function selectedAgentConfig(
  document: AiServiceDocument,
): FlowAgentConfig {
  return {
    provider:
      document.model.mode === "codex"
        ? "openai-codex"
        : document.model.mode === "lumina"
          ? LUMINA_PROVIDER
          : document.selectedRoute!,
    model: document.model.model,
    reasoningEffort: document.model.reasoningEffort,
    ...(document.model.mode !== "codex" &&
    thinkingOutputBudget(document.model.model, document.model.reasoningEffort)
      ? {
          maxTokens: thinkingOutputBudget(
            document.model.model,
            document.model.reasoningEffort,
          ),
        }
      : {}),
    timeoutMs: 180_000,
  };
}
/** Validate through DSH, including model capability metadata; never instantiate pi-ai. */
export async function validateCustomSettings(
  settings: AiModelSettings,
): Promise<void> {
  const id = "aura-custom-" + "0".repeat(32);
  const ctx = new Context();
  try {
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(PiAiAdapter, {
      providers: customProfiles({
        version: 1,
        model: settings,
        selectedRoute: id,
        routes: {
          [id]: { settings, credential: "AURA_CUSTOM_" + "0".repeat(32) },
        },
      }),
    });
    await ctx.llm.resolveCallConfig({
      provider: id,
      model: settings.model,
      ...(settings.reasoningEffort === "off"
        ? {}
        : { reasoningEffort: ReasoningEffortId(settings.reasoningEffort) }),
    });
  } catch (error) {
    throw new AiConfigurationError(
      "DSH 无法使用该模型配置，请检查协议、模型和思考强度。",
      { cause: error },
    );
  } finally {
    await ctx.fiber.dispose();
  }
}
/** Writes a new immutable provider revision; credentials never enter the configuration file. */
export async function saveModelSettings(
  root: string,
  credentials: CredentialProvider,
  source: unknown,
  codexModel?: string,
): Promise<AiServiceDocument> {
  const { key, clearKey, ...settings } = parseModelSettings(source);
  const previous = await readAiServices(root, codexModel);
  if (settings.mode === "codex") {
    const next = { ...previous, model: settings, codex: settings };
    await writeAiServices(root, next);
    return next;
  }
  if (settings.mode === "lumina") {
    const next = {
      ...previous,
      model: settings,
      lumina: { ...settings, models: previous.lumina?.models ?? [] },
    };
    const ref = credentialRef(LUMINA_CREDENTIAL);
    const old = key || clearKey ? await credentials.resolve(ref) : undefined;
    if (key) await credentials.set(ref, key);
    if (clearKey) await credentials.unset(ref);
    try {
      await writeAiServices(root, next);
    } catch (error) {
      if (old) await credentials.set(ref, old.value);
      else if (key) await credentials.unset(ref);
      throw error;
    }
    return next;
  }
  await validateCustomSettings(settings);
  const id = randomUUID().replace(/-/gu, "");
  const route = `aura-custom-${id}`;
  const ref = `AURA_CUSTOM_${id.toUpperCase()}`;
  const old = previous.selectedRoute
    ? previous.routes[previous.selectedRoute]
    : undefined;
  const sameEndpoint =
    old?.settings.custom?.baseURL === settings.custom?.baseURL &&
    old?.settings.custom?.api === settings.custom?.api;
  const inherited =
    old && sameEndpoint && !clearKey && !key
      ? await credentials.resolve(credentialRef(old.credential))
      : undefined;
  const value = key ?? inherited?.value;
  if (value) await credentials.set(credentialRef(ref), value);
  const next = {
    ...previous,
    codex:
      previous.codex ??
      (previous.model.mode === "codex" ? previous.model : undefined),
    model: settings,
    selectedRoute: route,
    routes: {
      ...previous.routes,
      [route]: {
        settings,
        credential: ref,
        ...(sameEndpoint && old?.catalog ? { catalog: old.catalog } : {}),
      },
    },
  };
  try {
    await writeAiServices(root, next);
  } catch (error) {
    if (value) await credentials.unset(credentialRef(ref));
    throw error;
  }
  if (clearKey)
    for (const entry of Object.values(previous.routes))
      await credentials.unset(credentialRef(entry.credential));
  return next;
}
/** Persist the chat models an endpoint listed; keys and endpoints stay unchanged. */
export async function saveDiscoveredCatalog(
  root: string,
  target: string,
  models: readonly string[],
  codexModel?: string,
): Promise<AiServiceDocument> {
  const previous = await readAiServices(root, codexModel);
  const list = modelList(models);
  if (target === "lumina") {
    const next = {
      ...previous,
      lumina: { ...luminaSettings(previous), models: list },
    };
    await writeAiServices(root, next);
    return next;
  }
  const route = previous.routes[target];
  if (!route) throw new AiConfigurationError("自定义服务尚未保存。");
  const next = {
    ...previous,
    routes: { ...previous.routes, [target]: { ...route, catalog: list } },
  };
  await writeAiServices(root, next);
  return next;
}
