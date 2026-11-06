/// <reference types="vite/client" />
import { registerCatalogs, type MessageReference } from "@aura/i18n/runtime";
import {
  readModelServiceCheck,
  type ModelServiceCheck,
  type ModelProbeFailureCode,
} from "@aura/protocol/model-checks";
import zh from "./locales/zh-CN/modelServices.json" with { type: "json" };
import en from "./locales/en/modelServices.json" with { type: "json" };
import ja from "./locales/ja/modelServices.json" with { type: "json" };
import ko from "./locales/ko/modelServices.json" with { type: "json" };
import ru from "./locales/ru/modelServices.json" with { type: "json" };
import fr from "./locales/fr/modelServices.json" with { type: "json" };

const dispose = registerCatalogs("modelServices", {
  "zh-CN": zh,
  en,
  ja,
  ko,
  ru,
  fr,
});
if (import.meta.hot) import.meta.hot.dispose(dispose);

export function modelServiceMessage(
  key:
    ModelServiceCheck["code"] | ModelProbeFailureCode | "settingsUnavailable",
  values?: MessageReference["values"],
): MessageReference {
  return { namespace: "modelServices", key, ...(values ? { values } : {}) };
}

export interface ModelServiceFeedback {
  tone: "ok" | "error" | "info";
  text: string | MessageReference;
}

/** Keep the validated semantic result in UI state so changing language never repeats a check. */
export function modelServiceFeedback(
  value: unknown,
  legacy: string,
): ModelServiceFeedback {
  const detail = readModelServiceCheck(value);
  if (!detail)
    return {
      // Older runtimes only return this human-readable status. Preserve their behavior.
      tone: legacy.startsWith("连接成功")
        ? "ok"
        : legacy === "未检查"
          ? "info"
          : "error",
      text: legacy,
    };
  if (detail.code === "probe_succeeded")
    return {
      tone: "ok",
      text: modelServiceMessage(detail.code, {
        model: detail.model,
        elapsedMs: detail.elapsedMs,
        reply: detail.reply,
      }),
    };
  if (detail.code === "probe_failed")
    return {
      tone: "error",
      text: modelServiceMessage(detail.code, {
        model: detail.model,
        reason: modelServiceMessage(detail.reason),
      }),
    };
  if (detail.code === "models_synced" || detail.code === "models_listed")
    return {
      tone: detail.code === "models_synced" ? "ok" : "info",
      text: modelServiceMessage(detail.code, { count: detail.count }),
    };
  return {
    tone: detail.code === "unchecked" ? "info" : "error",
    text: modelServiceMessage(detail.code),
  };
}
