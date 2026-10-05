import type { AiCustomProvider, AiModelSettings } from "@aura/protocol/types";

/** Redacted backend view of `/ai/services`; keys never appear here. */
export interface ModelServicesState {
  model: AiModelSettings & { hasKey: boolean; configured: boolean };
  customModel?: AiModelSettings & { hasKey: boolean };
  lumina: {
    model: string;
    reasoningEffort: string;
    baseURL: string;
    hasKey: boolean;
    readOnly: boolean;
    modelCount: number;
  };
  checks: { model: string; lumina: string };
}

export type CustomServiceDraft = {
  model: string;
  reasoningEffort: string;
  custom: AiCustomProvider;
  key?: string;
};

async function request(
  endpoint: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<ModelServicesState> {
  const response = await fetch(
    `${endpoint.replace(/\/$/u, "")}/ai/services${path}`,
    body === undefined
      ? { signal }
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal,
        },
  );
  const result = (await response.json().catch(() => null)) as
    | ModelServicesState
    | { message?: string }
    | null;
  if (!response.ok)
    throw new Error(
      (result && "message" in result && result.message) ||
        `模型服务设置不可用（${response.status}）。`,
    );
  return result as ModelServicesState;
}

// Hono routes the mount point without a trailing slash.
export const readModelServices = (endpoint: string, signal?: AbortSignal) =>
  request(endpoint, "", undefined, signal);

export const saveLumina = (
  endpoint: string,
  update: { model?: string; reasoningEffort?: string; key?: string; clearKey?: boolean },
  current: ModelServicesState["lumina"],
) =>
  request(endpoint, "/lumina", {
    model: update.model ?? current.model,
    reasoningEffort: update.reasoningEffort ?? current.reasoningEffort,
    ...(update.key ? { key: update.key } : {}),
    ...(update.clearKey ? { clearKey: true } : {}),
  });

export const checkLumina = (endpoint: string) =>
  request(endpoint, "/check/lumina", {});

export const saveCustomService = (endpoint: string, draft: CustomServiceDraft) =>
  request(endpoint, "/model", {
    mode: "custom",
    model: draft.model,
    reasoningEffort: draft.reasoningEffort,
    custom: draft.custom,
    ...(draft.key ? { key: draft.key } : {}),
  });

export const checkCustomService = (endpoint: string) =>
  request(endpoint, "/check/model", {});
